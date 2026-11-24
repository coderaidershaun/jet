//! Prove that `github_activity` reads a repository through the real host with the token of the
//! user who sent the message and no one else's, that the token never leaves the server's
//! memory in clear, and that a reply which read a repository cannot change apps.
use super::{
    mcp_fixture::Fixture,
    support::{Host, OWNER, PASSWORD, agent, cookie_header, replay, request, sign_in},
};
use agent::test_server::{Answer, Paths};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const MANAGER: &str = "admin123@gmail.com";
const TOKEN: &str = "github_pat_11SECRETabcdef0123456789";
const LOG: &str = "host-stderr.log";

fn fake_github() -> Paths {
    Paths::start(vec![
        (
            "/repos/octo/jet",
            Answer::json(
                200,
                json!({"html_url":"https://github.com/octo/jet","pushed_at":"2026-11-23T09:00:00Z"}),
            ),
        ),
        (
            "/repos/octo/jet/commits",
            Answer::json(
                200,
                json!([{"sha":"a1b2c3d4e5f6","html_url":"https://github.com/octo/jet/commit/a1b2c3d4e5f6","author":{"login":"shaun"},"commit":{"message":"Add the kite","author":{"date":"2026-11-23T09:00:00Z"}}}]),
            ),
        ),
        ("/repos/octo/jet/pulls", Answer::json(200, json!([]))),
        ("/repos/octo/jet/issues", Answer::json(200, json!([]))),
    ])
}

/// Starts the real host with the Claude Code and Codex stand-ins, pointed at the fake GitHub, with
/// everything it writes to standard error kept in a file of its data directory.
fn start(github: &Paths) -> Host {
    let dir = tempfile::tempdir().unwrap();
    let bins = std::path::Path::new(env!("CARGO_BIN_EXE_jet"))
        .parent()
        .unwrap();
    std::fs::write(
        dir.path().join("settings.json"),
        json!({"claudePath":bins.join("fake-claude"),"codexPath":bins.join("fake-codex")})
            .to_string(),
    )
    .unwrap();
    let log = std::fs::File::create(dir.path().join(LOG)).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_jet"))
        .args(["--listen", "127.0.0.1:0", "--data-dir"])
        .arg(dir.path())
        .args(["--disable-feelings", "--disable-voice"])
        .env("JET_GITHUB_API", &github.url)
        .env_remove("JET_GITHUB_TOKEN_KEY")
        .stdout(Stdio::piped())
        .stderr(log)
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let url = line
        .trim()
        .strip_prefix("Jet listening on ")
        .unwrap_or_else(|| panic!("server did not start: {line}"))
        .to_owned();
    let cookie = signed_in_cookie(&url, OWNER);
    Host {
        child,
        origin: url.clone(),
        url,
        dir,
        cookie,
    }
}

fn signed_in_cookie(url: &str, email: &str) -> String {
    let response = sign_in(url, url, email, PASSWORD);
    assert_eq!(response.status(), 200, "{email} could not sign in");
    cookie_header(&response)
}

/// Sends a request with the given sign-in and gives its status and its body as text.
fn call(host: &Host, cookie: &str, method: &str, path: &str, body: Option<Value>) -> (u16, String) {
    let url = format!("{}{path}", host.url);
    let (agent, cookie, origin) = (agent(), ("cookie", cookie), ("origin", &host.origin));
    let sent = match (method, body) {
        ("GET", None) => agent
            .get(url)
            .header(cookie.0, cookie.1)
            .header(origin.0, origin.1)
            .call(),
        ("DELETE", None) => agent
            .delete(url)
            .header(cookie.0, cookie.1)
            .header(origin.0, origin.1)
            .call(),
        ("PUT", Some(body)) => agent
            .put(url)
            .header(cookie.0, cookie.1)
            .header(origin.0, origin.1)
            .header("content-type", "application/json")
            .send(body.to_string()),
        ("POST", Some(body)) => agent
            .post(url)
            .header(cookie.0, cookie.1)
            .header(origin.0, origin.1)
            .header("content-type", "application/json")
            .send(body.to_string()),
        (method, _) => panic!("no such request in these tests: {method}"),
    };
    let mut response = sent.unwrap();
    let text = response.body_mut().read_to_string().unwrap();
    (response.status().as_u16(), text)
}

