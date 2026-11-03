//! A fake app that speaks MCP over real HTTP, with a registry and client pointed at it.
use agent::{
    apps::{AddApp, App, AppOverrides, McpOverride, Registry, RegistryCommand},
    mcp::{HttpMcpClient, ToolRequest, ToolTarget},
};
use rmcp::{
    RoleServer, ServerHandler,
    model::*,
    service::RequestContext,
    transport::streamable_http_server::{
        StreamableHttpService, session::local::LocalSessionManager,
    },
};
use serde_json::json;
use std::future::Future;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::time::{Duration, Instant};

#[derive(Clone, Default)]
pub struct Fixture {
    pub fail: Arc<AtomicBool>,
    pub repeat: Arc<AtomicBool>,
    pub discovery: Arc<AtomicBool>,
    pub release: Arc<tokio::sync::Notify>,
    pub calls: Arc<AtomicUsize>,
    pub sessions_opened: Arc<AtomicUsize>,
    pub cancelled: Arc<AtomicBool>,
    pub peer: Arc<Mutex<Option<rmcp::Peer<RoleServer>>>>,
}
impl ServerHandler for Fixture {
    fn get_info(&self) -> ServerConfig {
        let mut info = ServerConfig::default();
        info.capabilities = ServerCapabilities::builder()
            .enable_tools()
            .enable_tool_list_changed()
            .build();
        info.instructions = Some("Fixture instructions".into());
        info
    }
    async fn list_tools(
        &self,
        params: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, rmcp::ErrorData> {
        *self.peer.lock().unwrap() = Some(context.peer);
        if self.fail.load(Ordering::SeqCst) {
            return Err(rmcp::ErrorData::internal_error(
                "catalogue unavailable",
                None,
            ));
        }
        let second = params.is_some_and(|params| params.cursor.is_some());
        Ok(ListToolsResult { tools: vec![serde_json::from_value(json!({"name":if second {"other"} else {"echo"}, "description":"Echo words", "inputSchema":{"type":"object","required":["words"],"properties":{"words":{"type":"string"}},"additionalProperties":false}, "outputSchema":{"type":"object"}, "annotations":{"readOnlyHint":true}, "_meta": if self.discovery.load(Ordering::SeqCst) { json!({"fixture":true,"jet/discovery":{"version":1}}) } else { json!({"fixture":true}) }})).unwrap()], next_cursor:if !second || self.repeat.load(Ordering::SeqCst) { Some("page2".into()) } else { None }, ..Default::default() })
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
        if words == "hold-uncertain" {
            self.release.notified().await;
        }
        if words == "wait" {
            tokio::select! {
                _ = context.ct.cancelled() => { self.cancelled.store(true, Ordering::SeqCst); return Ok(CallToolResult::error(vec![ContentBlock::text("cancelled")]).into()); }
                _ = tokio::time::sleep(std::time::Duration::from_millis(150)) => {}
            }
        }
        if words == "protocol-error" {
            return Err(rmcp::ErrorData::invalid_params(
                "bad fixture request",
                Some(json!({"detail":42})),
            ));
        }
        if words == "tool-error" {
            return Ok(CallToolResult::error(vec![ContentBlock::text("tool failed")]).into());
        }
        Ok(CallToolResult::structured(json!({"words":words})).into())
    }
}
pub struct World {
    pub fixture: Fixture,
    pub sessions: Arc<LocalSessionManager>,
    pub registry: Arc<Mutex<Registry>>,
    pub client: Arc<HttpMcpClient>,
    pub app: App,
    task: tokio::task::JoinHandle<()>,
    _dir: tempfile::TempDir,
}
impl World {
    pub async fn new() -> Self {
        let fixture = Fixture::default();
        let server = fixture.clone();
        let sessions = Arc::new(LocalSessionManager::default());
        let service = StreamableHttpService::new(
            move || {
                server.sessions_opened.fetch_add(1, Ordering::SeqCst);
                Ok(server.clone())
            },
            sessions.clone(),
            Default::default(),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                axum::Router::new()
                    .nest_service("/mcp", service)
                    .layer(axum::middleware::from_fn(lose_reply)),
            )
            .await
            .unwrap()
        });
        let dir = tempfile::tempdir().unwrap();
        let registry = Arc::new(Mutex::new(Registry::open(dir.path()).unwrap()));
        let reg = registry.clone();
        let app = tokio::task::spawn_blocking(move || {
            reg.lock()
                .unwrap()
                .execute(RegistryCommand::Add(AddApp {
                    address,
                    overrides: AppOverrides {
                        mcp: McpOverride::Url("mcp".into()),
                        ..Default::default()
                    },
                }))
                .unwrap()
                .app
                .unwrap()
        })
        .await
        .unwrap();
        let client = Arc::new(HttpMcpClient::new(registry.clone()));
        Self {
            fixture,
            sessions,
            registry,
            client,
            app,
            task,
            _dir: dir,
        }
    }
    pub async fn register(&self, address: String) -> App {
        let registry = self.registry.clone();
        tokio::task::spawn_blocking(move || {
            registry
                .lock()
                .unwrap()
                .execute(RegistryCommand::Add(AddApp {
                    address,
                    overrides: AppOverrides {
                        mcp: McpOverride::Url("mcp".into()),
                        ..Default::default()
                    },
                }))
                .unwrap()
                .app
                .unwrap()
        })
        .await
        .unwrap()
    }
    pub fn request(&self, id: &str, words: &str) -> ToolRequest {
        ToolRequest {
            request_id: id.into(),
            target: ToolTarget {
                app_id: self.app.id.clone(),
                tool: "echo".into(),
            },
            arguments: json!({"words":words}).as_object().unwrap().clone(),
        }
    }
}
impl Drop for World {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn lose_reply(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let (parts, body) = request.into_parts();
    let body = axum::body::to_bytes(body, 2 * 1024 * 1024).await.unwrap();
    let uncertain = String::from_utf8_lossy(&body).contains("uncertain");
    let response = next
        .run(axum::extract::Request::from_parts(
            parts,
            axum::body::Body::from(body),
        ))
        .await;
    if uncertain {
        let _ = axum::body::to_bytes(response.into_body(), 2 * 1024 * 1024)
            .await
            .unwrap();
        axum::http::StatusCode::BAD_GATEWAY.into_response()
    } else {
        response
    }
}
/// Waits for something another task does, and fails with a message rather than hanging.
pub async fn eventually(what: &str, ready: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// Waits for a call that runs in its own task.
pub async fn within_seconds<T>(what: &str, future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), future)
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
}

pub fn calls(fixture: &Fixture) -> usize {
    fixture.calls.load(Ordering::SeqCst)
}
