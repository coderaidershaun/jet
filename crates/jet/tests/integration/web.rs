//! Prove that Jet reads pages only on sites the user linked, and that a reply which read web text
//! cannot change apps or run app tools that are not read-only.
use super::{
    mcp_fixture::Fixture,
    support::{Host, host, replay, request, wait_file},
};
use serde_json::{Value, json};
use std::sync::{atomic::Ordering, mpsc};
use std::time::Duration;

/// Sends one message with the provider script in it, waits for the reply to end, and gives the
/// result of each step of the script.
fn run_turn(host: &Host, id: &str, words: &str, script: Value) -> Vec<Value> {
    let mut message = request(id);
    message["text"] = json!(format!("{words}\nfacade:{script}"));
    let (status, accepted) = host.post("/api/chat/send", message);
    assert_eq!(status, 200, "{accepted}");
    let snapshot = host.until(|value| {
        value["active"].is_null()
            && value["history"]
                .as_array()
                .is_some_and(|history| history.last().is_some_and(|last| last["role"] == "jet"))
    });
    let last = snapshot["history"].as_array().unwrap().last().unwrap();
    assert_eq!(last["status"], "complete", "{snapshot}");
    wait_file(host, "facade-results.json")
        .as_array()
        .unwrap()
        .clone()
}

fn disable(app: &Value) -> Value {
    json!({"tool":"apps_update","arguments":{"command":{"action":"disable","id":app}}})
}

fn call(app: &Value, tool: &str) -> Value {
    json!({"tool":"tools_call","arguments":{"appId":app,"tool":tool,"arguments":{}}})
}

fn refusal_kind(result: &Value) -> &Value {
    &result["structuredContent"]["error"]["kind"]
}

#[test]
fn write_after_web_text_is_refused_in_order() {
    let fixture = Fixture::start();
    let host = host();
    let app = host
        .post("/api/apps", json!({"action":"add","address":fixture.url}))
        .1["app"]["id"]
        .clone();
    let script = json!([
        {"fetch": "github.com/anthropics/claude-code"},
        disable(&app),
        call(&app, "job_write"),
        call(&app, "job_status"),
        // A removed file cannot be brought back, so it is refused after web text, whatever the id.
        json!({"tool":"files_update","arguments":{"command":{"action":"remove","id":"00000000-0000-4000-8000-000000000000"}}}),
    ]);
    let words = "What is https://github.com/anthropics/claude-code about?";
    let results = run_turn(&host, "web-then-write", words, script);

    assert!(results[0]["refused"].is_null(), "{}", results[0]);
    for refused in &results[1..3] {
        assert_eq!(refusal_kind(refused), "writeAfterWebText", "{refused}");
        let message = refused["structuredContent"]["error"]["message"].as_str();
        assert!(message.unwrap().contains("Tell the user"), "{refused}");
    }
    assert_eq!(results[3]["isError"], false, "{}", results[3]);
    assert_eq!(
        refusal_kind(&results[4]),
        "writeAfterWebText",
        "{}",
        results[4]
    );
    assert_eq!(
        fixture.app.calls.load(Ordering::SeqCst),
        1,
        "only the read-only tool reached the app"
    );
    let apps = host.get("/api/apps");
    assert_eq!(apps[0]["enabled"], true, "{apps}");

    // The read shows as a card with its address, and the thread keeps it with the reply.
    let started = replay(&host)
        .into_iter()
        .find(|event| event["kind"] == "toolStarted")
        .unwrap();
    assert_eq!(
        (
            &started["server"],
            &started["tool"],
            &started["input"]["url"]
        ),
        (
            &json!("web"),
            &json!("fetch"),
            &json!("https://github.com/anthropics/claude-code")
        )
    );
    let history = host.get("/api/snapshot")["history"].clone();
    let saved = &history[1]["tools"][0];
    assert_eq!(
        (&saved["server"], &saved["ok"]),
        (&json!("web"), &json!(true))
    );
}

#[test]
fn a_turn_with_no_web_read_can_still_call_apps_update() {
    let fixture = Fixture::start();
    let host = host();
    let app = host
        .post("/api/apps", json!({"action":"add","address":fixture.url}))
        .1["app"]["id"]
        .clone();
    let results = run_turn(&host, "no-web", "", json!([disable(&app)]));

    assert_eq!(results[0]["isError"], false, "{}", results[0]);
    assert_eq!(host.get("/api/apps")[0]["enabled"], false);
}

#[test]
fn a_site_on_claude_codes_own_list_is_refused_when_the_user_did_not_link_it() {
    let host = host();
    let script = json!([
        {"fetch": "docs.python.org/3/library/json.html"},
        {"fetch": "github.com/anthropics/claude-code"},
    ]);
    let words = "Compare it with https://github.com/anthropics/claude-code";
    let results = run_turn(&host, "unlinked", words, script);

    let refusal = results[0]["refused"].as_str().unwrap_or_default();
    assert!(refusal.contains("paste the link"), "{}", results[0]);
    assert!(
        refusal.contains("[page-not-linked]"),
        "the page matches this mark: {refusal}"
    );
    assert!(results[1]["refused"].is_null(), "{}", results[1]);
    let args: Vec<String> = serde_json::from_str(
        &std::fs::read_to_string(host.dir.path().join("fake-claude-args.json")).unwrap(),
    )
    .unwrap();
    let allowed = &args[args.iter().position(|arg| arg == "--allowedTools").unwrap() + 1];
    assert!(
        allowed.ends_with(",WebSearch,WebFetch(domain:github.com)"),
        "{allowed}"
    );
}

