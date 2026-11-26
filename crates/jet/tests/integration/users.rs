//! Prove through the real host that every signed-in user has a Jet of their own: their own thread,
//! events, notes, settings, apps and files, replies that do not wait on another user's, and the
//! server-wide settings and app addresses that only an admin may touch.
use super::{
    mcp_fixture::Fixture,
    support::{Host, User, host, request},
};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    sync::mpsc,
    time::{Duration, Instant},
};

const SECOND: &str = "admin1@gmail.com";
const THIRD: &str = "admin2@gmail.com";

/// Sends a message as `user` and gives the request's id back.
fn say(user: &User, id: &str, text: &str) -> String {
    let mut message = request(id);
    message["text"] = json!(text);
    let (status, accepted) = user.post("/api/chat/send", message);
    assert_eq!(status, 200, "{accepted}");
    id.to_owned()
}

/// Waits until the user's reply has ended and the thread holds `entries` entries.
fn settled(user: &User, entries: usize) -> Value {
    user.until(|snapshot| {
        snapshot["active"].is_null() && snapshot["history"].as_array().unwrap().len() == entries
    })
}

/// Reads the user's event stream on a thread of its own, from the start of the current epoch.
fn listen(user: &User) -> mpsc::Receiver<Value> {
    let snapshot = user.get("/api/snapshot");
    let epoch = snapshot["epoch"].as_str().unwrap().to_owned();
    let cursor = snapshot["cursor"].as_u64().unwrap();
    let mut response = user.events(&epoch, cursor);
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let reader = BufReader::new(response.body_mut().as_reader());
        for line in reader.lines() {
            let Ok(line) = line else { return };
            if let Some(data) = line.strip_prefix("data: ")
                && sender.send(serde_json::from_str(data).unwrap()).is_err()
            {
                return;
            }
        }
    });
    receiver
}

/// The events received until one names the end of the request `id`.
fn events_until_end(events: &mpsc::Receiver<Value>, id: &str) -> Vec<Value> {
    let mut seen = Vec::new();
    loop {
        let event = events
            .recv_timeout(Duration::from_secs(10))
            .expect("the reply did not end");
        let ended = event["data"]["turn"]["requestId"] == id
            && event["data"]["event"]["kind"] == "finished";
        seen.push(event);
        if ended {
            return seen;
        }
    }
}

#[test]
fn each_user_sees_only_their_own_thread_and_events_and_one_reply_does_not_delay_another() {
    let host = Host::start();
    let (owner, second) = (host.owner(), host.sign_in_as(SECOND));
    let owner_events = listen(&owner);
    let second_events = listen(&second);

    // The owner's reply hangs; the second user's reply still starts and ends at once.
    let hanging = say(&owner, "owner-hang", "hang on the owner's question");
    owner.until(|snapshot| snapshot["active"]["text"] == "Partial browser reply");
    let began = Instant::now();
    let answered = say(&second, "second-hello", "the second user's question");
    let theirs = settled(&second, 2);
    assert!(
        began.elapsed() < Duration::from_secs(5),
        "the second user waited {:?} for the owner's reply",
        began.elapsed()
    );
    assert_eq!(theirs["history"][0]["text"], "the second user's question");
    assert_eq!(theirs["history"][1]["text"], "Partial browser reply");
    let mine = owner.get("/api/snapshot");
    assert_eq!(mine["active"]["identity"]["requestId"], hanging, "{mine}");
    assert_eq!(mine["history"].as_array().unwrap().len(), 1, "{mine}");
    assert_eq!(mine["history"][0]["text"], "hang on the owner's question");
    assert!(!mine.to_string().contains("the second user's question"));
    assert!(!theirs.to_string().contains("the owner's question"));

    // Each event stream carries only its own user's turn.
    let seen = events_until_end(&second_events, &answered);
    assert!(
        seen.iter()
            .all(|event| event["data"]["turn"]["requestId"] != hanging.as_str()),
        "the second user's stream carried the owner's turn: {seen:?}"
    );
    assert_eq!(
        owner
            .post("/api/chat/stop", json!({"requestId": hanging}))
            .0,
        200
    );
    let mut ended = false;
    while let Ok(event) = owner_events.recv_timeout(Duration::from_secs(10)) {
        assert_ne!(
            event["data"]["turn"]["requestId"], answered,
            "the owner's stream carried the second user's turn"
        );
        if event["data"]["event"]["kind"] == "stopped" {
            ended = true;
            break;
        }
    }
    assert!(ended, "the owner's stream did not show the stop");
}

