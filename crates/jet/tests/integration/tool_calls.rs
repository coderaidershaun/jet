//! Prove a tool call shows its progress, takes a file of the conversation by its id, and that
//! the page can read the status of the job it started.
use super::{
    mcp_fixture::Fixture,
    support::{Host, host, replay, request, wait_file},
};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

#[test]
fn job_progress_status_route_and_file_handoff() {
    let fixture = Fixture::start();
    let host = host();
    let app = host
        .post("/api/apps", json!({"action":"add","address":fixture.url}))
        .1["app"]["id"]
        .clone();
    let (status, upload) = host.upload("notes.txt", b"the notes\n");
    assert_eq!(status, 200, "{upload}");
    let file_id = upload["id"].as_str().unwrap().to_owned();
    let stranger = uuid::Uuid::new_v4().to_string();

    let call = |tool: &str, arguments: Value| json!({"tool":"tools_call","arguments":{"appId":app,"tool":tool,"arguments":arguments}});
    let script = json!([
        call("progress", json!({})),
        call("fetch", json!({"source":{"pdf_url":{"$file":file_id}}})),
        call("fetch", json!({"source":{"pdf_url":{"$file":stranger}}})),
    ]);
    let mut message = request("handoff");
    message["text"] = json!(format!("facade:{script}"));
    message["attachments"] = json!([file_id]);
    let (status, accepted) = host.post("/api/chat/send", message);
    assert_eq!(status, 200, "{accepted}");
    let snapshot = host.until(|value| {
        value["active"].is_null()
            && value["history"]
                .as_array()
                .is_some_and(|history| history.len() == 2)
    });
    assert_eq!(snapshot["history"][1]["status"], "complete", "{snapshot}");

    // Progress reaches the page on the card of the call, and the server was sent a token.
    assert!(fixture.app.had_progress_token.load(Ordering::SeqCst));
    let updates: Vec<Value> = replay(&host)
        .into_iter()
        .filter(|event| event["kind"] == "toolProgress")
        .collect();
    assert!(!updates.is_empty(), "no progress reached the page");
    for update in &updates {
        assert_eq!(update["id"], "facade-0", "{update}");
        assert_eq!(update["total"], 100.0, "{update}");
        let step = update["progress"].as_f64().unwrap() / 10.0;
        assert_eq!(update["message"], format!("step {step}"), "{update}");
    }

    // A `$file` becomes the address of the file before the arguments are checked, and a file
    // that is not in the conversation stops the call.
    let results = wait_file(&host, "facade-results.json");
    let address = format!("{}/api/files/{file_id}", host.url);
    assert_eq!(
        results[1]["structuredContent"]["structuredContent"]["source"]["pdf_url"], address,
        "{}",
        results[1]
    );
    assert_eq!(
        ureq::get(&address)
            .call()
            .unwrap()
            .body_mut()
            .read_to_vec()
            .unwrap(),
        b"the notes\n"
    );
    assert_eq!(results[2]["isError"], true, "{}", results[2]);
    let refusal = results[2]["structuredContent"]["error"]["message"]
        .as_str()
        .unwrap();
    assert!(
        refusal.contains(&stranger) && refusal.contains("files_list"),
        "{refusal}"
    );
    assert_eq!(
        fixture.app.calls.load(Ordering::SeqCst),
        2,
        "the refused call never reached the app"
    );

    // The status route calls only a read-only tool that carries the job marker.
    let status_of = |tool: &str| {
        host.post(
            &format!("/api/apps/{}/status", app.as_str().unwrap()),
            json!({"requestId":format!("status-{tool}"),"tool":tool,"arguments":{}}),
        )
    };
    assert_eq!(status_of("echo").0, 502, "no marker");
    assert_eq!(status_of("job_write").0, 502, "marked but not read-only");
    assert_eq!(fixture.app.calls.load(Ordering::SeqCst), 2);
    let (code, status) = status_of("job_status");
    assert_eq!(code, 200, "{status}");
    assert_eq!(status["result"]["structuredContent"]["job_id"], "job-1");
    assert_eq!(status["result"]["structuredContent"]["state"], "running");
    assert_eq!(fixture.app.calls.load(Ordering::SeqCst), 3);
}

fn add_fixture_app(host: &Host, fixture: &Fixture) -> Value {
    host.post("/api/apps", json!({"action":"add","address":fixture.url}))
        .1["app"]["id"]
        .clone()
}
fn call_twin(app: &Value) -> Value {
    json!({"tool":"tools_call","arguments":{"appId":app,"tool":"twin","arguments":{}}})
}
/// Sends the script as one turn and waits for the turn to end.
fn run_turn(host: &Host, script: Value) {
    let mut message = request("progress");
    message["text"] = json!(format!("facade:{script}"));
    let (status, accepted) = host.post("/api/chat/send", message);
    assert_eq!(status, 200, "{accepted}");
    let snapshot = host.until(|value| {
        value["active"].is_null()
            && value["history"]
                .as_array()
                .is_some_and(|history| history.len() == 2)
    });
    assert_eq!(snapshot["history"][1]["status"], "complete", "{snapshot}");
}

#[test]
fn first_progress_update_reaches_its_card() {
    let fixture = Fixture::start();
    let host = host();
    let app = add_fixture_app(&host, &fixture);
    run_turn(&host, json!([call_twin(&app)]));

    let updates: Vec<Value> = replay(&host)
        .into_iter()
        .filter(|event| event["kind"] == "toolProgress")
        .collect();
    let first = updates.first().expect("no progress reached the page");
    assert_eq!(first["id"], "facade-0", "{first}");
    assert_eq!(first["progress"], 1.0, "the first update was lost: {first}");
    assert_eq!(first["message"], "call 1 step 1", "{first}");
}

#[test]
fn identical_calls_at_once_each_show_their_own_progress() {
    let fixture = Fixture::start();
    let host = host();
    let app = add_fixture_app(&host, &fixture);
    run_turn(
        &host,
        json!([{"together":[call_twin(&app), call_twin(&app)]}]),
    );

    let results = wait_file(&host, "facade-results.json");
    let updates: Vec<Value> = replay(&host)
        .into_iter()
        .filter(|event| event["kind"] == "toolProgress")
        .collect();
    for (part, result) in results.as_array().unwrap().iter().enumerate() {
        let call = result["structuredContent"]["structuredContent"]["call"]
            .as_u64()
            .unwrap_or_else(|| panic!("no call number in {result}"));
        let card = format!("facade-0-{part}");
        let own: Vec<&Value> = updates
            .iter()
            .filter(|update| update["id"] == card)
            .collect();
        assert!(!own.is_empty(), "card {card} got no progress: {updates:?}");
        for update in own {
            let message = update["message"].as_str().unwrap();
            assert!(
                message.starts_with(&format!("call {call} ")),
                "card {card} belongs to call {call} but shows: {update}"
            );
        }
    }
}