/// Sends `apps_update` to the facade as the provider would, with the turn's token, and gives the
/// kind of the refusal, or null when the call ran. `tool_use` is the id the request names.
fn refusal_of_a_write(connection: &Value, tool_use: Option<&str>, app: &Value) -> Value {
    let url = connection["url"].as_str().unwrap();
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
        .build()
        .into();
    let post = |session: Option<&str>, body: Value| {
        let mut request = agent
            .post(url)
            .header("x-jet-turn", connection["token"].as_str().unwrap())
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream");
        if let Some(session) = session {
            request = request.header("mcp-session-id", session);
        }
        request.send(body.to_string()).unwrap()
    };
    let mut opened = post(
        None,
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"guard-test","version":"1"}}}),
    );
    let session = opened.headers()["mcp-session-id"]
        .to_str()
        .unwrap()
        .to_owned();
    opened.body_mut().read_to_string().unwrap();
    post(
        Some(&session),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    );
    let mut params = disable(app);
    params["name"] = params["tool"].take();
    if let Some(id) = tool_use {
        params["_meta"] = json!({"claudecode/toolUseId": id});
    }
    let answer = post(
        Some(&session),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":params}),
    )
    .body_mut()
    .read_to_string()
    .unwrap();
    let result = answer
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.strip_prefix("data: ")?).ok())
        .find(|message| message["id"] == 2)
        .unwrap_or_else(|| panic!("the facade gave no result: {answer}"));
    refusal_kind(&result["result"]).clone()
}

/// What the test does while its write is at the facade.
enum Then {
    /// Lets the stand-in write a web result and then the write's own tool-use line.
    WriteTheLines,
    Stop,
    Nothing,
}

#[test]
fn a_write_waits_for_its_own_line_and_is_refused_when_the_order_cannot_be_known() {
    let fixture = Fixture::start();
    let host = host();
    let app = host
        .post("/api/apps", json!({"action":"add","address":fixture.url}))
        .1["app"]["id"]
        .clone();
    let announce =
        json!({"announce":"own-line","tool":"apps_update","arguments":disable(&app)["arguments"]});
    // Each stand-in waits for a file this test makes, so the order of the lines is the test's.
    let rows = [
        (
            "the write's own line comes after a web read",
            json!([{"wait":"lines"}, {"search":"kites"}, announce, {"wait":"end"}]),
            Some("own-line"),
            Then::WriteTheLines,
            "writeAfterWebText",
        ),
        (
            "the write names no tool use",
            json!([{"search":"kites"}, {"wait":"end"}]),
            None,
            Then::Nothing,
            "noToolUseId",
        ),
        (
            "the reply is stopped while the write waits",
            json!([{"wait":"end"}]),
            Some("never-written"),
            Then::Stop,
            "turnEnded",
        ),
    ];
    for (number, (name, script, tool_use, then, expected)) in rows.into_iter().enumerate() {
        let id = format!("guard-{number}");
        let file = |name: &str| host.dir.path().join(name);
        for stale in ["lines", "end", "facade-connection.json"] {
            let _ = std::fs::remove_file(file(stale));
        }
        let mut message = request(&id);
        message["text"] = json!(format!("facade:{script}"));
        assert_eq!(host.post("/api/chat/send", message).0, 200, "{name}");
        let connection = wait_file(&host, "facade-connection.json");
        if tool_use.is_none() {
            host.until(|value| {
                let tools = value["active"]["tools"].as_array();
                tools.is_some_and(|tools| tools.iter().any(|tool| tool["kind"] == "toolFinished"))
            });
        }

        let (sender, answers) = mpsc::channel();
        let sent_app = app.clone();
        std::thread::spawn(move || {
            sender.send(refusal_of_a_write(&connection, tool_use, &sent_app))
        });
        let early = answers.recv_timeout(Duration::from_millis(300)).ok();
        match then {
            Then::WriteTheLines => std::fs::write(file("lines"), "").unwrap(),
            Then::Stop => {
                let stopped = host.post("/api/chat/stop", json!({"requestId": id}));
                assert_eq!(stopped.0, 200, "{name}");
            }
            Then::Nothing => {}
        }
        if tool_use.is_some() {
            assert_eq!(
                early, None,
                "{name}: the write was answered before its own line"
            );
        }
        let kind = early.unwrap_or_else(|| {
            let waited = answers.recv_timeout(Duration::from_secs(10));
            waited.unwrap_or_else(|_| panic!("{name}: the facade did not answer"))
        });
        assert_eq!(kind, expected, "{name}");

        std::fs::write(file("end"), "").unwrap();
        host.until(|value| value["active"].is_null());
    }
    assert_eq!(host.get("/api/apps")[0]["enabled"], true, "a write ran");
}
