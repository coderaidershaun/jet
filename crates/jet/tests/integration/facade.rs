//! Prove real provider processes use the global facade and turn-bound browser actions.
use super::{
    mcp_fixture::Fixture,
    support::{Host, request},
};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
fn host() -> Host {
    let host = Host::start();
    let bins = std::path::Path::new(env!("CARGO_BIN_EXE_jet"))
        .parent()
        .unwrap();
    std::fs::write(
        host.dir.path().join("settings.json"),
        json!({"claudePath":bins.join("fake-claude"),"codexPath":bins.join("fake-codex")})
            .to_string(),
    )
    .unwrap();
    host
}
fn send(host: &Host, id: &str, model: &str, script: Value, active: Value) -> Value {
    let mut req = request(id);
    req["model"] = json!(model);
    req["text"] = json!(format!("facade:{script}"));
    req["activeAppId"] = active;
    let (status, value) = host.post("/api/chat/send", req);
    assert_eq!(status, 200, "{value}");
    value
}
fn replay(host: &Host) -> Vec<Value> {
    let snapshot = host.get("/api/snapshot");
    let last = snapshot["cursor"].as_u64().unwrap();
    if last == 0 {
        return Vec::new();
    }
    let mut response = ureq::get(format!(
        "{}/api/events?epoch={}&cursor=0",
        host.url,
        snapshot["epoch"].as_str().unwrap()
    ))
    .call()
    .unwrap();
    let mut reader = BufReader::new(response.body_mut().as_reader());
    let mut events = Vec::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if let Some(data) = line.strip_prefix("data: ") {
            let event: Value = serde_json::from_str(data).unwrap();
            if event["kind"] == "event" {
                events.push(event["data"]["event"].clone());
                if event["data"]["cursor"].as_u64() == Some(last) {
                    break;
                }
            }
        }
    }
    events
}
fn wait_file(host: &Host, name: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if let Ok(text) = std::fs::read_to_string(host.dir.path().join(name))
            && let Ok(value) = serde_json::from_str(&text)
        {
            return value;
        }
        assert!(Instant::now() < deadline, "missing {name}");
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn both_providers_use_global_facade_without_resetting_conversation() {
    for model in ["sonnet", "gpt-6.1-sol"] {
        let fixture = Fixture::start();
        let second = Fixture::start();
        let host = host();
        let app = host
            .post("/api/apps", json!({"action":"add","address":fixture.url}))
            .1["app"]
            .clone();
        let id = app["id"].clone();
        let script = json!([
            {"tool":"apps_list"}, {"tool":"tools_search","arguments":{"query":"echo"}},
            {"tool":"tools_describe","arguments":{"appId":id,"tool":"echo"}},
            {"tool":"tools_call","arguments":{"appId":id,"tool":"echo","arguments":{"words":"real"}}},
            {"tool":"apps_update","arguments":{"command":{"action":"add","address":second.url}}},
            {"tool":"tools_search","arguments":{"query":"echo"}},
            {"tool":"apps_open","arguments":{"appId":id}}
        ]);
        send(&host, "first", model, script, Value::Null);
        let snapshot = host.until(|value| {
            value["active"].is_null()
                && value["history"]
                    .as_array()
                    .is_some_and(|history| history.len() == 2)
        });
        assert_eq!(snapshot["history"][1]["status"], "complete", "{snapshot}");
        let results = wait_file(&host, "facade-results.json");
        assert_eq!(
            results[1]["structuredContent"]["tools"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(
            results[1]["structuredContent"]["tools"][0]
                .get("inputSchema")
                .is_none()
        );
        assert_eq!(
            results[2]["structuredContent"]["server"]["instructions"],
            "Free fixture instructions"
        );
        assert_eq!(
            results[2]["structuredContent"]["tool"]["inputSchema"]["required"],
            json!(["words"])
        );
        assert_eq!(
            results[5]["structuredContent"]["tools"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(host.get("/api/apps").as_array().unwrap().len(), 2);
        assert_eq!(fixture.app.calls.load(Ordering::SeqCst), 1);
        let calls = snapshot["history"][1]["tools"].as_array().unwrap();
        let call = calls.iter().find(|call| call["tool"] == "echo").unwrap();
        assert_eq!(call["server"], id);
        assert_eq!(call["id"], "facade-3");
        assert_eq!(call["input"], json!({"words":"real"}));
        assert_eq!(call["result"]["source"], "real fixture");
        send(
            &host,
            "second",
            model,
            json!([{"tool":"apps_list"}]),
            id.clone(),
        );
        host.until(|value| {
            value["active"].is_null()
                && value["history"]
                    .as_array()
                    .is_some_and(|history| history.len() == 4)
        });
        let args = wait_file(
            &host,
            if model == "sonnet" {
                "fake-claude-args.json"
            } else {
                "fake-codex-args.json"
            },
        );
        assert!(
            args.as_array()
                .unwrap()
                .iter()
                .any(|arg| arg == "--resume" || arg == "resume")
        );
        let events = replay(&host);
        assert_eq!(
            events
                .iter()
                .filter(|event| event["kind"] == "registryChanged")
                .count(),
            2
        );
        assert!(events.iter().any(|event| event["kind"] == "appOpened"
            && event["clientId"] == "browser-a"
            && event["requestId"] == "first"));
        let root = host.post(
            &format!("/api/apps/{}/discovery", id.as_str().unwrap()),
            json!({"requestId":"root","tool":"root","arguments":{"words":"root"}}),
        );
        assert_eq!(root.0, 200);
        let branch = host.post(
            &format!("/api/apps/{}/discovery", id.as_str().unwrap()),
            json!({"requestId":"branch","tool":"branch","arguments":{"words":"branch"}}),
        );
        assert_eq!(
            branch.1["result"]["structuredContent"]["nodes"][0]["tool"],
            "echo"
        );
        assert_eq!(
            host.post(
                &format!("/api/apps/{}/discovery", id.as_str().unwrap()),
                json!({"requestId":"business","tool":"echo","arguments":{"words":"no"}})
            )
            .0,
            502
        );
        assert_eq!(fixture.app.calls.load(Ordering::SeqCst), 3);
        let token = wait_file(&host, "facade-connection.json")["token"]
            .as_str()
            .unwrap()
            .to_owned();
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .build()
            .into();
        assert_eq!(
            agent
                .get(format!("{}/mcp", host.url))
                .header("x-jet-turn", &token)
                .call()
                .unwrap()
                .status(),
            401,
            "completed turn credentials expire"
        );
        assert!(
            !std::fs::read_to_string(host.dir.path().join("transcript.jsonl"))
                .unwrap_or_default()
                .contains(&token)
        );
    }
}
#[test]
fn facade_actions_expire_with_the_initiating_turn() {
    let fixture = Fixture::start();
    let host = host();
    let id = host
        .post("/api/apps", json!({"action":"add","address":fixture.url}))
        .1["app"]["id"]
        .clone();
    fixture.app.hold_list.store(true, Ordering::SeqCst);
    std::thread::scope(|scope| {
        let pending = scope.spawn(|| {
            host.post(
                &format!("/api/apps/{}/discovery", id.as_str().unwrap()),
                json!({"requestId":"cancel-list","tool":"root","arguments":{"words":"root"}}),
            )
        });
        let deadline = Instant::now() + Duration::from_secs(8);
        while !fixture.app.listing.load(Ordering::SeqCst) {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            host.post("/api/tools/cancel", json!({"requestId":"cancel-list"}))
                .0,
            200
        );
        fixture.app.hold_list.store(false, Ordering::SeqCst);
        assert_eq!(
            pending.join().unwrap().0,
            502,
            "cancel during metadata must prevent dispatch"
        );
    });
    assert_eq!(fixture.app.calls.load(Ordering::SeqCst), 0);
    send(
        &host,
        "stopped",
        "sonnet",
        json!([{"tool":"apps_open","arguments":{"appId":id}},{"tool":"tools_call","arguments":{"appId":id,"tool":"echo","arguments":{"words":"wait"}}}]),
        Value::Null,
    );
    let connection = wait_file(&host, "facade-connection.json");
    let mut initialized = ureq::post(connection["url"].as_str().unwrap())
        .header("x-jet-turn",connection["token"].as_str().unwrap())
        .header("content-type","application/json")
        .header("accept","application/json, text/event-stream")
        .send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"binding-test","version":"1"}}}).to_string()).unwrap();
    let old_session = initialized.headers()["mcp-session-id"]
        .to_str()
        .unwrap()
        .to_owned();
    let _ = initialized.body_mut().read_to_string().unwrap();
    let headers = |request: ureq::RequestBuilder<ureq::typestate::WithBody>| {
        request
            .header("x-jet-turn", connection["token"].as_str().unwrap())
            .header("mcp-session-id", &old_session)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
    };
    headers(ureq::post(connection["url"].as_str().unwrap()))
        .send(json!({"jsonrpc":"2.0","method":"notifications/initialized"}).to_string())
        .unwrap();
    let rejected = headers(ureq::post(connection["url"].as_str().unwrap())).send(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"apps_open","arguments":{"appId":id,"clientId":"model-chosen-browser"}}}).to_string()).unwrap().body_mut().read_to_string().unwrap();
    assert!(
        rejected.contains("-32602"),
        "model-supplied browser identity must be rejected: {rejected}"
    );
    let deadline = Instant::now() + Duration::from_secs(8);
    while fixture.app.calls.load(Ordering::SeqCst) == 0 {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    host.post("/api/chat/stop", json!({"requestId":"stopped"}));
    host.until(|value| value["active"].is_null());
    while !fixture.app.cancelled.load(Ordering::SeqCst) {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut later = request("later");
    later["clientId"] = json!("browser-b");
    later["text"] = json!("facade:[{\"pause\":true}]");
    assert_eq!(host.post("/api/chat/send", later).0, 200);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into();
    let response=agent.post(connection["url"].as_str().unwrap()).header("x-jet-turn",connection["token"].as_str().unwrap()).header("content-type","application/json").send(json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"apps_open","arguments":{"appId":id}}}).to_string()).unwrap();
    assert_eq!(response.status(), 401);
    let deadline = Instant::now() + Duration::from_secs(8);
    let current = loop {
        let current = wait_file(&host, "facade-connection.json");
        if current["token"] != connection["token"] {
            break current;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    };
    let response = agent
        .post(current["url"].as_str().unwrap())
        .header("x-jet-turn", current["token"].as_str().unwrap())
        .header("mcp-session-id", old_session)
        .header("content-type", "application/json")
        .send(json!({"jsonrpc":"2.0","id":10,"method":"tools/list"}).to_string())
        .unwrap();
    assert_eq!(
        response.status(),
        401,
        "a current token cannot reuse an old turn's session"
    );
    host.post("/api/chat/stop", json!({"requestId":"later"}));
    host.until(|value| value["active"].is_null());
    let before = replay(&host)
        .iter()
        .filter(|event| event["kind"] == "registryChanged")
        .count();
    std::fs::remove_file(host.dir.path().join("apps.json")).unwrap();
    std::fs::create_dir(host.dir.path().join("apps.json")).unwrap();
    assert_ne!(
        host.post("/api/apps", json!({"action":"disable","id":id}))
            .0,
        200
    );
    std::thread::sleep(Duration::from_millis(50));
    let events = replay(&host);
    assert_eq!(
        events
            .iter()
            .filter(|event| event["kind"] == "registryChanged")
            .count(),
        before
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event["kind"] == "appOpened")
            .count(),
        1
    );
}
#[test]
fn exported_file_downloads_and_forget_removes_it() {
    let host = host();
    let markdown = "# Smile\n\nThe variance is \\( \\sigma^2 \\) and a cost of $5.\n\n\\[\nC - P = S - K e^{-rT}\n\\]\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";
    let script = json!([
        {"tool":"files_export","arguments":{
            "format":"pdf","title":"Volatility smile","markdown":markdown,"sources":["Hull, p. 7"]
        }},
        {"tool":"files_export","arguments":{
            "format":"html","title":"Volatility smile","markdown":markdown
        }},
        {"tool":"files_export","arguments":{
            "format":"markdown","title":"Volatility smile","markdown":markdown
        }}
    ]);
    send(&host, "export", "sonnet", script, Value::Null);
    let snapshot = host.until(|value| {
        value["active"].is_null()
            && value["history"]
                .as_array()
                .is_some_and(|history| history.len() == 2)
    });
    assert_eq!(snapshot["history"][1]["status"], "complete", "{snapshot}");
    let result = &snapshot["history"][1]["tools"][0]["result"];
    assert_eq!(result["name"], "Volatility smile.pdf", "{result}");
    assert_eq!(result["format"], "pdf");
    let id = result["id"].as_str().unwrap().to_owned();
    let page = &snapshot["history"][1]["tools"][1]["result"];
    assert_eq!(page["name"], "Volatility smile.html", "{page}");
    let page_id = page["id"].as_str().unwrap().to_owned();
    let notes_id = snapshot["history"][1]["tools"][2]["result"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into();
    let fetch = |path: &str| {
        let mut response = agent.get(format!("{}{path}", host.url)).call().unwrap();
        let status = response.status().as_u16();
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .map(|value| value.to_str().unwrap().to_owned())
                .unwrap_or_default()
        };
        let headers = (
            header("content-type"),
            header("content-disposition"),
            header("content-security-policy"),
            header("x-content-type-options"),
        );
        (status, headers, response.body_mut().read_to_vec().unwrap())
    };

    let (status, (content_type, disposition, policy, nosniff), body) =
        fetch(&format!("/api/files/{id}"));
    assert_eq!(status, 200);
    assert_eq!(content_type, "application/pdf");
    assert!(disposition.starts_with("attachment;"), "{disposition}");
    assert!(
        disposition.contains("filename=\"Volatility smile.pdf\""),
        "{disposition}"
    );
    assert_eq!(policy, "", "a PDF must load in the browser's own viewer");
    assert_eq!(nosniff, "nosniff");
    assert!(body.starts_with(b"%PDF-"));

    let (status, (_, disposition, policy, _), _) = fetch(&format!("/api/files/{id}/view"));
    assert_eq!(status, 200);
    assert!(disposition.starts_with("inline;"), "{disposition}");
    assert_eq!(policy, "", "a PDF must load in the browser's own viewer");

    let (status, (_, disposition, policy, nosniff), body) =
        fetch(&format!("/api/files/{page_id}/view"));
    assert_eq!(status, 200);
    assert!(disposition.starts_with("inline;"), "{disposition}");
    assert!(policy.contains("sandbox"), "{policy}");
    assert_eq!(nosniff, "nosniff");
    let html = String::from_utf8(body).unwrap();
    for formula in ["\\sigma^2", "C - P = S - K e^{-rT}"] {
        assert!(
            html.contains(&format!("<img class=\"math\" alt=\"{formula}\"")),
            "chat maths must be typeset: {formula}"
        );
    }
    assert!(html.contains("a cost of $5."), "a single $ is money");

    let (status, (content_type, _, policy, _), _) = fetch(&format!("/api/files/{notes_id}/view"));
    assert_eq!(status, 200);
    assert_eq!(content_type, "text/plain; charset=utf-8");
    assert!(policy.contains("sandbox"), "{policy}");

    assert_eq!(fetch("/api/files/not-an-id").0, 404);
    assert_eq!(fetch("/api/files/..%2Fsettings.json").0, 404);

    assert_eq!(host.post("/api/chat/forget", json!({})).0, 200);
    assert_eq!(fetch(&format!("/api/files/{id}")).0, 404);
    assert_eq!(fetch(&format!("/api/files/{page_id}")).0, 404);
    assert_eq!(fetch(&format!("/api/files/{notes_id}")).0, 404);
    assert!(!host.dir.path().join("files").exists());
}
