//! Prove, through the real host and the MCP stand-in that is its own OAuth sign-in server, the
//! edges of a sign-in: another user cannot end it, an end found before a listing shows at once, and a wrong client can be replaced.
use super::{
    mcp_fixture::Fixture,
    mcp_sign_in::{add, echo, listed, path, sign_in, start},
    support::host,
    web::run_turn,
};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

#[test]
fn another_users_refused_key_leaves_the_owners_sign_in_alone() {
    let fixture = Fixture::oauth();
    let host = host();
    let owner = host.owner();
    let server = add(&owner, &fixture);
    sign_in(&host, &owner, &server, Value::Null);
    let colleague = host.sign_in_as("admin1@gmail.com");
    let key = json!({"kind":"bearer","token":"not-yours"});
    assert_eq!(colleague.put(&path(&server, "/key"), key).0, 404);
    assert_eq!(colleague.delete(&path(&server, "/signin")).0, 404);
    let still = listed(&owner);
    assert_eq!(
        (&still["signedIn"], &still["state"]),
        (&json!(true), &json!("connected")),
        "{still}"
    );
    let call = run_turn(&host, "still", "", json!([echo(&server)]));
    assert_eq!(call[0]["isError"], false, "{}", call[0]);
}

#[test]
fn a_sign_in_found_ended_before_a_tool_listing_needs_a_new_sign_in_with_its_reason() {
    let fixture = Fixture::oauth();
    fixture.oauth.expires_in.store(2, Ordering::SeqCst);
    let host = host();
    let owner = host.owner();
    let server = add(&owner, &fixture);
    sign_in(&host, &owner, &server, Value::Null);
    fixture.oauth.revoke_refresh();
    std::thread::sleep(std::time::Duration::from_millis(2100));
    let search = json!([{"tool":"tools_search","arguments":{"query":"echo"}}]);
    run_turn(&host, "search", "", search);
    let ended = listed(&owner);
    assert_eq!(
        (&ended["state"], &ended["signedIn"]),
        (&json!("needs_key"), &json!(false)),
        "{ended}"
    );
    assert_eq!(
        ended["reason"],
        "the sign-in to 127.0.0.1 was ended at the provider; sign in again in Settings, under MCP"
    );
}

#[test]
fn a_client_the_provider_refuses_is_forgotten_and_a_pasted_client_can_be_replaced() {
    let fixture = Fixture::oauth();
    fixture.oauth.registration.store(false, Ordering::SeqCst);
    let host = host();
    let owner = host.owner();
    let server = add(&owner, &fixture);
    let redirect = owner.get("/api/mcp/servers")["redirectAddress"].clone();
    fixture.oauth.add_client(
        "console-client",
        Some("right-secret"),
        redirect.as_str().unwrap(),
    );

    // A wrong secret: the provider refuses the code exchange, and Jet forgets the client.
    let wrong = json!({"clientId":"console-client","clientSecret":"wrong-secret"});
    let (status, started) = start(&owner, &server, wrong);
    assert_eq!(status, 200, "{started}");
    assert_eq!(listed(&owner)["pastedClientId"], "console-client");
    let back = super::mcp_sign_in::approve(started["address"].as_str().unwrap());
    let (status, _, page) = super::mcp_sign_in::come_back(&host, &owner.cookie, back.as_str());
    assert_eq!(status, 502, "{page}");
    assert!(
        page.contains("did not accept the client id or secret"),
        "{page}"
    );
    let forgotten = listed(&owner);
    assert_eq!(
        (&forgotten["pastedClientId"], &forgotten["signedIn"]),
        (&Value::Null, &json!(false)),
        "{forgotten}"
    );
    let (status, asked) = start(&owner, &server, Value::Null);
    assert_eq!(
        (status, &asked["kind"]),
        (409, &json!("noRegistration")),
        "{asked}"
    );

    // A client id with a typo is replaced by pasting the right one.
    let typo = json!({"clientId":"consol-client","clientSecret":"right-secret"});
    assert_eq!(start(&owner, &server, typo).0, 200);
    assert_eq!(listed(&owner)["pastedClientId"], "consol-client");
    let right = json!({"clientId":"console-client","clientSecret":"right-secret"});
    sign_in(&host, &owner, &server, right);
    let signed = listed(&owner);
    assert_eq!(
        (&signed["state"], &signed["pastedClientId"]),
        (&json!("connected"), &json!("console-client")),
        "{signed}"
    );
}