/// Sends one message whose provider script is `script`, as the user of `cookie`, waits until the
/// thread holds `entries` entries and the reply is complete, and gives the result of each step.
fn run_turn(
    host: &Host,
    cookie: &str,
    id: &str,
    model: &str,
    script: Value,
    entries: usize,
) -> Vec<Value> {
    let mut message = request(id);
    message["model"] = json!(model);
    message["text"] = json!(format!("How is octo/jet going?\nfacade:{script}"));
    let (status, accepted) = call(host, cookie, "POST", "/api/chat/send", Some(message));
    assert_eq!(status, 200, "{accepted}");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let snapshot = host.get("/api/snapshot");
        let history = snapshot["history"].as_array().unwrap();
        if snapshot["active"].is_null() && history.len() == entries {
            assert_eq!(history[entries - 1]["status"], "complete", "{snapshot}");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the turn did not end: {snapshot}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let results = std::fs::read_to_string(host.dir.path().join("facade-results.json")).unwrap();
    serde_json::from_str::<Vec<Value>>(&results).unwrap()
}

fn activity() -> Value {
    json!({"tool":"github_activity","arguments":{"repo":"octo/jet","since":"2026-11-20T00:00:00Z"}})
}

fn has_token(head: &str) -> bool {
    head.to_ascii_lowercase().contains(&format!(
        "authorization: bearer {}",
        TOKEN.to_ascii_lowercase()
    ))
}

#[test]
fn a_token_saved_by_one_user_is_sent_only_on_that_users_calls() {
    let github = fake_github();
    let host = start(&github);
    let manager = signed_in_cookie(&host.url, MANAGER);

    let (status, answer) = call(
        &host,
        &host.cookie,
        "PUT",
        "/api/github/token",
        Some(json!({"token": TOKEN})),
    );
    assert_eq!((status, answer.as_str()), (200, r#"{"saved":true}"#));
    let saved = |cookie: &str| call(&host, cookie, "GET", "/api/github/token", None);
    assert_eq!(saved(&host.cookie), (200, r#"{"saved":true}"#.into()));
    assert_eq!(saved(&manager), (200, r#"{"saved":false}"#.into()));

    let owner_turn = run_turn(
        &host,
        &host.cookie,
        "owner",
        "sonnet",
        json!([activity()]),
        2,
    );
    let manager_turn = run_turn(&host, &manager, "manager", "sonnet", json!([activity()]), 4);

    for result in [&owner_turn[0], &manager_turn[0]] {
        let facts = &result["structuredContent"];
        assert_eq!(facts["lastPush"], "2026-11-23T09:00:00Z", "{result}");
        assert_eq!(facts["commits"][0]["id"], "a1b2c3d", "{result}");
    }
    let requests = github.requests();
    assert_eq!(requests.len(), 8, "four requests for each call");
    assert!(
        requests[..4].iter().all(|head| has_token(head)),
        "the owner's calls carry the owner's token"
    );
    assert!(
        requests[4..]
            .iter()
            .all(|head| !head.to_ascii_lowercase().contains("authorization")),
        "the manager's calls carry no token"
    );

    // The call shows as a card in the thread, kept with the reply.
    let history = host.get("/api/snapshot")["history"].clone();
    let card = &history[1]["tools"][0];
    assert_eq!(
        (&card["server"], &card["tool"], &card["ok"]),
        (&json!("jet"), &json!("github_activity"), &json!(true)),
        "{history}"
    );

    let (status, _) = call(&host, &host.cookie, "DELETE", "/api/github/token", None);
    assert_eq!(status, 200);
    assert_eq!(saved(&host.cookie), (200, r#"{"saved":false}"#.into()));
    let (status, answer) = call(
        &host,
        &host.cookie,
        "PUT",
        "/api/github/token",
        Some(json!({"token": "two words"})),
    );
    assert_eq!(status, 400, "{answer}");
}

#[test]
fn the_token_is_in_no_file_event_transcript_log_or_answer() {
    let github = fake_github();
    let mut host = start(&github);
    call(
        &host,
        &host.cookie,
        "PUT",
        "/api/github/token",
        Some(json!({"token": TOKEN})),
    );
    let results = run_turn(
        &host,
        &host.cookie,
        "look",
        "sonnet",
        json!([activity()]),
        2,
    );
    assert_eq!(results[0]["isError"], false, "{}", results[0]);
    assert!(has_token(&github.requests()[0]), "the call used the token");

    let mut answers = Vec::new();
    for path in [
        "/api/snapshot",
        "/api/settings",
        "/api/github/token",
        "/api/auth/me",
        "/api/memory",
    ] {
        answers.push(call(&host, &host.cookie, "GET", path, None).1);
    }
    let events = replay(&host);
    assert!(
        events.iter().any(|event| event["kind"] == "toolFinished"),
        "{events:?}"
    );
    answers.push(json!(events).to_string());
    for answer in &answers {
        assert!(
            !answer.contains(TOKEN),
            "an answer holds the token: {answer}"
        );
    }

    // Stop the host so the database's write-ahead log and the log file are complete.
    host.child.kill().unwrap();
    host.child.wait().unwrap();
    let mut files = 0;
    let mut pending = vec![host.dir.path().to_owned()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            let bytes = std::fs::read(&path).unwrap();
            files += 1;
            assert!(
                !bytes
                    .windows(TOKEN.len())
                    .any(|part| part == TOKEN.as_bytes()),
                "{} holds the token in clear",
                path.display()
            );
        }
    }
    let names: Vec<String> = std::fs::read_dir(host.dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    for expected in [
        "jet.sqlite3",
        "jet.sqlite3-wal",
        "settings.json",
        "transcript.jsonl",
        LOG,
    ] {
        assert!(
            names.iter().any(|name| name == expected),
            "{expected} was not written: {names:?}"
        );
    }
    assert!(files >= 5);
}

#[test]
fn apps_update_after_github_activity_is_refused() {
    let github = fake_github();
    let fixture = Fixture::start();
    let host = start(&github);
    let app = host
        .post("/api/apps", json!({"action":"add","address":fixture.url}))
        .1["app"]["id"]
        .clone();
    let disable =
        json!({"tool":"apps_update","arguments":{"command":{"action":"disable","id":app}}});

    for (turn, model) in ["sonnet", "gpt-6.1-sol"].into_iter().enumerate() {
        let script = json!([activity(), disable]);
        let results = run_turn(&host, &host.cookie, model, model, script, 2 * turn + 2);
        assert_eq!(results[0]["isError"], false, "{model}: {}", results[0]);
        let error = &results[1]["structuredContent"]["error"];
        assert_eq!(
            error["kind"], "writeAfterWebText",
            "{model}: {}",
            results[1]
        );
    }
    assert_eq!(host.get("/api/apps")[0]["enabled"], true);
}
