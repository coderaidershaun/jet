//! Prove, through the real host and two signed-in users, that the page's file routes list a
//! user's files across chats, change, share, release, restore, delete and zip them, tell only that
//! user's pages, and answer another user's file as a missing one.
use super::{
    chats::{add_chat, main_chat, run_turn},
    objectives::{data, database},
    pane::listen,
    support::{Host, User, agent, host},
};
use serde_json::{Value, json};
use std::{io::Read, sync::mpsc, time::Duration};

const SECOND: &str = "admin1@gmail.com";

/// Any request with the sign-in and `Origin` of the user's page: its status, content type and body.
fn call(user: &User, method: &str, path: &str, body: Option<Value>) -> (u16, String, Vec<u8>) {
    let url = format!("{}{path}", user.url);
    let agent = agent();
    let request = match method {
        "GET" => agent.get(&url).force_send_body(),
        "POST" => agent.post(&url),
        "PATCH" => agent.patch(&url),
        "DELETE" => agent.delete(&url).force_send_body(),
        other => panic!("{other} is not used here"),
    }
    .header("cookie", &user.cookie)
    .header("origin", &user.origin)
    .header("content-type", "application/json");
    let mut response = match body {
        Some(body) => request.send(body.to_string()),
        None => request.send_empty(),
    }
    .unwrap();
    let kind = response
        .headers()
        .get("content-type")
        .map(|value| value.to_str().unwrap().to_owned())
        .unwrap_or_default();
    let bytes = response.body_mut().read_to_vec().unwrap();
    (response.status().as_u16(), kind, bytes)
}

fn json_call(user: &User, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
    let (status, _, bytes) = call(user, method, path, body);
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// Jet makes a text file in the chat and gives its id.
fn make(host: &Host, user: &User, chat: i64, name: &str, content: &str) -> String {
    let command = json!({"action":"create","name":name,"content":content,"context":"A file."});
    let made = run_turn(
        host,
        user,
        chat,
        &format!("make-{name}-{content}"),
        json!([{"tool":"files_update","arguments":{"command":command}}]),
    );
    data(&made[0])["file"]["id"].as_str().unwrap().to_owned()
}

fn listed(user: &User) -> Value {
    user.get("/api/files")
}

/// How many `paneChanged` events arrive within the next second.
fn pane_changes(events: &mpsc::Receiver<Value>) -> usize {
    let mut count = 0;
    while let Ok(event) = events.recv_timeout(Duration::from_secs(1)) {
        if event["kind"] == "event" && event["data"]["event"]["kind"] == "paneChanged" {
            count += 1;
        }
    }
    count
}

/// The entries of a zip, in order, with their contents.
fn entries(bytes: Vec<u8>) -> Vec<(String, String)> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    (0..zip.len())
        .map(|at| {
            let mut entry = zip.by_index(at).unwrap();
            assert_eq!(entry.compression(), zip::CompressionMethod::Deflated);
            let mut text = String::new();
            entry.read_to_string(&mut text).unwrap();
            (entry.name().unwrap().into_owned(), text)
        })
        .collect()
}

#[test]
fn delete_takes_a_file_out_of_every_chat() {
    let host = host();
    let (owner, other) = (host.owner(), host.sign_in_as(SECOND));
    let (first, second) = (main_chat(&owner), add_chat(&owner));
    let id = make(&host, &owner, first, "summary.html", "<p>one</p>");
    let path = format!("/api/files/{id}");
    assert_eq!(
        json_call(
            &owner,
            "POST",
            &format!("{path}/chats"),
            Some(json!({"chat": second}))
        )
        .0,
        200
    );

    let (status, renamed) = json_call(
        &owner,
        "PATCH",
        &path,
        Some(json!({"name":"kite-summary.html"})),
    );
    assert_eq!(
        (status, &renamed["name"]),
        (200, &json!("kite-summary.html"))
    );
    let (status, refused) = json_call(&owner, "PATCH", &path, Some(json!({"name":"kite.txt"})));
    assert_eq!(status, 400, "{refused}");
    assert_eq!(listed(&owner)["files"][0]["chats"], json!([first, second]));
    assert!(listed(&owner)["usedBytes"].as_u64().unwrap() > 0);

    let (owner_events, other_events) = (listen(&owner), listen(&other));
    assert_eq!(call(&owner, "DELETE", &path, None).0, 204);
    assert_eq!(
        pane_changes(&owner_events),
        1,
        "one paneChanged to the owner"
    );
    assert_eq!(pane_changes(&other_events), 0, "none to another user");
    let library = listed(&owner);
    assert_eq!(
        (&library["files"], &library["usedBytes"]),
        (&json!([]), &json!(0))
    );
    let db = database(&host);
    for table in ["files", "file_chats", "file_versions"] {
        let count: i64 = db
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "{table}");
    }
    assert_eq!(call(&owner, "DELETE", &path, None).0, 404);
}

#[test]
fn share_then_remove_returns_to_one_chat() {
    let host = host();
    let owner = host.owner();
    let (first, second) = (main_chat(&owner), add_chat(&owner));
    let id = make(&host, &owner, first, "kite.md", "# Kite");

    let events = listen(&owner);
    let (status, shared) = json_call(
        &owner,
        "POST",
        &format!("/api/files/{id}/chats"),
        Some(json!({"chat": second})),
    );
    assert_eq!((status, &shared["chats"]), (200, &json!([first, second])));
    assert_eq!(pane_changes(&events), 1);

    let (status, removed) = json_call(
        &owner,
        "DELETE",
        &format!("/api/files/{id}/chats/{second}"),
        None,
    );
    assert_eq!((status, &removed["chats"]), (200, &json!([first])));
    assert_eq!(pane_changes(&events), 1);
    assert_eq!(listed(&owner)["files"][0]["chats"], json!([first]));
}

