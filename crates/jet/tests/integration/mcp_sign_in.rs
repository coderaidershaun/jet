//! Prove, through the real host, the provider stand-in and an MCP stand-in that is its own OAuth
//! sign-in server, that a server which offers only an OAuth sign-in connects from Settings, renews
//! its token, says plainly when the sign-in ended, refuses a return it did not start, and never
//! shows a token, code, verifier or client secret.
use super::{
    mcp_fixture::Fixture,
    support::{Host, LOG_FILE, User, agent, cookie_header, host, logged_host},
    web::run_turn,
};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

/// Adds the stand-in as a custom server with no key, which it answers with an OAuth challenge.
pub(super) fn add(user: &User, fixture: &Fixture) -> Value {
    let body = json!({"provider":"custom","name":"Team wiki","url":format!("{}mcp", fixture.url),"key":null});
    let (status, server) = user.post("/api/mcp/servers", body);
    assert_eq!(status, 200, "{server}");
    server
}

pub(super) fn path(server: &Value, tail: &str) -> String {
    format!("/api/mcp/servers/{}{tail}", server["id"].as_str().unwrap())
}

/// Starts the sign-in and gives the answer, which names the provider's sign-in page.
pub(super) fn start(user: &User, server: &Value, client: Value) -> (u16, Value) {
    user.post(&path(server, "/signin"), json!({"client": client}))
}

/// The user signs in on the provider's page, which approves at once and sends the browser back to
/// Jet: the address it sends the browser to.
pub(super) fn approve(address: &str) -> url::Url {
    let response = agent().get(address).call().unwrap();
    assert_eq!(
        response.status(),
        302,
        "the sign-in page refused: {address}"
    );
    let back = response.headers()["location"].to_str().unwrap();
    url::Url::parse(back).unwrap()
}

/// The browser follows the provider's redirect back to Jet, as a top-level navigation from another site.
pub(super) fn come_back(host: &Host, cookie: &str, back: &str) -> (u16, Option<String>, String) {
    let at = url::Url::parse(back).unwrap();
    let path = &back[at.origin().ascii_serialization().len()..];
    let mut response = agent()
        .get(format!("{}{path}", host.url))
        .header("cookie", cookie)
        .header("sec-fetch-site", "cross-site")
        .header("sec-fetch-mode", "navigate")
        .header("sec-fetch-dest", "document")
        .call()
        .unwrap();
    let status = response.status().as_u16();
    let location = response
        .headers()
        .get("location")
        .map(|value| value.to_str().unwrap().to_owned());
    (
        status,
        location,
        response.body_mut().read_to_string().unwrap(),
    )
}

/// The whole sign-in, from the tap on Sign in to the page Jet shows when the browser comes back.
pub(super) fn sign_in(host: &Host, user: &User, server: &Value, client: Value) -> String {
    let (status, started) = start(user, server, client);
    assert_eq!(status, 200, "{started}");
    let back = approve(started["address"].as_str().unwrap());
    let (status, _, page) = come_back(host, &user.cookie, back.as_str());
    assert_eq!(status, 200, "{page}");
    page
}

pub(super) fn listed(user: &User) -> Value {
    user.get("/api/mcp/servers")["servers"][0].clone()
}

