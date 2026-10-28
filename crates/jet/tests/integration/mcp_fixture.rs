//! Run an independent free app with a real SDK MCP endpoint.
use rmcp::{
    RoleServer, ServerHandler,
    model::*,
    service::RequestContext,
    transport::streamable_http_server::{
        StreamableHttpService, session::local::LocalSessionManager,
    },
};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
#[derive(Clone, Default)]
pub struct App {
    discovered: Arc<AtomicBool>,
    pub calls: Arc<AtomicUsize>,
    /// Whether the last `progress` call carried a progress token.
    pub had_progress_token: Arc<AtomicBool>,
    pub hold_list: Arc<AtomicBool>,
    pub listing: Arc<AtomicBool>,
    pub cancelled: Arc<AtomicBool>,
}
impl ServerHandler for App {
    fn get_info(&self) -> ServerConfig {
        let mut info = ServerConfig::default();
        info.instructions = Some("Free fixture instructions".into());
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, rmcp::ErrorData> {
        self.listing.store(true, Ordering::SeqCst);
        while self.hold_list.load(Ordering::SeqCst) {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let tool = |name, marker: serde_json::Value| {
            serde_json::from_value(json!({"name":name,"description":"Fixture capability","inputSchema":{"type":"object","properties":{"words":{"type":"string"}},"required":["words"],"additionalProperties":false},"_meta":marker})).unwrap()
        };
        let mut tools = vec![
            tool("echo", json!({})),
            tool(
                "root",
                json!({"jet/discovery":{"version":1,"entryArguments":{"words":"root"}}}),
            ),
        ];
        if self.discovered.load(Ordering::SeqCst) {
            tools.push(tool("branch", json!({"jet/discovery":{"version":1}})));
        }
        let job = json!({"jet/job":{"version":1,"statusTool":"job_status","idField":"job_id"}});
        let other = |name,
                     annotations: serde_json::Value,
                     schema: serde_json::Value,
                     marker: serde_json::Value| {
            serde_json::from_value(json!({"name":name,"description":"Fixture capability","inputSchema":schema,"annotations":annotations,"_meta":marker})).unwrap()
        };
        let no_arguments = json!({"type":"object","additionalProperties":false});
        tools.extend([
            other("progress", json!({}), no_arguments.clone(), json!({})),
            other("job_status", json!({"readOnlyHint":true}), no_arguments.clone(), job.clone()),
            other("job_write", json!({"readOnlyHint":false}), no_arguments, job),
            other(
                "fetch",
                json!({}),
                json!({"type":"object","properties":{"source":{"type":"object","properties":{"pdf_url":{"type":"string","pattern":"^https?://"}},"required":["pdf_url"]}},"required":["source"]}),
                json!({}),
            ),
        ]);
        Ok(ListToolsResult {
            tools,
            ..Default::default()
        })
    }
    async fn call_tool(
        &self,
        params: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, rmcp::ErrorData> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match params.name.as_ref() {
            "progress" => return self.report_progress(&context).await,
            "job_status" | "job_write" => {
                return Ok(CallToolResult::structured(json!({"job_id":"job-1","kind":"ingest","state":"running","stage":{"name":"converting","words":"converting 12 of 32 pages","done":12,"total":32,"share":0.375}})).into());
            }
            "fetch" => return Ok(CallToolResult::structured(json!(params.arguments)).into()),
            _ => {}
        }
        let words = params.arguments.unwrap()["words"]
            .as_str()
            .unwrap()
            .to_owned();
        if words == "wait" {
            context.ct.cancelled().await;
            self.cancelled.store(true, Ordering::SeqCst);
        }
        if params.name == "root" {
            self.discovered.store(true, Ordering::SeqCst);
        }
        let value = match params.name.as_ref() {
            "root" => {
                json!({"version":1,"nodes":[{"label":"Branch","kind":"discover","tool":"branch","arguments":{"words":"branch"}}]})
            }
            "branch" => {
                json!({"version":1,"nodes":[{"label":"Echo","kind":"tool","tool":"echo","arguments":{"words":"leaf"}}]})
            }
            _ => json!({"words":words,"source":"real fixture"}),
        };
        Ok(CallToolResult::structured(value).into())
    }
}
impl App {
    /// Sends ten steps of progress, a tenth of a second apart, on the token of the request.
    async fn report_progress(
        &self,
        context: &RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, rmcp::ErrorData> {
        let token = context.meta.get_progress_token();
        self.had_progress_token
            .store(token.is_some(), Ordering::SeqCst);
        if let Some(token) = token {
            for step in 1..=10 {
                let update = ProgressNotificationParam::new(token.clone(), f64::from(step * 10))
                    .with_total(100.0)
                    .with_message(format!("step {step}"));
                context.peer.notify_progress(update).await.ok();
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
        Ok(CallToolResult::structured(json!({"finished":true})).into())
    }
}
pub struct Fixture {
    pub url: String,
    pub app: App,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Fixture {
    pub fn start() -> Self {
        let (address, receive) = std::sync::mpsc::channel();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let app = App::default();
        let server = app.clone();
        let thread = std::thread::spawn(move || {
            tokio::runtime::Runtime::new().unwrap().block_on(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            address.send(format!("http://{}/",listener.local_addr().unwrap())).unwrap();
            let service = StreamableHttpService::new(move || Ok(App { discovered:Default::default(), ..server.clone() }), Arc::new(LocalSessionManager::default()), Default::default());
            let router = axum::Router::new().nest_service("/mcp",service).route("/jet-app.json",axum::routing::get(|| async { axum::Json(json!({"version":1,"name":"Fixture","ui":"./","mcp":"mcp","embedding":"relative-paths"})) }));
            tokio::select! { _ = axum::serve(listener,router) => {}, _ = stopped => {} }
        })
        });
        Self {
            url: receive.recv().unwrap(),
            app,
            stop: Some(stop),
            thread: Some(thread),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.stop.take().unwrap().send(());
        self.thread.take().unwrap().join().unwrap();
    }
}
