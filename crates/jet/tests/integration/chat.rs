use super::support::{Host, request};

#[test]
fn accepted_turn_is_idempotent_and_reconnects() {
    let host = Host::start();
    let request = request("lost-ack");
    let unacknowledged = host.send_without_ack(&request);
    let snapshot = host.until(|snapshot| snapshot["active"]["text"] == "Partial browser reply");
    assert_eq!(snapshot["active"]["tools"][0]["input"]["page"], 1);
    assert_eq!(
        snapshot["active"]["tools"][0]["result"]["text"],
        "free fixture"
    );
    drop(unacknowledged);
    let (status, accepted) = host.post("/api/chat/send", request.clone());
    assert_eq!(status, 200);
    assert_eq!(accepted["turnId"], snapshot["active"]["identity"]["turnId"]);
    let turn = serde_json::json!({
        "requestId": request["requestId"],
        "clientId": request["clientId"],
        "turnId": accepted["turnId"],
    });
    assert_eq!(snapshot["active"]["identity"], turn);
    assert_eq!(accepted["user"]["turn"]["request"], request);
    assert_eq!(host.invocations(), 1);
    let mut conflict = request.clone();
    conflict["text"] = "different".into();
    assert_eq!(host.post("/api/chat/send", conflict).0, 409);
    let mut other = request.clone();
    other["requestId"] = "other-browser".into();
    other["clientId"] = "browser-b".into();
    assert_eq!(host.post("/api/chat/send", other).1["kind"], "busy");
    let mut events = host.events(
        snapshot["epoch"].as_str().unwrap(),
        snapshot["cursor"].as_u64().unwrap(),
    );
    assert!(
        events.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/event-stream")
    );
    assert_eq!(
        host.post(
            "/api/chat/stop",
            serde_json::json!({"requestId":"lost-ack"})
        )
        .0,
        200
    );
    use std::io::BufRead;
    let mut reader = std::io::BufReader::new(events.body_mut().as_reader());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert!(line.contains("stopped"), "{line}");
    let event: serde_json::Value =
        serde_json::from_str(line.trim().strip_prefix("data: ").unwrap()).unwrap();
    assert_eq!(event["data"]["turn"], turn);
    let ended = host.until(|snapshot| snapshot["active"].is_null());
    assert_eq!(ended["history"].as_array().unwrap().len(), 2);
    assert_eq!(ended["history"][0]["turn"]["request"], request);
    assert_eq!(ended["history"][1]["text"], "Partial browser reply");
    assert_eq!(ended["history"][1]["status"], "stopped");
    assert_eq!(host.invocations(), 1);
    assert_eq!(
        host.post(
            "/api/chat/stop",
            serde_json::json!({"requestId":"cancel-before-send"})
        )
        .0,
        200
    );
    assert_eq!(
        host.post(
            "/api/chat/send",
            super::support::request("cancel-before-send")
        )
        .1["kind"],
        "cancelled"
    );
    assert_eq!(host.invocations(), 1);
    let mut flood = super::support::request("overflow");
    flood["text"] = "hang flood".into();
    assert_eq!(host.post("/api/chat/send", flood).0, 200);
    let flooded = host.until(|snapshot| {
        snapshot["active"]["text"]
            .as_str()
            .is_some_and(|text| text.len() == "Partial browser reply".len() + 600)
    });
    let mut replay = host.events(flooded["epoch"].as_str().unwrap(), 0);
    let mut line = String::new();
    std::io::BufReader::new(replay.body_mut().as_reader())
        .read_line(&mut line)
        .unwrap();
    let recovered: serde_json::Value =
        serde_json::from_str(line.trim().strip_prefix("data: ").unwrap()).unwrap();
    assert_eq!(recovered["kind"], "snapshot");
    assert_eq!(
        recovered["data"]["active"]["text"],
        flooded["active"]["text"]
    );
    assert_eq!(
        host.post(
            "/api/chat/stop",
            serde_json::json!({"requestId":"lost-ack"})
        )
        .0,
        200
    );
    assert_eq!(
        host.get("/api/snapshot")["active"]["identity"]["requestId"],
        "overflow"
    );
    host.post(
        "/api/chat/stop",
        serde_json::json!({"requestId":"overflow"}),
    );
    host.until(|snapshot| snapshot["active"].is_null());
}

