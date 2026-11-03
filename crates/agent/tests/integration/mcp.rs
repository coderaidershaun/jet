//! Calls and catalogues between the MCP client and an app, over real HTTP sessions.
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
use std::future::Future;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::time::{Duration, Instant};

#[derive(Clone, Default)]
struct Fixture {
    fail: Arc<AtomicBool>,
    repeat: Arc<AtomicBool>,
    discovery: Arc<AtomicBool>,
    release: Arc<tokio::sync::Notify>,
    calls: Arc<AtomicUsize>,
    sessions_opened: Arc<AtomicUsize>,
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
/// Waits for something another task does, and fails with a message rather than hanging.
async fn eventually(what: &str, ready: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// Waits for a call that runs in its own task.
async fn within_seconds<T>(what: &str, future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), future)
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
}

fn calls(fixture: &Fixture) -> usize {
    fixture.calls.load(Ordering::SeqCst)
}

#[tokio::test]
async fn the_catalogue_goes_stale_when_listing_fails_and_recovers() {
    let world = World::new().await;
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
    let stale = within_seconds("the stale catalogue", async {
        loop {
            let latest = world.client.catalogue(&world.app.id).await.unwrap();
            if latest.is_stale {
                break latest;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert_eq!(stale.tools, catalogue.tools);
    assert!(stale.last_error.unwrap().contains("catalogue unavailable"));
    world.fixture.fail.store(false, Ordering::SeqCst);
    assert!(!world.client.refresh(&world.app.id).await.unwrap().is_stale);

    // A session the app lost is replaced by a new one.
    let ids: Vec<_> = world
        .sessions
        .sessions
        .read()
        .await
        .keys()
        .cloned()
        .collect();
    for id in ids {
        world.sessions.close_session(&id).await.unwrap();
    }
    let opened = world.fixture.sessions_opened.load(Ordering::SeqCst);
    // The call that finds the session gone may fail; the next one works on a new session.
    let _ = world.client.refresh(&world.app.id).await.unwrap();
    assert!(!world.client.refresh(&world.app.id).await.unwrap().is_stale);
    assert!(world.fixture.sessions_opened.load(Ordering::SeqCst) > opened);

    world.fixture.repeat.store(true, Ordering::SeqCst);
    let stale = world.client.refresh(&world.app.id).await.unwrap();
    assert!(stale.is_stale);
    assert!(stale.last_error.unwrap().contains("repeated"));
    world.fixture.repeat.store(false, Ordering::SeqCst);
    assert!(!world.client.refresh(&world.app.id).await.unwrap().is_stale);
    assert_eq!(calls(&world.fixture), 0);
}

#[tokio::test]
async fn calls_are_checked_and_the_apps_errors_come_back_as_they_are() {
    let world = World::new().await;
    let mut invalid = world.request("invalid", "");
    invalid.arguments.clear();
    assert!(matches!(
        world.client.call(invalid).await,
        Err(McpError::InvalidArguments { .. })
    ));
    assert_eq!(
        calls(&world.fixture),
        0,
        "invalid arguments never reach the app"
    );
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
}

#[tokio::test]
async fn cancelling_a_call_tells_the_app_to_stop() {
    let world = World::new().await;
    let client = world.client.clone();
    let request = world.request("cancel", "wait");
    let task = tokio::spawn(async move { client.call(request).await });
    eventually("the call to reach the app", || calls(&world.fixture) == 1).await;
    world.client.cancel_request("cancel");
    assert!(matches!(
        within_seconds("the cancelled call", task).await.unwrap(),
        Err(McpError::Cancelled { .. })
    ));
    eventually("the app to see the cancel", || {
        world.fixture.cancelled.load(Ordering::SeqCst)
    })
    .await;
}

#[tokio::test]
async fn a_cancel_before_the_call_starts_wins_and_an_id_is_used_once() {
    let world = World::new().await;
    let call = world
        .client
        .call(world.request("cancel-before-poll", "never"));
    world.client.cancel_request("cancel-before-poll");
    assert!(matches!(
        world
            .client
            .call(world.request("cancel-before-poll", "duplicate"))
            .await,
        Err(McpError::InvalidArguments { .. })
    ));
    assert!(matches!(call.await, Err(McpError::Cancelled { .. })));
    assert_eq!(calls(&world.fixture), 0);
}

#[tokio::test]
async fn a_disabled_app_lets_a_running_call_settle_and_refuses_new_ones() {
    let world = World::new().await;
    let client = world.client.clone();
    let request = world.request("settle", "wait");
    let task = tokio::spawn(async move { client.call(request).await });
    eventually("the call to reach the app", || calls(&world.fixture) == 1).await;
    let id = world.app.id.clone();
    world
        .registry
        .lock()
        .unwrap()
        .execute(RegistryCommand::Disable { id: id.clone() })
        .unwrap();
    assert!(matches!(
        world.client.call(world.request("disabled", "hello")).await,
        Err(McpError::Unavailable { .. })
    ));
    assert!(
        within_seconds("the running call", task)
            .await
            .unwrap()
            .is_ok()
    );
    world
        .registry
        .lock()
        .unwrap()
        .execute(RegistryCommand::Remove { id })
        .unwrap();
    assert!(matches!(
        world.client.call(world.request("removed", "hello")).await,
        Err(McpError::Unavailable { .. })
    ));
    assert_eq!(calls(&world.fixture), 1);
}

#[tokio::test]
async fn a_call_goes_to_the_app_it_names() {
    let first = World::new().await;
    let other = World::new().await;
    let second = first.register(other.app.base_url.as_str().into()).await;
    first
        .client
        .call(first.request("first-route", "one"))
        .await
        .unwrap();
    let mut request = first.request("second-route", "two");
    request.target.app_id = second.id;
    first.client.call(request).await.unwrap();
    assert_eq!(calls(&first.fixture), 1);
    assert_eq!(calls(&other.fixture), 1);
}

#[tokio::test]
async fn a_failed_call_to_an_old_endpoint_leaves_the_new_endpoints_session_alone() {
    let routing = World::new().await;
    let other = World::new().await;
    let client = routing.client.clone();
    let request = routing.request("uncertain-old-endpoint", "hold-uncertain");
    let old = tokio::spawn(async move { client.call(request).await });
    eventually("the call to reach the old endpoint", || {
        calls(&routing.fixture) == 1
    })
    .await;
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
    assert_eq!(
        calls(&routing.fixture),
        1,
        "the edited app goes to the new endpoint"
    );
    assert_eq!(calls(&other.fixture), 1);
    let opened = other.fixture.sessions_opened.load(Ordering::SeqCst);
    routing.fixture.release.notify_one();
    assert!(matches!(
        within_seconds("the old call", old).await.unwrap(),
        Err(McpError::Transport { .. })
    ));
    routing.client.catalogue(&routing.app.id).await.unwrap();
    assert_eq!(
        other.fixture.sessions_opened.load(Ordering::SeqCst),
        opened,
        "the old endpoint's failure must not discard the current session"
    );
}

#[tokio::test]
async fn an_uncertain_write_is_never_replayed() {
    let world = World::new().await;
    assert!(matches!(
        world
            .client
            .call(world.request("uncertain-write", "uncertain"))
            .await,
        Err(McpError::Transport { .. })
    ));
    assert_eq!(calls(&world.fixture), 1);
    assert!(!world.client.refresh(&world.app.id).await.unwrap().is_stale);
}

#[tokio::test]
async fn a_removed_discovery_promise_prevents_execution() {
    let world = World::new().await;
    world.fixture.discovery.store(true, Ordering::SeqCst);
    world.client.refresh(&world.app.id).await.unwrap();
    world
        .client
        .discover(world.request("discovery", "free"))
        .await
        .unwrap();
    let discovery = world
        .client
        .discover(world.request("changed-discovery", "never"));
    world.fixture.discovery.store(false, Ordering::SeqCst);
    world.client.refresh(&world.app.id).await.unwrap();
    assert!(matches!(
        discovery.await,
        Err(McpError::InvalidArguments { .. })
    ));
    assert_eq!(calls(&world.fixture), 1);
}
