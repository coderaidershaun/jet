//! Prove, through the real host with the provider stand-in and two signed-in users, that Jet
//! records objectives and its own agent-tasks by its facade tools, for the user of the turn only.
use super::{
    github,
    mcp_fixture::Fixture,
    support::{Host, User, host, request, wait_file},
};
use agent::test_server::{Answer, Paths};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

pub(super) const MANAGER: &str = "admin123@gmail.com";
const ZONE: &str = "America/New_York";

/// Sends one message that carries the user's time zone and the script as the provider's
/// instruction, waits for the reply to end, and gives the result of each call of the script.
pub(super) fn run_turn(
    host: &Host,
    user: &User,
    id: &str,
    words: &str,
    script: Value,
) -> Vec<Value> {
    run_turn_in(host, user, None, id, words, script)
}

/// `run_turn` in the chat with that id, or in the main chat when there is none.
pub(super) fn run_turn_in(
    host: &Host,
    user: &User,
    chat: Option<i64>,
    id: &str,
    words: &str,
    script: Value,
) -> Vec<Value> {
    let chat = chat.map_or(String::new(), |chat| format!("?chat={chat}"));
    let _ = std::fs::remove_file(host.dir.path().join("facade-results.json"));
    let mut message = request(id);
    message["text"] = json!(format!("{words}\nfacade:{script}"));
    message["timeZone"] = json!(ZONE);
    let (status, accepted) = user.post(&format!("/api/chat/send{chat}"), message);
    assert_eq!(status, 200, "{accepted}");
    let deadline = Instant::now() + Duration::from_secs(8);
    while {
        let snapshot = user.get(&format!("/api/snapshot{chat}"));
        !(snapshot["active"].is_null()
            && snapshot["history"]
                .as_array()
                .is_some_and(|history| history.last().is_some_and(|last| last["role"] == "jet")))
    } {
        assert!(Instant::now() < deadline, "the reply did not end");
        std::thread::sleep(Duration::from_millis(15));
    }
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let results = wait_file(host, "facade-results.json");
        if results
            .as_array()
            .is_some_and(|r| r.len() == script.as_array().unwrap().len())
        {
            return results.as_array().unwrap().clone();
        }
        assert!(
            Instant::now() < deadline,
            "the script did not finish: {results}"
        );
        std::thread::sleep(Duration::from_millis(15));
    }
}

pub(super) fn objectives(command: Value) -> Value {
    json!({"tool":"objectives_update","arguments":{"command":command}})
}

fn tasks(command: Value) -> Value {
    json!({"tool":"tasks_update","arguments":{"command":command}})
}

pub(super) fn tool(name: &str) -> Value {
    json!({"tool":name,"arguments":{}})
}

pub(super) fn create(sources: Value) -> Value {
    objectives(json!({
        "action":"create","title":"Ship the kite","deliverable":"A kite that flies",
        "start":"2099-06-01","due":"2099-07-01",
        "steps":[{"title":"Build the frame","due":"2099-06-10"},{"title":"Fly it"}],
        "sources":sources,
        "check":{"at":"2099-06-08T09:00","why":"see whether the frame is built"}
    }))
}

pub(super) fn data(result: &Value) -> &Value {
    assert_eq!(result["isError"], false, "{result}");
    &result["structuredContent"]
}

pub(super) fn error_kind(result: &Value) -> &Value {
    assert_eq!(result["isError"], true, "{result}");
    &result["structuredContent"]["error"]["kind"]
}

fn utc(text: &str) -> i64 {
    text.parse::<jiff::Timestamp>().unwrap().as_second()
}