pub(super) fn echo(server: &Value) -> Value {
    json!({"tool":"tools_call","arguments":{"appId":server["id"],"tool":"echo","arguments":{"words":"hi"}}})
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

#[test]
fn an_oauth_only_server_signs_in_from_its_challenge_lists_its_tools_and_answers_a_turn() {
    let fixture = Fixture::oauth();
    let host = logged_host();
    let owner = host.owner();
    let server = add(&owner, &fixture);
    assert_eq!(
        (&server["state"], &server["signedIn"], &server["reason"]),
        (&json!("needs_key"), &json!(false), &Value::Null),
        "the challenge leaves the server waiting for a sign-in: {server}"
    );
    run_turn(&host, "before", "", json!([{"tool":"apps_list"}]));
    let prompt = system_prompt(&host);
    assert!(
        prompt.contains("Not callable now: the user must sign in to it first, with its Sign in button in Settings, under MCP"),
        "{prompt}"
    );

    let (status, started) = start(&owner, &server, Value::Null);
    assert_eq!(status, 200, "{started}");
    let address = url::Url::parse(started["address"].as_str().unwrap()).unwrap();
    assert!(
        address
            .as_str()
            .starts_with(&format!("{}auth/authorize?", fixture.url)),
        "{address}"
    );
    let query: std::collections::HashMap<_, _> = address.query_pairs().into_owned().collect();
    assert_eq!(query["code_challenge_method"], "S256");
    assert_eq!(query["resource"], format!("{}mcp", fixture.url));
    assert_eq!(query["scope"], "tools.read");
    assert_eq!(
        query["redirect_uri"],
        format!("{}/mcp-signin/return", host.url)
    );
    let back = approve(address.as_str());
    let (status, _, page) = come_back(&host, &owner.cookie, back.as_str());
    assert_eq!(status, 200, "{page}");
    assert!(
        page.contains("Signed in to Team wiki") && page.contains("Jet can now call its 7 tools"),
        "{page}"
    );

    let signed_in = listed(&owner);
    assert_eq!(
        (
            &signed_in["state"],
            &signed_in["signedIn"],
            &signed_in["keyHeader"]
        ),
        (&json!("connected"), &json!(true), &Value::Null),
        "{signed_in}"
    );
    assert!(
        signed_in["tools"]
            .as_array()
            .unwrap()
            .contains(&json!({"name":"echo","readOnly":false}))
    );

    let results = run_turn(&host, "call", "", json!([echo(&signed_in)]));
    assert_eq!(results[0]["isError"], false, "{}", results[0]);
    assert_eq!(fixture.app.calls.load(Ordering::SeqCst), 1);
    assert!(system_prompt(&host).contains("Connected. Tools: echo"));
    assert_eq!(
        *fixture.oauth.refusals.lock().unwrap(),
        Vec::<String>::new()
    );

    // No code, token or verifier the stand-in gave out or was sent reaches the page, the log or the
    // database in clear.
    let answers = [
        server.to_string(),
        started.to_string(),
        page,
        owner.get("/api/mcp/servers").to_string(),
        owner
            .post(&path(&signed_in, "/test"), json!({}))
            .1
            .to_string(),
        owner.get("/api/snapshot").to_string(),
    ];
    let log = std::fs::read_to_string(host.dir.path().join(LOG_FILE)).unwrap();
    let database = host.database_bytes();
    let secrets = fixture.oauth.secrets();
    assert!(secrets.len() >= 4, "{secrets:?}");
    for secret in &secrets {
        for answer in &answers {
            assert!(!answer.contains(secret.as_str()), "{secret} in {answer}");
        }
        assert!(!log.contains(secret.as_str()), "{secret} in the log");
        assert!(
            !database
                .windows(secret.len())
                .any(|bytes| bytes == secret.as_bytes()),
            "{secret} in the database"
        );
    }
}

#[test]
fn a_token_that_ran_out_is_renewed_once_and_a_revoked_sign_in_asks_for_a_new_one() {
    let fixture = Fixture::oauth();
    let host = host();
    let owner = host.owner();
    let server = add(&owner, &fixture);
    sign_in(&host, &owner, &server, Value::Null);
    run_turn(&host, "first", "", json!([echo(&server)]));
    assert_eq!(fixture.oauth.refreshes.load(Ordering::SeqCst), 0);

    // The server refuses the token that ran out; Jet renews it once and the call goes through.
    fixture.oauth.expire_access();
    let renewed = run_turn(&host, "renewed", "", json!([echo(&server)]));
    assert_eq!(renewed[0]["isError"], false, "{}", renewed[0]);
    assert_eq!(fixture.oauth.refreshes.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.app.calls.load(Ordering::SeqCst), 2);
    assert_eq!(listed(&owner)["state"], "connected");

    // A token about to run out is renewed before Jet sends it, with no refusal first.
    fixture.oauth.expires_in.store(2, Ordering::SeqCst);
    fixture.oauth.expire_access();
    run_turn(&host, "short", "", json!([echo(&server)]));
    assert_eq!(fixture.oauth.refreshes.load(Ordering::SeqCst), 2);
    std::thread::sleep(std::time::Duration::from_millis(1100));
    let early = run_turn(&host, "early", "", json!([echo(&server)]));
    assert_eq!(early[0]["isError"], false, "{}", early[0]);
    assert_eq!(fixture.oauth.refreshes.load(Ordering::SeqCst), 3);
    assert_eq!(fixture.app.calls.load(Ordering::SeqCst), 4);

    // The user revoked Jet at the provider: the server needs a new sign-in, and says why.
    fixture.oauth.expire_access();
    fixture.oauth.revoke_refresh();
    let refused = run_turn(&host, "revoked", "", json!([echo(&server)]));
    assert_eq!(refused[0]["isError"], true, "{}", refused[0]);
    assert_eq!(fixture.app.calls.load(Ordering::SeqCst), 4);
    let ended = listed(&owner);
    assert_eq!(
        (&ended["state"], &ended["signedIn"]),
        (&json!("needs_key"), &json!(false)),
        "{ended}"
    );
    assert_eq!(
        ended["reason"],
        "the sign-in to 127.0.0.1 was ended at the provider; sign in again in Settings, under MCP",
    );
    run_turn(&host, "after", "", json!([{"tool":"apps_list"}]));
    assert!(system_prompt(&host).contains("Not callable now: the user must sign in"));
}

#[test]
fn a_return_with_a_wrong_or_used_state_or_for_another_user_is_refused_and_one_after_the_access_cookie_ran_out_completes()
 {
    let fixture = Fixture::oauth();
    let host = host();
    let owner = host.owner();
    let server = add(&owner, &fixture);
    let (_, started) = start(&owner, &server, Value::Null);
    let back = approve(started["address"].as_str().unwrap());
    let refused = |cookie: &str, address: &str| {
        let (status, _, page) = come_back(&host, cookie, address);
        assert_eq!(status, 400, "{page}");
        assert!(
            page.contains("already used, ran out, or belongs to another account"),
            "{page}"
        );
        let still = listed(&owner);
        assert_eq!(
            (&still["signedIn"], &still["state"]),
            (&json!(false), &json!("needs_key")),
            "{still}"
        );
    };

    let mut wrong = back.clone();
    let code = back
        .query_pairs()
        .find(|(key, _)| key == "code")
        .unwrap()
        .1
        .into_owned();
    wrong
        .query_pairs_mut()
        .clear()
        .append_pair("code", &code)
        .append_pair("state", "not-the-state");
    refused(&owner.cookie, wrong.as_str());
    let colleague = host.sign_in_as("admin1@gmail.com");
    refused(&colleague.cookie, back.as_str());
    assert_eq!(
        colleague
            .post(&path(&server, "/signin"), json!({"client":null}))
            .0,
        404
    );

    // The owner's access cookie ran out while they signed in: the browser sends only the refresh
    // cookie, which reaches only the sign-in endpoints. Jet sends it through the sign-in page, which
    // renews the sign-in and comes back.
    let refresh_only: String = owner
        .cookie
        .split("; ")
        .filter(|pair| pair.starts_with("jet_refresh="))
        .collect();
    let (status, location, _) = come_back(&host, &refresh_only, back.as_str());
    assert_eq!(status, 303);
    let signin = url::Url::parse(&format!("{}{}", host.url, location.unwrap())).unwrap();
    assert_eq!(signin.path(), "/signin/");
    let next = signin
        .query_pairs()
        .find(|(key, _)| key == "next")
        .unwrap()
        .1
        .into_owned();
    let renewed = agent()
        .post(format!("{}/api/auth/refresh", host.url))
        .header("cookie", &refresh_only)
        .header("origin", &host.origin)
        .send_empty()
        .unwrap();
    assert_eq!(renewed.status(), 200);
    let cookie = cookie_header(&renewed);
    let (status, _, page) = come_back(&host, &cookie, &format!("{}{next}", host.url));
    assert_eq!(status, 200, "{page}");
    assert!(page.contains("Signed in to Team wiki"), "{page}");
    assert_eq!(listed(&owner)["state"], "connected");

    // The same return a second time finds nothing to finish.
    let (status, _, page) = come_back(&host, &cookie, back.as_str());
    assert_eq!(status, 400, "{page}");
    assert_eq!(
        *fixture.oauth.refusals.lock().unwrap(),
        Vec::<String>::new()
    );
}

#[test]
fn a_server_that_does_not_register_clients_signs_in_with_a_pasted_client_and_signs_out() {
    let fixture = Fixture::oauth();
    fixture.oauth.registration.store(false, Ordering::SeqCst);
    let host = logged_host();
    let owner = host.owner();
    let server = add(&owner, &fixture);
    let (status, refused) = start(&owner, &server, Value::Null);
    assert_eq!(
        (status, &refused["kind"]),
        (409, &json!("noRegistration")),
        "{refused}"
    );
    assert!(
        refused["message"]
            .as_str()
            .unwrap()
            .contains("paste its client id"),
        "{refused}"
    );
    let listing = owner.get("/api/mcp/servers");
    let redirect = listing["redirectAddress"].clone();
    assert_eq!(redirect, format!("{}/mcp-signin/return", host.url));
    for provider in listing["providers"].as_array().unwrap() {
        let note = provider["note"].as_str().unwrap();
        assert!(
            !note.contains("cannot connect yet") && !note.contains("Until Jet can"),
            "{note}"
        );
    }

    fixture.oauth.add_client(
        "console-client",
        Some("console-secret-5521"),
        redirect.as_str().unwrap(),
    );
    let client = json!({"clientId":"console-client","clientSecret":"console-secret-5521"});
    let page = sign_in(&host, &owner, &server, client);
    assert!(page.contains("Signed in to Team wiki"), "{page}");
    assert_eq!(listed(&owner)["state"], "connected");

    let (status, out) = owner.delete(&path(&server, "/signin"));
    assert_eq!(status, 200, "{out}");
    assert_eq!(
        (&out["state"], &out["signedIn"]),
        (&json!("needs_key"), &json!(false)),
        "{out}"
    );
    let refused = run_turn(&host, "signed-out", "", json!([echo(&server)]));
    assert_eq!(refused[0]["isError"], true, "{}", refused[0]);
    assert_eq!(fixture.app.calls.load(Ordering::SeqCst), 0);

    // Signing in again uses the client already given.
    sign_in(&host, &owner, &server, Value::Null);
    assert_eq!(listed(&owner)["state"], "connected");

    let log = std::fs::read_to_string(host.dir.path().join(LOG_FILE)).unwrap();
    let database = host.database_bytes();
    for secret in fixture.oauth.secrets() {
        assert!(!log.contains(&secret), "{secret} in the log");
        assert!(!out.to_string().contains(&secret));
        assert!(
            !database
                .windows(secret.len())
                .any(|bytes| bytes == secret.as_bytes()),
            "{secret} in the database"
        );
    }
    assert_eq!(
        *fixture.oauth.refusals.lock().unwrap(),
        Vec::<String>::new()
    );
}

#[test]
fn a_failure_seen_while_listing_or_describing_tools_changes_the_servers_state() {
    let fixture = Fixture::guarded("first-key");
    let host = host();
    let owner = host.owner();
    let body = json!({"provider":"custom","name":"Mail","url":format!("{}mcp", fixture.url),"key":{"kind":"bearer","token":"first-key"}});
    let server = owner.post("/api/mcp/servers", body).1;
    assert_eq!(server["state"], "connected", "{server}");

    // A new start has no connection kept, so the search connects and sees the refusal.
    let host = host.restart();
    let owner = host.owner();
    fixture.require("rotated-key");
    let search = run_turn(
        &host,
        "search",
        "",
        json!([{"tool":"tools_search","arguments":{"query":"echo"}}]),
    );
    assert_eq!(
        search[0]["structuredContent"]["tools"],
        json!([]),
        "{}",
        search[0]
    );
    let failed = listed(&owner);
    assert_eq!(failed["state"], "failed", "{failed}");
    assert!(
        failed["reason"]
            .as_str()
            .unwrap()
            .contains("refused the key"),
        "{failed}"
    );

    fixture.require("first-key");
    assert_eq!(
        owner.post(&path(&server, "/test"), json!({})).1["state"],
        "connected"
    );
    let host = host.restart();
    let owner = host.owner();
    fixture.require("rotated-key");
    let describe =
        json!([{"tool":"tools_describe","arguments":{"appId":server["id"],"tool":"echo"}}]);
    let described = run_turn(&host, "describe", "", describe);
    assert_eq!(described[0]["isError"], true, "{}", described[0]);
    assert_eq!(listed(&owner)["state"], "failed");
}