#[test]
fn a_users_name_notes_settings_and_files_stay_theirs_and_a_new_account_starts_empty() {
    let host = Host::start();
    let (owner, second) = (host.owner(), host.sign_in_as(SECOND));

    // A new account that is not the owner's: default settings, empty notes, no entries, no apps.
    let third = host.sign_in_as(THIRD);
    let defaults: Value =
        serde_json::from_str(include_str!("../../ui/bridge/default-settings.json")).unwrap();
    assert_eq!(third.get("/api/settings"), defaults);
    let notes = third.get("/api/memory");
    assert_eq!(
        (&notes["memory"], &notes["user"], &notes["recent"]),
        (&json!(""), &json!(""), &json!(""))
    );
    assert_eq!(third.get("/api/snapshot")["history"], json!([]));
    assert_eq!(third.get("/api/apps"), json!([]));

    let mut settings = owner.get("/api/settings");
    settings["persona"]["name"] = json!("Ada");
    settings["reducedMotion"] = json!(true);
    assert_eq!(owner.put("/api/settings", settings).0, 200);
    let notes = json!({"memory":"- owner's secret","user":"- likes kites","recent":"- kites"});
    assert_eq!(owner.put("/api/memory", notes).0, 200);
    let theirs = second.get("/api/settings");
    assert_eq!(theirs["persona"]["name"], "Jet");
    assert_eq!(theirs["reducedMotion"], false);
    assert_eq!(second.get("/api/memory")["memory"], "");
    assert_eq!(owner.get("/api/settings")["persona"]["name"], "Ada");
    assert_eq!(owner.get("/api/memory")["memory"], "- owner's secret");

    // A file of one user cannot be fetched by another, and its bytes are in the database only.
    let marker = "a line only the owner's file holds";
    let (status, about) = owner.upload("plan.md", format!("# Plan\n{marker}\n").as_bytes());
    assert_eq!(status, 200, "{about}");
    let id = about["id"].as_str().unwrap();
    for path in [format!("/api/files/{id}"), format!("/api/files/{id}/view")] {
        assert_eq!(owner.fetch(&path).0, 200, "{path}");
        assert_eq!(second.fetch(&path).0, 404, "{path}");
    }
    let held: Vec<_> = walk(host.dir.path())
        .into_iter()
        .filter(|path| String::from_utf8_lossy(&std::fs::read(path).unwrap()).contains(marker))
        .collect();
    assert!(
        !held.is_empty()
            && held
                .iter()
                .all(|path| path.to_string_lossy().contains("jet.sqlite3")),
        "the file's bytes must be in the database and nowhere else: {held:?}"
    );
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            found.extend(walk(&path));
        } else {
            found.push(path);
        }
    }
    found
}

#[test]
fn only_an_admin_reads_or_changes_the_provider_programs() {
    let host = Host::start();
    let (owner, second) = (host.owner(), host.sign_in_as(SECOND));
    let program = owner.get("/api/settings")["claudePath"].clone();
    assert!(
        program
            .as_str()
            .is_some_and(|path| path.ends_with("provider.py"))
    );

    let theirs = second.get("/api/settings");
    assert!(
        theirs.get("claudePath").is_none() && theirs.get("codexPath").is_none(),
        "{theirs}"
    );
    let status = second.get("/api/status");
    assert!(status["program"].get("path").is_none(), "{status}");
    assert!(owner.get("/api/status")["program"]["path"].is_string());

    // A path sent by someone who is not an admin is ignored; their own settings still save.
    let mut sent = theirs.clone();
    sent["claudePath"] = json!("/tmp/anything");
    sent["persona"]["name"] = json!("Bo");
    assert_eq!(second.put("/api/settings", sent).0, 200);
    assert_eq!(owner.get("/api/settings")["claudePath"], program);
    assert_eq!(second.get("/api/settings")["persona"]["name"], "Bo");

    let mut changed = owner.get("/api/settings");
    changed["codexPath"] = json!("/opt/codex");
    assert_eq!(owner.put("/api/settings", changed).0, 200);
    assert_eq!(owner.get("/api/settings")["codexPath"], "/opt/codex");
}

