use super::support::Host;
use serde_json::json;

#[test]
fn browser_commands_preserve_settings_memory_and_markdown() {
    let host = Host::start();
    let mut settings = host.get("/api/settings");
    settings["persona"]["name"] = "Ada".into();
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into();
    let response = agent
        .put(format!("{}/api/settings", host.url))
        .header("content-type", "application/json")
        .send(settings.to_string())
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(host.get("/api/settings")["persona"]["name"], "Ada");
    let notes = json!({"memory":"Remember","user":"User note","recent":"Recent note"});
    let response = agent
        .put(format!("{}/api/memory", host.url))
        .header("content-type", "application/json")
        .send(notes.to_string())
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(host.get("/api/memory")["memory"], "Remember");
    assert!(
        host.post(
            "/api/markdown",
            json!({"text":"**bold** <script>unsafe</script>"})
        )
        .1
        .as_str()
        .unwrap()
        .contains("<strong>bold</strong>")
    );
    assert!(
        host.get("/api/status")["claude"]["found"]
            .as_bool()
            .unwrap()
    );
    assert_eq!(
        host.post("/api/feel", json!({"text":"hello"})).1["mood"],
        "neutral"
    );
    let html = ureq::get(&host.url)
        .call()
        .unwrap()
        .body_mut()
        .read_to_string()
        .unwrap();
    assert!(html.contains("chat/main.js"));
    let bridge = ureq::get(format!("{}/bridge/agent.js", host.url))
        .call()
        .unwrap()
        .body_mut()
        .read_to_string()
        .unwrap();
    assert!(bridge.contains("createBrowserAgent()"));
    assert_eq!(host.post("/api/chat/forget", json!({})).0, 200);
    assert_eq!(host.get("/api/memory")["memory"], "Remember");
    assert!(jet::ServerConfig::from_args(["--public-origin", "file:///tmp"]).is_err());
    assert!(jet::ServerConfig::from_args(["--listen", "invalid"]).is_err());
    let host = host.restart();
    assert_eq!(host.get("/api/settings")["persona"]["name"], "Ada");
    assert_eq!(host.get("/api/memory")["memory"], "Remember");
}
