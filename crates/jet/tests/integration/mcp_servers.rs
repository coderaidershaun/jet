//! Prove, through the real host and local MCP stand-ins, that a user's own MCP servers connect with
//! sealed keys, are told to Jet each turn, are called through the facade, and make a turn read-only.
use super::{
    mcp_fixture::Fixture,
    support::{Host, LOG_FILE, User, host, logged_host, request, wait_file},
    web::run_turn,
};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

fn add(user: &User, name: &str, url: &str, key: Value) -> (u16, Value) {
    let mut body = json!({"provider":"custom","name":name,"url":format!("{url}mcp")});
    if !key.is_null() {
        body["key"] = key;
    }
    user.post("/api/mcp/servers", body)
}

fn bearer(token: &str) -> Value {
    json!({"kind":"bearer","token":token})
}

fn call(server: &Value, tool: &str, arguments: Value) -> Value {
    json!({"tool":"tools_call","arguments":{"appId":server,"tool":tool,"arguments":arguments}})
}

fn echo(server: &Value) -> Value {
    call(server, "echo", json!({"words":"hi"}))
}

/// The system prompt the provider stand-in was started with last.
fn system_prompt(host: &Host) -> String {
    let args: Vec<String> = serde_json::from_str(
        &std::fs::read_to_string(host.dir.path().join("fake-claude-args.json")).unwrap(),
    )
    .unwrap();
    let at = args
        .iter()
        .position(|arg| arg == "--system-prompt")
        .unwrap();
    args[at + 1].clone()
}

fn set_enabled(user: &User, id: &Value, enabled: bool) -> Value {
    let id = id.as_str().unwrap();
    let (status, server) = user.put(
        &format!("/api/mcp/servers/{id}/enabled"),
        json!({"enabled":enabled}),
    );
    assert_eq!(status, 200, "{server}");
    server
}