#[test]
fn last_chat_cannot_release_its_file() {
    let host = host();
    let owner = host.owner();
    let chat = main_chat(&owner);
    let id = make(&host, &owner, chat, "kite.md", "# Kite");
    let before = listed(&owner);

    let events = listen(&owner);
    let (status, refused) = json_call(
        &owner,
        "DELETE",
        &format!("/api/files/{id}/chats/{chat}"),
        None,
    );
    assert_eq!(status, 409);
    assert_eq!(
        refused["message"],
        "This is the only chat that holds this file. Delete the file instead."
    );
    assert_eq!(pane_changes(&events), 0);
    assert_eq!(listed(&owner), before);
}

#[test]
fn archive_names_repeats_with_a_number() {
    let host = host();
    let owner = host.owner();
    let chat = main_chat(&owner);
    let older = make(&host, &owner, chat, "notes.txt", "older");
    let newer = make(&host, &owner, chat, "notes.txt", "newer");
    make(&host, &owner, chat, "other.md", "not chosen");

    let (status, kind, bytes) = call(
        &owner,
        "POST",
        "/api/files/archive",
        Some(json!({"ids":[older, newer]})),
    );
    assert_eq!((status, kind.as_str()), (200, "application/zip"));
    assert_eq!(
        entries(bytes),
        [
            ("notes.txt".to_owned(), "newer".to_owned()),
            ("notes (2).txt".to_owned(), "older".to_owned()),
        ]
    );

    let mut everything = agent()
        .get(format!("{}/api/files/archive", owner.url))
        .header("cookie", &owner.cookie)
        .call()
        .unwrap();
    let disposition = everything.headers()["content-disposition"]
        .to_str()
        .unwrap();
    assert!(
        disposition.starts_with("attachment; filename=\"Jet files 20"),
        "{disposition}"
    );
    let bytes = everything.body_mut().read_to_vec().unwrap();
    assert_eq!(entries(bytes).len(), 3);
}

#[test]
fn restore_writes_a_new_version() {
    let host = host();
    let owner = host.owner();
    let chat = main_chat(&owner);
    let id = make(&host, &owner, chat, "kite.txt", "one");
    let write = |content: &str| json!({"tool":"files_update","arguments":{"command":{"action":"write","id":id,"content":content}}});
    run_turn(
        &host,
        &owner,
        chat,
        "writes",
        json!([write("two"), write("three")]),
    );

    let versions = owner.get(&format!("/api/files/{id}/versions"));
    let numbers: Vec<&Value> = versions
        .as_array()
        .unwrap()
        .iter()
        .map(|v| &v["version"])
        .collect();
    assert_eq!(numbers, [&json!(3), &json!(2), &json!(1)]);
    assert_eq!(versions[1]["bytes"], 3);

    let events = listen(&owner);
    let (status, restored) = json_call(
        &owner,
        "POST",
        &format!("/api/files/{id}/restore"),
        Some(json!({"version": 2})),
    );
    assert_eq!(status, 200, "{restored}");
    assert_eq!(
        (&restored["version"], &restored["earlier"]),
        (&json!(4), &json!([3, 2, 1]))
    );
    assert_eq!(pane_changes(&events), 1);
    assert_eq!(
        call(&owner, "GET", &format!("/api/files/{id}"), None).2,
        b"two"
    );
}

#[test]
fn file_routes_hide_other_users_files() {
    let host = host();
    let (owner, other) = (host.owner(), host.sign_in_as(SECOND));
    let (chat, theirs) = (main_chat(&owner), main_chat(&other));
    let id = make(&host, &owner, chat, "page.html", "<p>one</p>");
    let write = json!({"tool":"files_update","arguments":{"command":{"action":"write","id":id,"content":"<p>two</p>"}}});
    run_turn(&host, &owner, chat, "write", json!([write]));
    let before = listed(&owner);

    let file = format!("/api/files/{id}");
    let routes = [
        ("GET", file.clone(), None),
        ("GET", format!("{file}/view"), None),
        ("GET", format!("{file}/frame"), None),
        ("GET", format!("{file}/versions"), None),
        ("PATCH", file.clone(), Some(json!({"name":"mine.html"}))),
        (
            "POST",
            format!("{file}/chats"),
            Some(json!({"chat": theirs})),
        ),
        ("POST", format!("{file}/chats"), Some(json!({"chat": chat}))),
        ("DELETE", format!("{file}/chats/{chat}"), None),
        (
            "POST",
            format!("{file}/restore"),
            Some(json!({"version": 1})),
        ),
        (
            "POST",
            "/api/files/archive".to_owned(),
            Some(json!({"ids":[id]})),
        ),
        ("DELETE", file.clone(), None),
    ];
    for (method, path, body) in routes {
        assert_eq!(call(&other, method, &path, body).0, 404, "{method} {path}");
    }
    assert_eq!(listed(&other)["files"], json!([]));
    let (status, _, bytes) = call(&other, "GET", "/api/files/archive", None);
    assert_eq!((status, entries(bytes).len()), (200, 0));
    assert_eq!(listed(&owner), before, "nothing changed");
}
