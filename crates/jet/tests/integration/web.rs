//! Prove that Jet reads pages only on sites the user linked, and that a reply which read web text
//! cannot change apps or run app tools that are not read-only.
use super::{
    mcp_fixture::Fixture,
    support::{Host, host, replay, request, wait_file},
};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

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