#[test]
fn a_server_with_its_key_connects_is_told_to_jet_and_its_tool_answers_a_turn() {
    let fixture = Fixture::guarded("sk-mcp-0451");
    let host = logged_host();
    let owner = host.owner();
    let (status, server) = add(&owner, "Fixture tools", &fixture.url, bearer("sk-mcp-0451"));
    assert_eq!(status, 200, "{server}");
    assert_eq!(
        (&server["state"], &server["keyHeader"], &server["enabled"]),
        (&json!("connected"), &json!("Authorization"), &json!(true))
    );
    let tools = server["tools"].as_array().unwrap();
    assert!(
        tools.contains(&json!({"name":"echo","readOnly":false})),
        "{server}"
    );
    assert!(
        tools.contains(&json!({"name":"job_status","readOnly":true})),
        "{server}"
    );
    let id = server["id"].clone();

    let results = run_turn(
        &host,
        "mcp-call",
        "Which MCPs can you use?",
        json!([echo(&id)]),
    );
    assert_eq!(results[0]["isError"], false, "{}", results[0]);
    assert_eq!(
        results[0]["structuredContent"]["structuredContent"],
        json!({"words":"hi","source":"real fixture"})
    );
    let prompt = system_prompt(&host);
    for told in [
        "## MCP servers",
        "call it with tools_call, giving the server's id as `appId`",
        "answer from this list",
        &format!(
            "- Fixture tools (id {}): a server the user added at 127.0.0.1",
            id.as_str().unwrap()
        ),
        "Connected. Tools: echo, root, progress, twin, job_status, job_write, fetch.",
    ] {
        assert!(prompt.contains(told), "missing {told:?} in {prompt}");
    }

    // The key is in no answer to the page, no line of the log and nowhere in the database in clear.
    let id_path = format!("/api/mcp/servers/{}", id.as_str().unwrap());
    let mut answers = vec![server.clone(), owner.get("/api/mcp/servers")];
    answers.push(owner.post(&format!("{id_path}/test"), json!({})).1);
    answers.push(set_enabled(&owner, &id, false));
    answers.push(set_enabled(&owner, &id, true));
    answers.push(
        owner
            .put(&format!("{id_path}/key"), bearer("sk-mcp-0451"))
            .1,
    );
    answers.push(owner.get("/api/snapshot"));
    assert_eq!(answers[2]["state"], "connected", "{}", answers[2]);
    for answer in &answers {
        assert!(!answer.to_string().contains("sk-mcp-0451"), "{answer}");
    }
    let log = std::fs::read_to_string(host.dir.path().join(LOG_FILE)).unwrap();
    assert!(!log.contains("sk-mcp-0451"), "{log}");
    let database = host.database_bytes();
    assert!(!database.windows(11).any(|bytes| bytes == b"sk-mcp-0451"));

    let listed = owner.get("/api/mcp/servers");
    let notion = listed["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|provider| provider["id"] == "notion")
        .unwrap();
    assert_eq!(notion["address"], "https://mcp.notion.com/mcp");
}

#[test]
fn a_server_turned_off_or_removed_leaves_the_next_turn_and_one_turned_on_comes_back() {
    let fixture = Fixture::guarded("key-1");
    let host = host();
    let owner = host.owner();
    let server = add(&owner, "Fixture tools", &fixture.url, bearer("key-1")).1;
    let id = server["id"].clone();
    let told = format!("(id {})", id.as_str().unwrap());

    assert_eq!(set_enabled(&owner, &id, false)["enabled"], false);
    let off = run_turn(&host, "off", "", json!([echo(&id)]));
    assert_eq!(off[0]["isError"], true, "{}", off[0]);
    assert_eq!(off[0]["structuredContent"]["error"]["kind"], "unavailable");
    let prompt = system_prompt(&host);
    assert!(!prompt.contains(&told) && prompt.contains("The user has added no MCP servers"));
    assert_eq!(fixture.app.calls.load(Ordering::SeqCst), 0);

    assert_eq!(set_enabled(&owner, &id, true)["state"], "connected");
    let on = run_turn(&host, "on", "", json!([echo(&id)]));
    assert_eq!(on[0]["isError"], false, "{}", on[0]);
    assert!(system_prompt(&host).contains(&told));
    assert_eq!(fixture.app.calls.load(Ordering::SeqCst), 1);

    assert_eq!(
        host.delete(&format!("/api/mcp/servers/{}", id.as_str().unwrap())),
        200
    );
    assert_eq!(owner.get("/api/mcp/servers")["servers"], json!([]));
    let removed = run_turn(&host, "removed", "", json!([echo(&id)]));
    assert_eq!(removed[0]["isError"], true, "{}", removed[0]);
    assert!(!system_prompt(&host).contains(&told));
    assert_eq!(fixture.app.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn a_wrong_key_fails_with_its_reason_and_no_key_needs_a_sign_in() {
    let (first, second) = (Fixture::guarded("right"), Fixture::guarded("right"));
    let host = host();
    let owner = host.owner();
    let wrong = add(&owner, "Wrong key", &first.url, bearer("wrong")).1;
    assert_eq!(wrong["state"], "failed", "{wrong}");
    let reason = wrong["reason"].as_str().unwrap();
    assert!(reason.contains("refused the key"), "{reason}");

    let keyless = add(&owner, "No key", &second.url, Value::Null).1;
    assert_eq!(
        (&keyless["state"], &keyless["reason"]),
        (&json!("needs_key"), &Value::Null),
        "{keyless}"
    );
    assert!(system_prompt_after_a_turn(&host).contains("it needs a sign-in or a key"));

    let id = wrong["id"].as_str().unwrap();
    let mended = owner
        .put(&format!("/api/mcp/servers/{id}/key"), bearer("right"))
        .1;
    assert_eq!(
        (&mended["state"], &mended["reason"]),
        (&json!("connected"), &Value::Null),
        "{mended}"
    );

    let nowhere = owner.post(
        "/api/mcp/servers",
        json!({"provider":"custom","name":"Gone","url":"http://127.0.0.1:9/mcp"}),
    );
    assert_eq!(nowhere.1["state"], "failed", "{}", nowhere.1);
    assert!(
        nowhere.1["reason"]
            .as_str()
            .unwrap()
            .starts_with("could not connect"),
        "{}",
        nowhere.1
    );
}

fn system_prompt_after_a_turn(host: &Host) -> String {
    run_turn(host, "look", "", json!([{"tool":"apps_list"}]));
    system_prompt(host)
}

#[test]
fn a_second_user_sees_and_calls_nothing_of_the_first_users_servers() {
    let fixture = Fixture::guarded("owner-key");
    let host = host();
    let owner = host.owner();
    let server = add(&owner, "Owner's tools", &fixture.url, bearer("owner-key")).1;
    let id = server["id"].as_str().unwrap().to_owned();
    let colleague = host.sign_in_as("admin1@gmail.com");

    assert_eq!(colleague.get("/api/mcp/servers")["servers"], json!([]));
    let path = format!("/api/mcp/servers/{id}");
    assert_eq!(colleague.post(&format!("{path}/test"), json!({})).0, 404);
    assert_eq!(
        colleague
            .put(&format!("{path}/enabled"), json!({"enabled":false}))
            .0,
        404
    );
    assert_eq!(colleague.put(&format!("{path}/key"), bearer("mine")).0, 404);
    // Only an admin may add a server on the server itself, and the colleague is not one.
    let (status, refused) = add(&colleague, "Mine", &fixture.url, Value::Null);
    assert_eq!(
        (status, &refused["kind"]),
        (403, &json!("adminOnly")),
        "{refused}"
    );

    let mut message = request("colleague-call");
    let script = json!([echo(&json!(id)), {"tool":"tools_search","arguments":{"query":"echo"}}]);
    message["text"] = json!(format!("facade:{script}"));
    assert_eq!(colleague.post("/api/chat/send", message).0, 200);
    colleague.until(|value| {
        value["active"].is_null()
            && value["history"]
                .as_array()
                .is_some_and(|history| history.len() == 2)
    });
    let results = wait_file(&host, "facade-results.json");
    assert_eq!(results[0]["isError"], true, "{}", results[0]);
    assert_eq!(
        results[1]["structuredContent"]["tools"],
        json!([]),
        "{}",
        results[1]
    );
    assert!(!system_prompt(&host).contains(&id));
    assert_eq!(fixture.app.calls.load(Ordering::SeqCst), 0);
    assert_eq!(owner.get("/api/mcp/servers")["servers"][0]["enabled"], true);
}

#[test]
fn after_a_server_result_the_turn_cannot_change_apps_or_call_a_tool_that_writes() {
    let (app_fixture, server_fixture) = (Fixture::start(), Fixture::guarded("k"));
    let host = host();
    let owner = host.owner();
    let app = owner
        .post(
            "/api/apps",
            json!({"action":"add","address":app_fixture.url}),
        )
        .1["app"]["id"]
        .clone();
    let server = add(&owner, "Mail", &server_fixture.url, bearer("k")).1["id"].clone();
    let script = json!([
        echo(&server),
        {"tool":"apps_update","arguments":{"command":{"action":"disable","id":app}}},
        call(&server, "job_write", json!({})),
        call(&server, "job_status", json!({})),
    ]);
    let results = run_turn(&host, "outside-text", "", script);

    assert_eq!(results[0]["isError"], false, "{}", results[0]);
    for refused in &results[1..3] {
        let error = &refused["structuredContent"]["error"];
        assert_eq!(error["kind"], "writeAfterWebText", "{refused}");
        assert!(
            error["message"].as_str().unwrap().contains("MCP server"),
            "{refused}"
        );
    }
    assert_eq!(
        results[3]["isError"], false,
        "a read-only tool still runs: {}",
        results[3]
    );
    assert_eq!(server_fixture.app.calls.load(Ordering::SeqCst), 2);
    assert_eq!(host.get("/api/apps")[0]["enabled"], true);
}

#[test]
fn a_key_that_stops_working_shows_at_once_and_a_call_that_works_again_mends_it() {
    let fixture = Fixture::guarded("first-key");
    let host = host();
    let owner = host.owner();
    let server = add(&owner, "Mail", &fixture.url, bearer("first-key")).1;
    let id = server["id"].clone();
    assert_eq!(server["state"], "connected", "{server}");

    fixture.require("rotated-key");
    let refused = run_turn(&host, "revoked", "", json!([echo(&id)]));
    assert_eq!(refused[0]["isError"], true, "{}", refused[0]);
    let listed = owner.get("/api/mcp/servers")["servers"][0].clone();
    assert_eq!(listed["state"], "failed", "{listed}");
    assert!(
        listed["reason"]
            .as_str()
            .unwrap()
            .contains("refused the key"),
        "{listed}"
    );
    assert!(system_prompt_after_a_turn(&host).contains("the last connection failed"));

    fixture.require("first-key");
    let mended = run_turn(&host, "mended", "", json!([echo(&id)]));
    assert_eq!(mended[0]["isError"], false, "{}", mended[0]);
    let listed = owner.get("/api/mcp/servers")["servers"][0].clone();
    assert_eq!(
        (&listed["state"], &listed["reason"]),
        (&json!("connected"), &Value::Null),
        "{listed}"
    );
    assert!(!listed["tools"].as_array().unwrap().is_empty(), "{listed}");
}
