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
            let service = StreamableHttpService::new(move || Ok(App { calls:server.calls.clone(), hold_list:server.hold_list.clone(), listing:server.listing.clone(), cancelled:server.cancelled.clone(), discovered:Default::default() }), Arc::new(LocalSessionManager::default()), Default::default());
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
