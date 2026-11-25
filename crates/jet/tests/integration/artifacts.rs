//! Prove, through the real host with the provider stand-in and two signed-in users, that the files
//! of a chat are artifacts: Jet is told them in an index, writes them, keeps five earlier versions,
//! shares one file among chats, and serves a page only inside a sandbox; and that no user, and no
//! check, reaches what it must not.
//!
//! An upload over 32 MiB is refused with its reason in `attachments.rs`.
use super::{
    attachments::fetch,
    chats::{add_chat, main_chat, run_turn, run_turn_with},
    checks::{DUE, objective_with, outcomes, script, wait_for_runs},
    objectives::{data, database, error_kind},
    support::{agent, host, host_env, wait_file},
};
use serde_json::{Value, json};

const SECOND: &str = "admin1@gmail.com";

fn update(command: Value) -> Value {
    json!({"tool":"files_update","arguments":{"command":command}})
}

fn read(id: &str) -> Value {
    json!({"tool":"files_read","arguments":{"id":id}})
}

fn text(result: &Value) -> &str {
    data(result)["text"].as_str().unwrap()
}

fn told(host: &super::support::Host) -> String {
    std::fs::read_to_string(host.dir.path().join("facade-prompt.txt")).unwrap()
}

fn rows(host: &super::support::Host, sql: &str) -> i64 {
    database(host).query_row(sql, [], |row| row.get(0)).unwrap()
}

#[test]
fn a_file_sent_in_a_chat_is_noted_read_changed_and_restored_and_five_versions_are_kept() {
    let host = host();
    let owner = host.owner();
    let made = run_turn(
        &host,
        &owner,
        main_chat(&owner),
        "objective",
        json!([super::objectives::create(json!([{"kind":"jet"}]))]),
    );
    let chat = data(&made[0])["objective"]["chatId"].as_i64().unwrap();
    let (status, upload) = owner.upload("kite.txt", b"Kite plan\nspan 2m\n");
    assert_eq!(status, 200, "{upload}");
    let id = upload["id"].as_str().unwrap();

    let note = "The first sketch of the kite plan.";
    let results = run_turn_with(
        &host,
        &owner,
        chat,
        "sent",
        json!([
            update(json!({"action":"describe","id":id,"context":note})),
            json!({"tool":"files_list","arguments":{}}),
            read(id)
        ]),
        &[id],
    );
    let prompt = told(&host);
    assert!(prompt.contains("<chat_files>"), "{prompt}");
    assert!(
        prompt.contains("kite.txt")
            && prompt.contains("from the user")
            && prompt.contains("(none yet"),
        "a file sent with the message is already in its index: {prompt}"
    );
    assert_eq!(data(&results[0])["change"], "described");
    let listed = &data(&results[1])["files"][0];
    assert_eq!(listed["id"], id);
    assert_eq!(listed["context"], note);
    assert_eq!(listed["by"], "user");
    assert_eq!(listed["chats"], json!([chat]));
    assert!(text(&results[2]).contains("span 2m"));

    // Changes: the third read is after a restore, and the sixth change keeps five versions only.
    let results = run_turn(
        &host,
        &owner,
        chat,
        "changes",
        json!([
            update(json!({"action":"write","id":id,"content":"two"})),
            update(json!({"action":"write","id":id,"content":"three"})),
            read(id),
            update(json!({"action":"restore","id":id})),
            read(id),
            update(json!({"action":"write","id":id,"content":"five"})),
            update(json!({"action":"write","id":id,"content":"six"})),
            update(json!({"action":"write","id":id,"content":"seven"})),
            update(json!({"action":"restore","id":id,"version":1})),
            read(id),
        ]),
    );
    assert!(
        told(&host).contains(note),
        "the next turn's index carries the note"
    );
    assert_eq!(text(&results[2]), "three");
    assert_eq!(data(&results[3])["restored"], 2);
    assert_eq!(text(&results[4]), "two");
    let last = &data(&results[7])["file"];
    assert_eq!(
        (last["version"].as_u64(), &last["earlier"]),
        (Some(7), &json!([6, 5, 4, 3, 2, 1])),
        "the original the user sent is kept beside the newest five"
    );
    let back = &data(&results[8]);
    assert_eq!(back["restored"], 1);
    assert_eq!(
        (back["file"]["version"].as_u64(), &back["file"]["earlier"]),
        (Some(8), &json!([7, 6, 5, 4, 3, 1]))
    );
    assert!(
        text(&results[9]).contains("span 2m"),
        "the original is back"
    );
    let pane = owner.get("/api/pane");
    assert_eq!(pane["artifacts"][0]["id"], id, "{pane}");
}