#[test]
fn restart_recovers_request_identity_without_replaying_provider() {
    let host = Host::start();
    let request = request("restart");
    let (_, accepted) = host.post("/api/chat/send", request.clone());
    host.until(|snapshot| snapshot["active"]["text"] == "Partial browser reply");
    let host = host.restart();
    let snapshot = host.get("/api/snapshot");
    assert!(snapshot["active"].is_null());
    assert_eq!(snapshot["history"][1]["status"], "stopped");
    assert!(snapshot["history"][1]["error"].is_string());
    assert_eq!(
        host.post("/api/chat/send", request.clone()).1["turnId"],
        accepted["turnId"]
    );
    assert_eq!(host.invocations(), 1);
    let mut changed = request;
    changed["text"] = "changed".into();
    assert_eq!(host.post("/api/chat/send", changed).0, 409);
    let host = host.restart();
    assert_eq!(
        host.get("/api/snapshot")["history"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(host.invocations(), 1);

    // Settings and notes saved through the page survive forgetting the thread and a restart.
    let mut settings = host.get("/api/settings");
    settings["persona"]["name"] = "Ada".into();
    settings["hearingEngine"] = "phonon2".into();
    settings["phonon2Mode"] = "cpu".into();
    settings["speakingEngine"] = "phonon".into();
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into();
    let saved = [
        ("settings", settings),
        (
            "memory",
            serde_json::json!({"memory":"Remember","user":"User note","recent":"Recent note"}),
        ),
    ];
    for (name, body) in saved {
        let response = host
            .signed(agent.put(format!("{}/api/{name}", host.url)))
            .header("content-type", "application/json")
            .send(body.to_string())
            .unwrap();
        assert_eq!(response.status(), 200, "{name}");
    }
    assert_eq!(host.post("/api/chat/forget", serde_json::json!({})).0, 200);
    let host = host.restart();
    let settings = host.get("/api/settings");
    assert_eq!(settings["persona"]["name"], "Ada");
    assert_eq!(settings["hearingEngine"], "phonon2");
    assert_eq!(settings["phonon2Mode"], "cpu");
    assert_eq!(settings["speakingEngine"], "phonon");
    assert_eq!(host.get("/api/memory")["memory"], "Remember");
    // Under --disable-voice the page is told why Jet cannot speak, and nothing is asked of Google.
    let voice = host.get("/api/voice");
    for (way, engine) in [
        ("speak", "gemini"),
        ("speak", "phonon"),
        ("hear", "gemini"),
        ("hear", "phonon2"),
    ] {
        assert_eq!(voice[way][engine]["available"], false, "{way} {engine}");
        assert_eq!(
            voice[way][engine]["reason"],
            "Voice is turned off on this server"
        );
    }
    let cues = voice["cues"].as_array().unwrap();
    assert!(
        cues.iter()
            .any(|cue| cue["tag"] == "<laugh>" && cue["weight"].as_u64().unwrap() > 0)
    );
    for path in ["/api/voice/speech", "/api/voice/speech?engine=phonon"] {
        let speech = host.post(path, serde_json::json!({"text":"Hello there."}));
        assert_eq!(speech.0, 503, "{path}");
        assert_eq!(speech.1["kind"], "notConfigured");
    }
    for query in [
        "vocabulary=Jet&vocabulary=Quanty",
        "vocabulary=Jet&engine=phonon2&mode=exact",
    ] {
        let hear = host.post_bytes(&format!("/api/voice/hear?{query}"), &[0; 3200]);
        assert_eq!(hear.0, 503, "{query}");
        assert_eq!(hear.1["kind"], "notConfigured");
    }
}