#[test]
fn an_app_belongs_to_who_added_it_and_only_an_admin_registers_one_on_the_server() {
    let fixture = Fixture::start();
    let host = host();
    let (owner, second) = (host.owner(), host.sign_in_as(SECOND));
    let (status, added) = owner.post("/api/apps", json!({"action":"add","address":fixture.url}));
    assert_eq!(
        status, 200,
        "an admin may register a loopback address: {added}"
    );
    let id = added["app"]["id"].as_str().unwrap().to_owned();

    // Not listed, not reachable and not changeable by another user.
    assert_eq!(second.get("/api/apps"), json!([]));
    assert_eq!(second.fetch(&format!("/api/apps/{id}/tools")).0, 404);
    let page = format!("/apps/{id}/jet-app.json");
    assert_eq!(owner.fetch(&page).0, 200);
    let (status, refusal) = second.fetch(&page);
    assert_eq!(
        (status, &refusal["error"]),
        (404, &json!("app is no longer registered"))
    );
    let (status, _) = second.post("/api/apps", json!({"action":"remove","id":id}));
    assert_eq!(status, 404);

    // Not offered by the facade on another user's turn, which may not register one on the server
    // either.
    let script = json!([
        {"tool":"apps_list"},
        {"tool":"tools_search","arguments":{"query":"echo"}},
        {"tool":"tools_describe","arguments":{"appId":id,"tool":"echo"}},
        {"tool":"apps_update","arguments":{"command":{"action":"add","address":"http://127.0.0.1:9/"}}}
    ]);
    let mut message = request("second-tools");
    message["text"] = json!(format!("facade:{script}"));
    assert_eq!(second.post("/api/chat/send", message).0, 200);
    settled(&second, 2);
    let results: Vec<Value> = serde_json::from_str(
        &std::fs::read_to_string(host.dir.path().join("facade-results.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(results[0]["structuredContent"], json!([]), "{}", results[0]);
    assert_eq!(
        results[1]["structuredContent"]["tools"],
        json!([]),
        "{}",
        results[1]
    );
    assert_eq!(results[2]["isError"], true, "{}", results[2]);
    assert_eq!(results[3]["isError"], true, "{}", results[3]);
    assert_eq!(
        results[3]["structuredContent"]["error"]["kind"], "adminOnly",
        "{}",
        results[3]
    );

    // Through the page: a port, loopback or private address is refused in words, a public one is
    // taken.
    for address in [
        "8080",
        "http://127.0.0.1:9/",
        "http://localhost:3000/",
        "http://[::1]:8080/",
        "http://10.0.0.5/",
        "http://192.168.1.5/",
        "http://172.16.0.5/",
    ] {
        let (status, refusal) = second.post("/api/apps", json!({"action":"add","address":address}));
        assert_eq!(status, 403, "{address}: {refusal}");
        assert_eq!(refusal["kind"], "adminOnly", "{address}");
        assert!(
            refusal["message"]
                .as_str()
                .unwrap()
                .contains("only an admin")
        );
    }
    let (status, public) = second.post(
        "/api/apps",
        json!({"action":"add","address":"http://192.0.2.10/"}),
    );
    assert_eq!(status, 200, "{public}");
    assert_eq!(second.get("/api/apps").as_array().unwrap().len(), 1);
    assert_eq!(owner.get("/api/apps").as_array().unwrap().len(), 1);
}

#[test]
fn a_notes_review_changes_only_its_own_users_notes() {
    let host = Host::start_with(&["--review-quiet-seconds", "1"]);
    let (owner, second) = (host.owner(), host.sign_in_as(SECOND));
    let reviews = || {
        std::fs::read_to_string(host.dir.path().join("calls"))
            .unwrap_or_default()
            .lines()
            .filter(|line| *line == "review")
            .count()
    };
    let recent = |user: &User, wanted: &str| {
        let deadline = Instant::now() + Duration::from_secs(10);
        while user.get("/api/memory")["recent"] != wanted {
            assert!(Instant::now() < deadline, "the notes never read {wanted:?}");
            std::thread::sleep(Duration::from_millis(50));
        }
    };

    say(&owner, "owner-kites", "I like kites");
    settled(&owner, 2);
    recent(&owner, "- I like kites [Main chat]");
    assert_eq!(second.get("/api/memory")["recent"], "");
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(
        reviews(),
        1,
        "the second user's timer must not fire on the owner's quiet"
    );

    say(&second, "second-boats", "I like boats");
    settled(&second, 2);
    recent(&second, "- I like boats [Main chat]");
    assert_eq!(
        owner.get("/api/memory")["recent"],
        "- I like kites [Main chat]"
    );
    assert_eq!(reviews(), 2);
}

#[test]
fn a_stop_with_another_users_request_id_leaves_their_turn_and_its_tools_alone() {
    let host = host();
    let (owner, second) = (host.owner(), host.sign_in_as(SECOND));
    say(&owner, "same-id", "hang");
    owner.until(|snapshot| snapshot["active"]["text"] == "Partial");
    let args: Vec<String> = serde_json::from_str(
        &std::fs::read_to_string(host.dir.path().join("fake-claude-args.json")).unwrap(),
    )
    .unwrap();
    let config = &args[args.iter().position(|arg| arg == "--mcp-config").unwrap() + 1];
    let config: Value = serde_json::from_str(config).unwrap();
    let token = config["mcpServers"]["jet"]["headers"]["x-jet-turn"]
        .as_str()
        .unwrap()
        .to_owned();
    let tools = || {
        super::support::agent()
            .get(format!("{}/mcp", host.url))
            .header("x-jet-turn", &token)
            .call()
            .unwrap()
            .status()
            .as_u16()
    };
    assert_ne!(tools(), 401, "the running turn's tools are bound");

    assert_eq!(
        second
            .post("/api/chat/stop", json!({"requestId":"same-id"}))
            .0,
        200
    );
    assert_ne!(
        tools(),
        401,
        "another user's stop let go of the owner's tools"
    );
    assert!(owner.get("/api/snapshot")["active"].is_object());

    assert_eq!(
        owner
            .post("/api/chat/stop", json!({"requestId":"same-id"}))
            .0,
        200
    );
    assert_eq!(tools(), 401, "the owner's own stop lets go of them");
}

#[test]
fn a_failed_reply_names_the_program_path_only_to_an_admin() {
    let host = Host::start();
    let (owner, second) = (host.owner(), host.sign_in_as(SECOND));
    let missing = "/nowhere/secret-place/claude";
    host.set_programs(json!({"claudePath": missing}));
    for (user, id) in [(&owner, "owner-missing"), (&second, "second-missing")] {
        say(user, id, "hello");
    }
    let error = |user: &User| {
        settled(user, 2)["history"][1]["error"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    assert!(
        error(&owner).contains(missing),
        "the admin is told where Jet looked"
    );
    let theirs = error(&second);
    assert!(theirs.contains("couldn't find Claude Code"), "{theirs}");
    assert!(!theirs.contains("/nowhere"), "{theirs}");
}

#[test]
fn one_users_slow_app_does_not_stall_another_users_app_list() {
    let host = Host::start();
    let other = host.sign_in_as(SECOND);
    // The kernel takes the connection, but nothing ever answers, so discovery waits its whole timeout.
    let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}/", silent.local_addr().unwrap());
    let owner = host.owner();
    let adding = std::thread::spawn(move || {
        owner.post("/api/apps", json!({"action": "add", "address": address}))
    });
    std::thread::sleep(Duration::from_millis(300));
    let started = Instant::now();
    other.get("/api/apps");
    let waited = started.elapsed();
    let (status, added) = adding.join().unwrap();
    drop(silent);
    assert_eq!(status, 200, "{added}");
    assert!(
        waited < Duration::from_millis(500),
        "another user's app list waited {waited:?} behind one user's app whose server does not answer"
    );
}

#[test]
fn an_app_on_the_server_is_reached_for_an_admin_and_refused_once_its_owner_is_not_one() {
    let fixture = Fixture::start();
    let host = host();
    let (status, added) = host.post("/api/apps", json!({"action":"add","address":fixture.url}));
    assert_eq!(status, 200, "{added}");
    let id = added["app"]["id"].as_str().unwrap().to_owned();
    let tools = format!("/api/apps/{id}/tools");
    assert_eq!(
        host.owner().fetch(&tools).0,
        200,
        "an admin reaches the app"
    );

    rusqlite::Connection::open(host.dir.path().join("jet.sqlite3"))
        .unwrap()
        .execute(
            "UPDATE users SET is_admin = 0 WHERE email = ?1",
            [super::support::OWNER],
        )
        .unwrap();
    // A new session is needed, since the one open was made while the owner was an admin.
    for action in ["disable", "enable"] {
        let (status, changed) = host.post("/api/apps", json!({"action":action,"id":id}));
        assert_eq!(status, 200, "{changed}");
    }
    let (status, refusal) = host.owner().fetch(&tools);
    assert_eq!(status, 502, "{refusal}");
    assert!(refusal.to_string().contains("private network"), "{refusal}");
}