pub(super) fn database(host: &Host) -> rusqlite::Connection {
    rusqlite::Connection::open_with_flags(
        host.dir.path().join("jet.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap()
}

#[test]
fn a_turn_records_an_objective_that_only_its_owner_can_list() {
    let host = host();
    let (owner, manager) = (host.owner(), host.sign_in_as(MANAGER));
    let sources = json!([
        {"kind":"jet"},
        {"kind":"github","repo":"octo/jet","login":"shaun"},
        {"kind":"web","page":"https://docs.example.com/kites"}
    ]);
    let results = run_turn(
        &host,
        &owner,
        "create",
        "I am building a kite.",
        json!([create(sources), tool("objectives_list")]),
    );
    let made = &data(&results[0])["objective"];
    let listed = &data(&results[1])["objectives"][0];
    assert_eq!(made["id"], listed["id"]);
    assert_eq!(
        (
            &listed["title"],
            &listed["durationDays"],
            &listed["version"]
        ),
        (&json!("Ship the kite"), &json!(30), &json!(1))
    );
    assert_eq!(listed["steps"].as_array().unwrap().len(), 2);
    assert_eq!(listed["sources"].as_array().unwrap().len(), 3);
    let check = &listed["tasks"][0];
    assert_eq!(
        (&check["kind"], &check["state"], &check["setBy"]),
        (&json!("check"), &json!("scheduled"), &json!("jet"))
    );
    assert_eq!(check["localTime"], "2099-06-08T09:00");
    assert_eq!(check["timeZone"], ZONE);
    assert_eq!(
        check["dueAt"],
        utc("2099-06-08T13:00:00Z"),
        "09:00 in New York in June is 13:00 UTC"
    );

    // Each call shows as a card in the thread.
    let history = owner.get("/api/snapshot")["history"].clone();
    let cards: Vec<&Value> = history
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|entry| entry["tools"].as_array().into_iter().flatten())
        .collect();
    let names: Vec<&Value> = cards.iter().map(|card| &card["tool"]).collect();
    assert_eq!(names, ["objectives_update", "objectives_list"], "{history}");
    assert!(
        cards
            .iter()
            .all(|card| card["server"] == "jet" && card["ok"] == true)
    );

    // The objective has its own chat, and the main chat holds a line about it.
    let db = database(&host);
    let (chat, title): (i64, String) = db
        .query_row(
            "SELECT id, title FROM chats WHERE kind = 'objective'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (chat, title.as_str()),
        (listed["chatId"].as_i64().unwrap(), "Ship the kite")
    );
    assert_eq!(
        data(&results[0])["chat"],
        json!({"id": chat, "title": "Ship the kite", "new": true}),
        "the answer says where the objective landed"
    );
    let first: String = db
        .query_row(
            "SELECT json_extract(entry, '$.text') FROM entries WHERE chat_id = ?1",
            [chat],
            |row| row.get(0),
        )
        .unwrap();
    assert!(first.contains("A kite that flies"), "{first}");
    assert!(
        history.to_string().contains("It has its own chat now"),
        "{history}"
    );

    // Another user's list holds nothing of it, and changing it by its id is refused.
    let results = run_turn(
        &host,
        &manager,
        "peek",
        "What is Shaun working on?",
        json!([
            tool("objectives_list"),
            tool("tasks_list"),
            objectives(json!({"action":"close","id":made["id"],"outcome":"dropped"})),
        ]),
    );
    assert_eq!(data(&results[0])["objectives"], json!([]));
    assert_eq!(data(&results[1])["tasks"], json!([]));
    assert_eq!(error_kind(&results[2]), "noSuchObjective");
}

#[test]
fn steps_dates_notes_checks_and_close_do_what_they_say() {
    let host = host();
    let owner = host.owner();
    let results = run_turn(
        &host,
        &owner,
        "create",
        "A kite.",
        json!([create(json!([]))]),
    );
    let objective = &data(&results[0])["objective"];
    let (id, step) = (objective["id"].clone(), objective["steps"][0]["id"].clone());

    let results = run_turn(
        &host,
        &owner,
        "work",
        "Progress.",
        json!([
            objectives(json!({"action":"step_tick","id":id,"step":step})),
            objectives(json!({"action":"step_add","id":id,"title":"Photograph it"})),
            objectives(
                json!({"action":"dates","id":id,"due":"2099-07-15","reason":"the wind dropped"})
            ),
            objectives(
                json!({"action":"note","id":id,"status":"at risk","moved":"frame half built","blockers":"no glue","private":true})
            ),
            tasks(
                json!({"action":"schedule","objectiveId":id,"at":"2099-06-12T09:00","why":"the glue arrives"})
            ),
            tasks(
                json!({"action":"schedule","objectiveId":id,"at":"2000-01-01T09:00","why":"too late"})
            ),
            tasks(
                json!({"action":"schedule","at":"2099-06-20T09:00","why":"ask how the flight went"})
            ),
            tool("objectives_list"),
            tool("tasks_list"),
            objectives(
                json!({"action":"step_edit","id":id,"step":step,"title":"Frame it","due":"2099-07-01"})
            ),
        ]),
    );
    let edited = &data(&results[9])["objective"];
    assert_eq!(
        (
            &edited["steps"][0]["title"],
            &edited["steps"][0]["due"],
            &edited["version"]
        ),
        (&json!("Frame it"), &json!("2099-07-01"), &json!(6))
    );
    let listed = &data(&results[7])["objectives"][0];
    assert!(listed["steps"][0]["doneAt"].is_u64(), "{listed}");
    assert_eq!(listed["steps"].as_array().unwrap().len(), 3);
    assert_eq!(
        (&listed["due"], &listed["durationDays"]),
        (&json!("2099-07-15"), &json!(44))
    );
    let notes = listed["notes"].as_array().unwrap();
    assert!(
        notes[0]["newDates"]
            .as_str()
            .unwrap()
            .contains("the wind dropped"),
        "{notes:?}"
    );
    assert_eq!(
        (&notes[1]["isPrivate"], &notes[1]["status"]),
        (&json!(true), &json!("at risk"))
    );
    assert_eq!(listed["version"], 5);
    assert_eq!(data(&results[4])["moved"], true);
    assert_eq!(error_kind(&results[5]), "timeInThePast");

    let all = data(&results[8]);
    let open: Vec<&Value> = all["tasks"].as_array().unwrap().iter().collect();
    assert_eq!(open.len(), 2, "one check and one follow-up: {all}");
    assert_eq!(open[0]["localTime"], "2099-06-12T09:00");
    assert_eq!(
        (&open[1]["kind"], &open[1]["objectiveId"]),
        (&json!("follow_up"), &Value::Null)
    );

    let results = run_turn(
        &host,
        &owner,
        "close",
        "Done.",
        json!([
            objectives(json!({"action":"close","id":id,"outcome":"done","summary":"it flew"})),
            tool("tasks_list"),
        ]),
    );
    let closed = &data(&results[0])["objective"];
    assert_eq!(closed["status"], "done");
    assert_eq!(closed["tasks"], json!([]));
    let states: Vec<&Value> = data(&results[1])["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|task| &task["state"])
        .collect();
    assert!(
        states.contains(&&json!("cancelled")) && states.contains(&&json!("scheduled")),
        "{states:?}"
    );
}

#[test]
fn people_list_returns_the_seeded_directory() {
    let host = host();
    let results = run_turn(
        &host,
        &host.owner(),
        "people",
        "Who is who?",
        json!([tool("people_list")]),
    );
    let directory = data(&results[0]);
    let users = directory["users"].as_array().unwrap();
    let find = |email: &str| users.iter().find(|user| user["email"] == email).unwrap();
    assert_eq!(
        find("shaunsurfing@gmail.com")["managerId"],
        find(MANAGER)["id"]
    );
    assert_eq!(find("admin1@gmail.com")["teams"], json!(["Commercial"]));
    let team = &directory["teams"][0];
    assert_eq!(team["name"], "Commercial");
    assert_eq!(
        team["memberIds"],
        json!([
            find("admin1@gmail.com")["id"],
            find("admin2@gmail.com")["id"]
        ])
    );
}

#[test]
fn app_source_needs_read_only_tool() {
    let fixture = Fixture::start();
    let host = host();
    let app = host
        .post("/api/apps", json!({"action":"add","address":fixture.url}))
        .1["app"]["id"]
        .clone();
    let source = |tool: &str| json!([{"kind":"app","appId":app,"tool":tool}]);
    let results = run_turn(
        &host,
        &host.owner(),
        "app",
        "Watch my job.",
        json!([
            create(source("job_write")),
            create(source("no_such_tool")),
            create(source("job_status"))
        ]),
    );
    assert_eq!(error_kind(&results[0]), "notReadOnly");
    assert_eq!(error_kind(&results[1]), "notReadOnly");
    let kept = &data(&results[2])["objective"]["sources"][0];
    assert_eq!(
        (&kept["kind"], &kept["target"], &kept["detail"]),
        (&json!("app"), &app, &json!("job_status"))
    );
}

#[test]
fn a_user_who_is_not_the_admin_cannot_name_an_app_source() {
    let fixture = Fixture::start();
    let host = host();
    let app = host
        .post("/api/apps", json!({"action":"add","address":fixture.url}))
        .1["app"]["id"]
        .clone();
    let manager = host.sign_in_as(MANAGER);
    let source = json!([{"kind":"app","appId":app,"tool":"job_status"}]);
    let results = run_turn(&host, &manager, "app", "Watch it.", json!([create(source)]));
    assert_eq!(error_kind(&results[0]), "adminOnly");
}

#[test]
fn github_source_takes_login_from_saved_token() {
    let fake = Paths::start(vec![(
        "/user",
        Answer::json(200, json!({"login":"octocat"})),
    )]);
    let host = github::start(&fake);
    let manager = host.sign_in_as(MANAGER);
    let (status, _) = host.put(
        "/api/github/token",
        json!({"token":"github_pat_11SECRETabcdef0123456789"}),
    );
    assert_eq!(status, 200);
    let source = json!([{"kind":"github","repo":"octo/jet"}]);
    let results = run_turn(
        &host,
        &host.owner(),
        "login",
        "Watch my repo.",
        json!([create(source.clone())]),
    );
    let kept = &data(&results[0])["objective"]["sources"][0];
    assert_eq!(
        (&kept["target"], &kept["detail"]),
        (&json!("octo/jet"), &json!("octocat"))
    );
    assert!(
        fake.requests()[0]
            .to_ascii_lowercase()
            .contains("authorization: bearer github_pat_11secret")
    );

    let results = run_turn(
        &host,
        &manager,
        "login",
        "Watch my repo.",
        json!([create(source)]),
    );
    assert_eq!(error_kind(&results[0]), "githubLoginNeeded");
}

#[test]
fn the_page_source_of_an_objective_puts_its_host_on_the_turn() {
    let host = host();
    let owner = host.owner();
    let page = json!([{"kind":"web","page":"https://docs.example.com/kites"}]);
    let made = run_turn(&host, &owner, "create", "A kite.", json!([create(page)]));
    let chat = data(&made[0])["chat"]["id"].as_i64();
    // The script above held the address as a link, so the thread starts over.
    assert_eq!(owner.post("/api/chat/forget", json!({})).0, 200);
    let fetch = || json!([{"fetch":"docs.example.com/kites"},{"fetch":"other.example/x"}]);
    let results = run_turn_in(
        &host,
        &owner,
        chat,
        "read",
        "Look at the kite page.",
        fetch(),
    );
    assert!(results[0]["refused"].is_null(), "{}", results[0]);
    let refusal = results[1]["refused"].as_str().unwrap_or_default();
    assert!(refusal.contains("paste the link"), "{}", results[1]);
    let args: Vec<String> = serde_json::from_str(
        &std::fs::read_to_string(host.dir.path().join("fake-claude-args.json")).unwrap(),
    )
    .unwrap();
    let allowed = &args[args.iter().position(|arg| arg == "--allowedTools").unwrap() + 1];
    assert!(
        allowed.ends_with(",WebSearch,WebFetch(domain:docs.example.com)"),
        "{allowed}"
    );

    // A closed objective no longer opens its page.
    let id = database(&host)
        .query_row("SELECT id FROM objectives", [], |row| row.get::<_, i64>(0))
        .unwrap();
    run_turn(
        &host,
        &owner,
        "close",
        "Done.",
        json!([objectives(
            json!({"action":"close","id":id,"outcome":"dropped"})
        )]),
    );
    let results = run_turn(&host, &owner, "again", "Look again.", fetch());
    assert!(results[0]["refused"].as_str().is_some(), "{}", results[0]);
}
