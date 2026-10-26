//! Exercise shared metadata and calls against real SDK HTTP sessions.
use agent::{
    apps::{AddApp, App, AppOverrides, McpOverride, Registry, RegistryCommand},
    mcp::{HttpMcpClient, McpError, ToolRequest, ToolTarget},
};
use rmcp::{
    RoleServer, ServerHandler,
    model::*,
    service::RequestContext,
    transport::streamable_http_server::{
        StreamableHttpService,
        session::{SessionManager, local::LocalSessionManager},
    },
};
use serde_json::json;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

#[derive(Clone, Default)]
struct Fixture {
    fail: Arc<AtomicBool>,
    repeat: Arc<AtomicBool>,
    discovery: Arc<AtomicBool>,
    release: Arc<tokio::sync::Notify>,
    calls: Arc<AtomicUsize>,
    cancelled: Arc<AtomicBool>,
    peer: Arc<Mutex<Option<rmcp::Peer<RoleServer>>>>,
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
struct World {
    fixture: Fixture,
    sessions: Arc<LocalSessionManager>,
    registry: Arc<Mutex<Registry>>,
    client: Arc<HttpMcpClient>,
    app: App,
    task: tokio::task::JoinHandle<()>,
    _dir: tempfile::TempDir,
}
impl World {
    async fn new() -> Self {
        let fixture = Fixture::default();
        let server = fixture.clone();
        let sessions = Arc::new(LocalSessionManager::default());
        let service = StreamableHttpService::new(
            move || Ok(server.clone()),
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
    async fn register(&self, address: String) -> App {
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
    fn request(&self, id: &str, words: &str) -> ToolRequest {
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
#[tokio::test]
async fn calls_validate_route_and_cancel_without_replay() {
    let world = World::new().await;
    // The catalogue holds what the app announced, goes stale when it cannot be listed, and recovers.
    let catalogue = world.client.catalogue(&world.app.id).await.unwrap();
    assert_eq!(
        catalogue.server.instructions.as_deref(),
        Some("Fixture instructions")
    );
    assert!(!catalogue.server.protocol_version.is_empty());
    assert_eq!(catalogue.tools.len(), 2, "both pages are read");
    assert_eq!(catalogue.tools[0].meta["fixture"], true);
    assert!(catalogue.tools[0].output_schema.is_some());
    assert!(catalogue.tools[0].annotations.is_some());
    assert!(!catalogue.is_stale);
    world.fixture.fail.store(true, Ordering::SeqCst);
    let peer = world.fixture.peer.lock().unwrap().clone().unwrap();
    peer.notify_tool_list_changed().await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    let stale = world.client.catalogue(&world.app.id).await.unwrap();
    assert!(stale.is_stale);
    assert_eq!(stale.tools, catalogue.tools);
    assert!(stale.last_error.unwrap().contains("catalogue unavailable"));
    world.fixture.fail.store(false, Ordering::SeqCst);
    assert!(!world.client.refresh(&world.app.id).await.unwrap().is_stale);
    let sessions: Vec<_> = world
        .sessions
        .sessions
        .read()
        .await
        .keys()
        .cloned()
        .collect();
    for id in sessions {
        world.sessions.close_session(&id).await.unwrap();
    }
    let _ = world.client.refresh(&world.app.id).await.unwrap();
    assert!(!world.client.refresh(&world.app.id).await.unwrap().is_stale);
    world.fixture.repeat.store(true, Ordering::SeqCst);
    let stale = world.client.refresh(&world.app.id).await.unwrap();
    assert!(stale.is_stale);
    assert!(stale.last_error.unwrap().contains("repeated"));
    world.fixture.repeat.store(false, Ordering::SeqCst);
    assert!(!world.client.refresh(&world.app.id).await.unwrap().is_stale);
    assert_eq!(world.fixture.calls.load(Ordering::SeqCst), 0);

    let mut invalid = world.request("invalid", "");
    invalid.arguments.clear();
    assert!(matches!(
        world.client.call(invalid).await,
        Err(McpError::InvalidArguments { .. })
    ));
    assert_eq!(world.fixture.calls.load(Ordering::SeqCst), 0);
    let result = world
        .client
        .call(world.request("good", "hello"))
        .await
        .unwrap();
    assert_eq!(result.request_id, "good");
    assert_eq!(result.structured_content, Some(json!({"words":"hello"})));
    assert!(!result.is_error);
    assert!(
        world
            .client
            .call(world.request("bad", "tool-error"))
            .await
            .unwrap()
            .is_error
    );
    assert!(
        matches!(world.client.call(world.request("protocol", "protocol-error")).await, Err(McpError::Protocol { code:-32602, data:Some(data), .. }) if data["detail"] == 42)
    );
    let client = world.client.clone();
    let request = world.request("cancel", "wait");
    let task = tokio::spawn(async move { client.call(request).await });
    while world.fixture.calls.load(Ordering::SeqCst) < 4 {
        tokio::task::yield_now().await;
    }
    world.client.cancel_request("cancel");
    assert!(matches!(
        task.await.unwrap(),
        Err(McpError::Cancelled { .. })
    ));
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    assert!(world.fixture.cancelled.load(Ordering::SeqCst));
    let client = world.client.clone();
    let request = world.request("settle", "wait");
    let task = tokio::spawn(async move { client.call(request).await });
    while world.fixture.calls.load(Ordering::SeqCst) < 5 {
        tokio::task::yield_now().await;
    }
    world
        .registry
        .lock()
        .unwrap()
        .execute(RegistryCommand::Disable {
            id: world.app.id.clone(),
        })
        .unwrap();
    assert!(matches!(
        world.client.call(world.request("disabled", "hello")).await,
        Err(McpError::Unavailable { .. })
    ));
    assert!(task.await.unwrap().is_ok());
    world
        .registry
        .lock()
        .unwrap()
        .execute(RegistryCommand::Remove {
            id: world.app.id.clone(),
        })
        .unwrap();
    assert!(matches!(
        world.client.call(world.request("removed", "hello")).await,
        Err(McpError::Unavailable { .. })
    ));
    assert_eq!(world.fixture.calls.load(Ordering::SeqCst), 5);
    let routing = World::new().await;
    let other = World::new().await;
    let second = routing.register(other.app.base_url.as_str().into()).await;
    routing
        .client
        .call(routing.request("first-route", "one"))
        .await
        .unwrap();
    let mut request = routing.request("second-route", "two");
    request.target.app_id = second.id;
    routing.client.call(request).await.unwrap();
    assert_eq!(routing.fixture.calls.load(Ordering::SeqCst), 1);
    assert_eq!(other.fixture.calls.load(Ordering::SeqCst), 1);
    let client = routing.client.clone();
    let request = routing.request("uncertain-old-endpoint", "hold-uncertain");
    let old = tokio::spawn(async move { client.call(request).await });
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while routing.fixture.calls.load(Ordering::SeqCst) < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let registry = routing.registry.clone();
    let id = routing.app.id.clone();
    let endpoint = other.app.mcp_url.as_ref().unwrap().to_string();
    tokio::task::spawn_blocking(move || {
        registry
            .lock()
            .unwrap()
            .execute(RegistryCommand::Edit {
                id,
                address: None,
                overrides: Some(AppOverrides {
                    mcp: McpOverride::Url(endpoint),
                    ..Default::default()
                }),
            })
            .unwrap()
    })
    .await
    .unwrap();
    routing
        .client
        .call(routing.request("edited-route", "three"))
        .await
        .unwrap();
    assert_eq!(routing.fixture.calls.load(Ordering::SeqCst), 2);
    assert_eq!(other.fixture.calls.load(Ordering::SeqCst), 2);
    let sessions: std::collections::HashSet<_> = other
        .sessions
        .sessions
        .read()
        .await
        .keys()
        .cloned()
        .collect();
    routing.fixture.release.notify_one();
    assert!(matches!(
        old.await.unwrap(),
        Err(McpError::Transport { .. })
    ));
    routing.client.catalogue(&routing.app.id).await.unwrap();
    assert_eq!(
        other
            .sessions
            .sessions
            .read()
            .await
            .keys()
            .cloned()
            .collect::<std::collections::HashSet<_>>(),
        sessions,
        "old endpoint failure must not discard the current session"
    );
    assert!(matches!(
        routing
            .client
            .call(routing.request("uncertain-write", "uncertain"))
            .await,
        Err(McpError::Transport { .. })
    ));
    assert_eq!(
        other.fixture.calls.load(Ordering::SeqCst),
        3,
        "an uncertain write is never replayed"
    );
    assert!(
        !routing
            .client
            .refresh(&routing.app.id)
            .await
            .unwrap()
            .is_stale
    );
    let call = routing
        .client
        .call(routing.request("cancel-before-poll", "never"));
    routing.client.cancel_request("cancel-before-poll");
    assert!(matches!(
        routing
            .client
            .call(routing.request("cancel-before-poll", "duplicate"))
            .await,
        Err(McpError::InvalidArguments { .. })
    ));
    assert!(matches!(call.await, Err(McpError::Cancelled { .. })));
    assert_eq!(other.fixture.calls.load(Ordering::SeqCst), 3);
    other.fixture.discovery.store(true, Ordering::SeqCst);
    routing.client.refresh(&routing.app.id).await.unwrap();
    routing
        .client
        .discover(routing.request("discovery", "free"))
        .await
        .unwrap();
    let discovery = routing
        .client
        .discover(routing.request("changed-discovery", "never"));
    other.fixture.discovery.store(false, Ordering::SeqCst);
    routing.client.refresh(&routing.app.id).await.unwrap();
    assert!(matches!(
        discovery.await,
        Err(McpError::InvalidArguments { .. })
    ));
    assert_eq!(
        other.fixture.calls.load(Ordering::SeqCst),
        4,
        "a removed discovery promise prevents execution"
    );
}