#[test]
fn a_page_jet_makes_is_served_only_inside_a_sandbox_and_a_sandboxed_request_is_refused() {
    let host = host();
    let owner = host.owner();
    let page =
        "<html><head><title>Kite plan</title></head><body><script>1</script>hi</body></html>";
    let chat = main_chat(&owner);
    let results = run_turn(
        &host,
        &owner,
        chat,
        "page",
        json!([update(
            json!({"action":"create","name":"summary.html","content":page,"context":"One-page summary."})
        )]),
    );
    let file = &data(&results[0])["file"];
    let id = file["id"].as_str().unwrap();
    assert_eq!(
        (file["by"].as_str(), file["kind"].as_str()),
        (Some("jet"), Some("html"))
    );
    assert!(
        file["details"].as_str().unwrap().contains("Kite plan"),
        "{file}"
    );
    let saved =
        &owner.get(&format!("/api/snapshot?chat={chat}"))["history"][1]["tools"][0]["result"];
    assert_eq!(
        saved["file"]["id"], id,
        "the card is drawn from the saved result"
    );

    for path in [format!("/api/files/{id}/view"), format!("/api/files/{id}")] {
        let (status, _, policy, body) = fetch(&host, &path);
        assert_eq!(status, 200, "{path}");
        assert_eq!(body, page.as_bytes());
        assert!(
            policy.starts_with("sandbox allow-scripts;") && policy.contains("default-src 'none'"),
            "{policy}"
        );
        assert!(!policy.contains("allow-same-origin"), "{policy}");
    }

    // A tab never holds the bare page: it is sent to the frame, which holds it and cannot be left.
    let tab = agent()
        .get(format!("{}/api/files/{id}/view", host.url))
        .header("cookie", &host.cookie)
        .header("sec-fetch-dest", "document")
        .header("sec-fetch-mode", "navigate")
        .header("sec-fetch-site", "none")
        .call()
        .unwrap();
    assert_eq!(tab.status().as_u16(), 303);
    assert_eq!(
        tab.headers()["location"],
        format!("/api/files/{id}/frame").as_str()
    );
    let mut frame = host
        .signed(agent().get(format!("{}/api/files/{id}/frame", host.url)))
        .call()
        .unwrap();
    assert_eq!(frame.status().as_u16(), 200);
    for (name, value) in [
        ("content-type", "text/html; charset=utf-8"),
        ("x-content-type-options", "nosniff"),
        ("cache-control", "private, no-cache"),
        (
            "content-security-policy",
            "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; frame-ancestors 'self'",
        ),
    ] {
        assert_eq!(frame.headers()[name], value, "{name}");
    }
    assert_eq!(
        frame.body_mut().read_to_string().unwrap(),
        format!(
            "<!doctype html><meta charset=\"utf-8\"><title>File</title><style>html,body,iframe{{display:block;width:100%;height:100%;margin:0;border:0}}</style><iframe sandbox=\"allow-scripts\" src=\"/api/files/{id}/view\"></iframe>"
        )
    );

    // What a sandboxed page's own request looks like: the cookie, a null origin, another site.
    for path in ["/api/pane".to_owned(), format!("/api/files/{id}")] {
        let status = agent()
            .get(format!("{}{path}", host.url))
            .header("cookie", &host.cookie)
            .header("origin", "null")
            .header("sec-fetch-site", "cross-site")
            .header("sec-fetch-mode", "cors")
            .call()
            .unwrap()
            .status()
            .as_u16();
        assert_eq!(status, 403, "{path}");
    }
}

