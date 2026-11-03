//! Calls and catalogues between the MCP client and an app, over real HTTP sessions.
use super::mcp_fixture::{World, calls, eventually, within_seconds};
use agent::{
    apps::{AppOverrides, McpOverride, RegistryCommand},
    mcp::McpError,
};
use rmcp::transport::streamable_http_server::session::SessionManager;
use serde_json::json;
use std::sync::atomic::Ordering;
use std::time::Duration;

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