#[test]
fn a_shared_file_is_one_file_in_each_chat_and_only_its_owner_reaches_it() {
    let host = host();
    let (owner, other) = (host.owner(), host.sign_in_as(SECOND));
    let (keeper, shared_to) = (add_chat(&owner), add_chat(&owner));
    let made = run_turn(
        &host,
        &owner,
        keeper,
        "make",
        json!([
            update(
                json!({"action":"create","name":"own.txt","content":"only here","context":"Stays."})
            ),
            update(
                json!({"action":"create","name":"shared.md","content":"# one","context":"Goes."})
            ),
            update(
                json!({"action":"create","name":"third.md","content":"# three","context":"Stays shared."})
            ),
        ]),
    );
    let id_of = |at: usize| data(&made[at])["file"]["id"].as_str().unwrap().to_owned();
    let (own, shared, third) = (id_of(0), id_of(1), id_of(2));
    let results = run_turn(
        &host,
        &owner,
        keeper,
        "share",
        json!([
            update(json!({"action":"share","id":shared,"chat":shared_to})),
            update(json!({"action":"share","id":third,"chat":shared_to})),
            update(json!({"action":"describe","id":shared,"context":"Both chats."})),
        ]),
    );
    assert_eq!(data(&results[0])["chat"]["id"], shared_to);
    assert_eq!(
        data(&results[0])["file"]["chats"],
        json!([keeper, shared_to])
    );

    // Chat B sees it in its index, not the other file, and a write in either shows in the other.
    run_turn(
        &host,
        &owner,
        shared_to,
        "in-b",
        json!([update(
            json!({"action":"write","id":shared,"content":"# from b"})
        )]),
    );
    let prompt = told(&host);
    assert!(
        prompt.contains("shared.md") && prompt.contains("also in 1 other chat"),
        "{prompt}"
    );
    assert!(!prompt.contains("own.txt"), "{prompt}");
    let results = run_turn(
        &host,
        &owner,
        keeper,
        "in-a",
        json!([
            read(&shared),
            update(json!({"action":"write","id":shared,"content":"# from a"}))
        ]),
    );
    assert_eq!(text(&results[0]), "# from b");
    let results = run_turn(
        &host,
        &owner,
        shared_to,
        "in-b-again",
        json!([read(&shared)]),
    );
    assert_eq!(text(&results[0]), "# from a");

    // Another user: nothing of it can be listed, read, changed, removed, shared or opened.
    let theirs = main_chat(&other);
    let results = run_turn(
        &host,
        &other,
        theirs,
        "stranger",
        json!([
            json!({"tool":"files_list","arguments":{"chat":keeper}}),
            read(&shared),
            update(json!({"action":"write","id":shared,"content":"mine"})),
            update(json!({"action":"describe","id":shared,"context":"mine"})),
            update(json!({"action":"remove","id":shared})),
            update(json!({"action":"share","id":shared,"chat":theirs})),
        ]),
    );
    for result in &results {
        assert_eq!(result["isError"], true, "{result}");
    }
    assert_eq!(error_kind(&results[0]), "notFound");
    for path in [
        format!("/api/files/{shared}"),
        format!("/api/files/{shared}/view"),
    ] {
        assert_eq!(other.fetch(&path).0, 404, "{path}");
    }
    assert_eq!(other.fetch(&format!("/api/files/{shared}/frame")).0, 404);
    assert_eq!(other.get("/api/pane")["artifacts"], json!([]));
    let results = run_turn(&host, &owner, shared_to, "still", json!([read(&shared)]));
    assert_eq!(
        text(&results[0]),
        "# from a",
        "the stranger changed nothing"
    );

    // A chat that holds nothing may not change the file, but may bring it in and then change it.
    let empty = add_chat(&owner);
    let results = run_turn(
        &host,
        &owner,
        empty,
        "bring-in",
        json!([
            update(json!({"action":"write","id":shared,"content":"no"})),
            update(json!({"action":"remove","id":shared})),
            update(json!({"action":"share","id":shared,"chat":empty})),
            update(json!({"action":"write","id":shared,"content":"# from c"})),
        ]),
    );
    assert_eq!(error_kind(&results[0]), "invalidRequest");
    assert_eq!(error_kind(&results[1]), "invalidRequest");
    assert_eq!(
        data(&results[3])["file"]["chats"],
        json!([keeper, shared_to, empty])
    );

    // The keeper renames it (but not to another kind) and lets go of it: the others keep it.
    let results = run_turn(
        &host,
        &owner,
        keeper,
        "let-go",
        json!([
            update(json!({"action":"rename","id":shared,"name":"shared.txt"})),
            update(json!({"action":"rename","id":shared,"name":"renamed.md"})),
            update(json!({"action":"remove","id":shared})),
            json!({"tool":"files_list","arguments":{}}),
        ]),
    );
    assert_eq!(error_kind(&results[0]), "invalidRequest");
    assert_eq!(data(&results[1])["from"], "shared.md");
    assert_eq!(data(&results[1])["file"]["name"], "renamed.md");
    let removed = data(&results[2]);
    assert_eq!(
        (&removed["deleted"], &removed["chats"]),
        (&json!(false), &json!([shared_to, empty]))
    );
    let listed: Vec<&Value> = data(&results[3])["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| &file["id"])
        .collect();
    assert!(!listed.contains(&&json!(shared)), "{listed:?}");
    let results = run_turn(
        &host,
        &owner,
        shared_to,
        "kept",
        json!([
            read(&shared),
            update(json!({"action":"write","id":shared,"content":"# kept"}))
        ]),
    );
    assert_eq!(text(&results[0]), "# from c");

    // Deleting the keeper takes its own file and leaves the shared one with the chat that holds it.
    let deleted = agent()
        .delete(format!("{}/api/chats/{keeper}", owner.url))
        .header("cookie", &owner.cookie)
        .header("origin", &owner.origin)
        .call()
        .unwrap();
    assert_eq!(deleted.status().as_u16(), 200);
    assert_eq!(owner.fetch(&format!("/api/files/{own}")).0, 404);
    assert_eq!(
        rows(
            &host,
            &format!("SELECT count(*) FROM files WHERE id = '{own}'")
        ),
        0
    );
    let results = run_turn(
        &host,
        &owner,
        shared_to,
        "after-delete",
        json!([
            read(&third),
            update(json!({"action":"write","id":third,"content":"# last"}))
        ]),
    );
    assert_eq!(text(&results[0]), "# three");
    assert_eq!(data(&results[1])["file"]["chats"], json!([shared_to]));

    // Forget in the last holder removes a file; one that another chat holds stays there.
    let forget = |chat: i64| {
        owner
            .post(&format!("/api/chat/forget?chat={chat}"), json!({}))
            .0
    };
    assert_eq!(forget(shared_to), 200);
    assert_eq!(owner.fetch(&format!("/api/files/{third}")).0, 404);
    assert_eq!(owner.fetch(&format!("/api/files/{shared}")).0, 200);
    assert_eq!(forget(empty), 200);
    assert_eq!(owner.fetch(&format!("/api/files/{shared}")).0, 404);
    assert_eq!(rows(&host, "SELECT count(*) FROM files"), 0);
    assert_eq!(rows(&host, "SELECT count(*) FROM file_versions"), 0);
}

#[test]
fn a_check_is_told_the_files_and_may_read_them_but_changes_none() {
    let host = host();
    let owner = host.owner();
    let (_, chat) = objective_with(&host, &owner, "made", json!([{"kind":"jet"}]));
    let (_, upload) = owner.upload("kite.txt", b"Kite plan\n");
    let id = upload["id"].as_str().unwrap();
    run_turn_with(
        &host,
        &owner,
        chat,
        "sent",
        json!([update(
            json!({"action":"describe","id":id,"context":"Plan."})
        )]),
        &[id],
    );

    let _ = std::fs::remove_file(host.dir.path().join("facade-results.json"));
    script(
        &host,
        json!([
            read(id),
            update(json!({"action":"write","id":id,"content":"changed by a check"})),
            json!({"tool":"files_export","arguments":{"format":"markdown","title":"T","markdown":"x"}}),
            json!({"tool":"files_list","arguments":{}}),
            {"say": "mood: neutral\nI looked."}
        ]),
    );
    host.set_clock(DUE);
    wait_for_runs(&host, 1);
    assert_eq!(outcomes(&host), ["spoke"]);
    let prompt = told(&host);
    assert!(
        prompt.starts_with("[Check.")
            && prompt.contains("<chat_files>")
            && prompt.contains("kite.txt"),
        "{prompt}"
    );
    let results = wait_file(&host, "facade-results.json");
    assert!(text(&results[0]).contains("Kite plan"));
    assert_eq!(error_kind(&results[1]), "checkIsReadOnly");
    assert_eq!(error_kind(&results[2]), "checkIsReadOnly");
    assert_eq!(data(&results[3])["files"][0]["version"], 1);
    let pane = owner.get("/api/pane");
    assert_eq!(pane["artifacts"].as_array().unwrap().len(), 1, "{pane}");
    assert_eq!(pane["artifacts"][0]["version"], 1);
}

#[test]
fn a_user_over_the_limit_is_refused_with_the_reason_and_another_user_is_not() {
    let host = host_env(&[("JET_TEST_USER_FILE_BYTES", "3000")]);
    let (owner, other) = (host.owner(), host.sign_in_as(SECOND));
    let reason =
        "Your files in Jet take more than 1 MB. Remove a file or forget a chat to free room.";

    assert_eq!(owner.upload("a.txt", &[b'a'; 1200]).0, 200);
    let (status, refused) = owner.upload("b.txt", &[b'b'; 2500]);
    assert_eq!((status, refused["message"].as_str()), (413, Some(reason)));
    assert_eq!(other.upload("b.txt", &[b'b'; 2500]).0, 200);

    let chat = main_chat(&owner);
    let results = run_turn(
        &host,
        &owner,
        chat,
        "limits",
        json!([
            update(
                json!({"action":"create","name":"big.txt","content":"c".repeat(2000),"context":"Too big."})
            ),
            update(
                json!({"action":"create","name":"small.txt","content":"c".repeat(500),"context":"Fits."})
            ),
        ]),
    );
    assert_eq!(results[0]["structuredContent"]["error"]["message"], reason);
    let small = data(&results[1])["file"]["id"].as_str().unwrap();
    let results = run_turn(
        &host,
        &owner,
        chat,
        "write",
        json!([update(
            json!({"action":"write","id":small,"content":"d".repeat(2000)})
        )]),
    );
    assert_eq!(results[0]["structuredContent"]["error"]["message"], reason);
}
