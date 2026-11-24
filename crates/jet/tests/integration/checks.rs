//! Prove, through the real host with the provider stand-ins, the local fake GitHub and a clock the
//! test moves, that Jet wakes by itself when an agent-task it set falls due: it reads the evidence
//! first, then posts a check-in in the objective's chat or stays silent, and records what it found.
use super::{
    github::{fake_github, start},
    mcp_fixture::Fixture,
    objectives::{create, data, database, error_kind, objectives, run_turn, tool},
    support::{Host, User, host, request},
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

/// 2099-06-08T13:00:00Z: 09:00 in New York, when the first check of `create` falls due.
const DUE: u64 = 4_084_606_800;
const MINUTE: u64 = 60;
const DAY: u64 = 24 * 3600;
const REPO: &str = "octo/jet";

fn read_repo() -> Value {
    json!({"tool":"github_activity","arguments":{"repo":REPO,"since":"2099-05-01T00:00:00Z"}})
}

fn checked(next: &str) -> Value {
    json!({"tool":"tasks_update","arguments":{"command":{"action":"checked","found":"one commit","next":next,"why":"see the next commit"}}})
}

fn say(text: &str) -> Value {
    json!({"say": format!("mood: neutral\n{text}")})
}

/// The script the next check runs.
fn script(host: &Host, script: Value) {
    std::fs::write(
        host.dir.path().join("check-script.json"),
        script.to_string(),
    )
    .unwrap();
}

fn until<T>(what: &str, condition: impl Fn() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(found) = condition() {
            return found;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn query<T: rusqlite::types::FromSql>(host: &Host, sql: &str) -> Vec<T> {
    let db = database(host);
    let mut statement = db.prepare(sql).unwrap();
    statement
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

/// The outcomes of the runs that ended, oldest first.
fn outcomes(host: &Host) -> Vec<String> {
    query(
        host,
        "SELECT outcome FROM task_runs WHERE outcome IS NOT NULL ORDER BY id",
    )
}

fn wait_for_runs(host: &Host, count: usize) -> Vec<String> {
    until(&format!("{count} runs"), || {
        Some(outcomes(host)).filter(|runs| runs.len() >= count)
    })
}

/// A run has started and has not ended.
fn wait_for_running_check(host: &Host) {
    until("a check to start", || {
        (!query::<i64>(host, "SELECT id FROM task_runs WHERE ended_at IS NULL").is_empty())
            .then_some(())
    });
}

/// The objective made by a turn, with its chat. `sources` are as `objectives_update` takes them.
fn objective_with(host: &Host, user: &User, id: &str, sources: Value) -> (i64, i64) {
    objective_at(host, user, id, sources, "2099-06-08T09:00")
}

/// Like `objective_with`, with the first check at the local time `at`.
fn objective_at(host: &Host, user: &User, id: &str, sources: Value, at: &str) -> (i64, i64) {
    let mut made = create("new", sources);
    made["arguments"]["command"]["check"]["at"] = json!(at);
    let results = run_turn(host, user, id, "I am building a kite.", json!([made]));
    let objective = &data(&results[0])["objective"];
    (
        objective["id"].as_i64().unwrap(),
        objective["chatId"].as_i64().unwrap(),
    )
}

fn entries_of(host: &Host, chat: i64) -> Vec<Value> {
    query::<String>(
        host,
        &format!("SELECT entry FROM entries WHERE chat_id = {chat} ORDER BY id"),
    )
    .iter()
    .map(|text| serde_json::from_str(text).unwrap())
    .collect()
}

fn check_ins(host: &Host, chat: i64) -> Vec<Value> {
    entries_of(host, chat)
        .into_iter()
        .filter(|entry| !entry["check"].is_null())
        .collect()
}

fn unread(user: &User, chat: i64) -> u64 {
    user.get("/api/chats")
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == chat)
        .unwrap()["unread"]
        .as_u64()
        .unwrap()
}

fn open_tasks(host: &Host) -> Vec<(u64, String, String)> {
    let db = database(host);
    let mut statement = db
        .prepare(
            "SELECT due_at, why, set_by FROM agent_tasks WHERE state = 'scheduled' ORDER BY id",
        )
        .unwrap();
    statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?.unsigned_abs(),
                row.get(1)?,
                row.get(2)?,
            ))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn one_source() -> Value {
    json!([{"kind":"github","repo":REPO,"login":"shaun"}])
}

fn send_in(user: &User, chat: i64, id: &str, text: &str) -> (u16, Value) {
    let mut message = request(id);
    message["text"] = json!(text);
    user.post(&format!("/api/chat/send?chat={chat}"), message)
}

#[test]
fn check_in_lands_in_objective_chat_with_badge() {
    let github = fake_github();
    let host = start(&github);
    let owner = host.owner();
    let (_, chat) = objective_with(&host, &owner, "made", one_source());

    // A reply in the chat gives it a provider session, which a check must leave as it is.
    let (status, sent) = send_in(
        &owner,
        chat,
        "talk",
        r#"say:{"parts":["mood: neutral\nHello"]}"#,
    );
    assert_eq!(status, 200, "{sent}");
    until("the reply", || {
        entries_of(&host, chat)
            .iter()
            .any(|entry| entry["text"] == "Hello")
            .then_some(())
    });
    owner.post(&format!("/api/chats/{chat}/read"), json!({}));
    let session = |host: &Host| {
        query::<String>(
            host,
            &format!("SELECT session FROM chats WHERE id = {chat}"),
        )
    };
    let before = session(&host);

    script(
        &host,
        json!([
            read_repo(),
            checked("2099-06-09T09:00"),
            say(
                "Morning! I peeked at the jet repo and it's been quiet since Thursday. Did the week get away from you?"
            ),
        ]),
    );
    let pane_events = |host: &Host| {
        super::support::replay(host)
            .iter()
            .filter(|event| event["kind"] == "paneChanged")
            .count()
    };
    let pane_before = pane_events(&host);
    host.set_clock(DUE);
    wait_for_runs(&host, 1);

    assert_eq!(outcomes(&host), ["spoke"]);
    until("the pane to hear of the run", || {
        (pane_events(&host) > pane_before).then_some(())
    });
    let posted = check_ins(&host, chat);
    assert_eq!(posted.len(), 1, "{posted:?}");
    assert_eq!(posted[0]["role"], "jet");
    assert!(posted[0]["text"].as_str().unwrap().starts_with("Morning!"));
    let cards: Vec<_> = posted[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|card| card["tool"].clone())
        .collect();
    assert!(
        cards.contains(&json!("github_activity")),
        "the card of what Jet read: {cards:?}"
    );
    assert_eq!(unread(&owner, chat), 1, "the badge");
    assert_eq!(
        owner.get(&format!("/api/snapshot?chat={chat}"))["unread"],
        1
    );
    assert_eq!(session(&host), before, "the provider session is as it was");

    let runs = query::<String>(&host, "SELECT sources_read FROM task_runs");
    assert_eq!(runs, [r#"["github octo/jet"]"#]);
    let brief = std::fs::read_to_string(host.dir.path().join("facade-prompt.txt")).unwrap();
    for part in [
        "[Check. No message from the user.",
        "Ship the kite",
        "GitHub repository octo/jet",
        "Standing rules for every check",
    ] {
        assert!(brief.contains(part), "{part} is missing from the brief");
    }
    assert_eq!(
        open_tasks(&host),
        [(DUE + DAY, "see the next commit".into(), "jet".into())]
    );
}

#[test]
fn next_turn_carries_unseen_check_in() {
    let host = host();
    let owner = host.owner();
    let (_, chat) = objective_with(&host, &owner, "made", json!([{"kind":"jet"}]));
    script(
        &host,
        json!([
            checked("2099-06-09T09:00"),
            say("Did the kite get started?")
        ]),
    );
    host.set_clock(DUE);
    wait_for_runs(&host, 1);

    let prompt = || std::fs::read_to_string(host.dir.path().join("facade-prompt.txt")).unwrap();
    let turn = |id: &str, reply: &str| {
        let text = format!(r#"say:{{"parts":["mood: neutral\n{reply}"]}}"#);
        let (status, sent) = send_in(&owner, chat, id, &text);
        assert_eq!(status, 200, "{sent}");
        until("the reply", || {
            entries_of(&host, chat)
                .iter()
                .any(|entry| entry["text"] == reply)
                .then_some(())
        });
        prompt()
    };
    let first = turn("one", "Noted.");
    let line = first
        .find("Did the kite get started?")
        .expect("the check-in is in the first turn");
    assert!(
        line < first.find("say:{").unwrap(),
        "before the user's words: {first}"
    );
    let second = turn("two", "Fine.");
    assert!(!second.contains("Did the kite get started?"), "{second}");
}

#[test]
fn a_check_that_could_not_read_a_source_posts_nothing_and_a_silent_one_writes_no_entry() {
    let github = fake_github();
    let host = start(&github);
    let owner = host.owner();
    let (_, chat) = objective_with(&host, &owner, "made", one_source());
    let unreadable = json!({"tool":"github_activity","arguments":{"repo":"octo/missing","since":"2099-05-01T00:00:00Z"}});
    script(
        &host,
        json!([unreadable, say("You have not pushed anything")]),
    );
    host.set_clock(DUE);
    wait_for_runs(&host, 1);
    assert_eq!(outcomes(&host), ["held"]);
    assert!(
        check_ins(&host, chat).is_empty(),
        "nothing about progress was posted"
    );
    let found = query::<String>(&host, "SELECT found FROM task_runs");
    assert!(found[0].contains("github octo/jet"), "{found:?}");
    assert_eq!(
        open_tasks(&host)[0].0,
        DUE + 15 * MINUTE,
        "the task tries once more"
    );

    // Held a second time: the run is held again and the task is done, with the default next check.
    host.set_clock(DUE + 16 * MINUTE);
    wait_for_runs(&host, 2);
    assert_eq!(outcomes(&host), ["held", "held"]);
    assert_eq!(
        open_tasks(&host),
        [(
            DUE + 16 * MINUTE + DAY,
            "Jet set no next check".into(),
            "default".into()
        )]
    );

    // A silent answer, even with the marker inside other text, writes no entry.
    let next = ["2099-06-13T09:00", "2099-06-15T09:00"];
    for (round, words) in ["[SILENT]", "Nothing to say. [SILENT] See you."]
        .into_iter()
        .enumerate()
    {
        script(
            &host,
            json!([read_repo(), checked(next[round]), say(words)]),
        );
        host.set_clock(DUE + (round as u64 + 2) * 2 * DAY);
        wait_for_runs(&host, 3 + round);
        assert_eq!(outcomes(&host)[2 + round], "silent");
    }
    assert!(check_ins(&host, chat).is_empty());
    let found = query::<String>(
        &host,
        "SELECT found FROM task_runs WHERE outcome = 'silent'",
    );
    assert_eq!(found, ["one commit", "one commit"]);
}

#[test]
fn one_unread_source_holds_the_check_in() {
    let github = fake_github();
    let host = start(&github);
    let owner = host.owner();
    let sources = json!([
        {"kind":"github","repo":REPO,"login":"shaun"},
        {"kind":"web","page":"https://docs.example.com/kites"}
    ]);
    let (_, chat) = objective_with(&host, &owner, "made", sources);
    script(&host, json!([read_repo(), say("Looks quiet")]));
    host.set_clock(DUE);
    wait_for_runs(&host, 1);
    assert_eq!(outcomes(&host), ["held"]);
    let found = query::<String>(&host, "SELECT found FROM task_runs");
    assert!(
        found[0].contains("web https://docs.example.com/kites") && !found[0].contains("github"),
        "{found:?}"
    );
    assert!(check_ins(&host, chat).is_empty());
}

#[test]
fn check_page_reads_only_source_hosts() {
    let host = host();
    let owner = host.owner();
    let sources = json!([{"kind":"web","page":"https://docs.example.com/kites"}]);
    let (_, chat) = objective_with(&host, &owner, "made", sources);
    script(
        &host,
        json!([
            {"fetch": "docs.example.com/kites/frames"},
            {"fetch": "evil.example.org/leak"},
            say("The kite page has a new frame guide"),
        ]),
    );
    host.set_clock(DUE);
    wait_for_runs(&host, 1);
    let results = super::support::wait_file(&host, "facade-results.json");
    assert!(results[0]["refused"].is_null(), "{}", results[0]);
    assert!(
        results[1]["refused"]
            .as_str()
            .is_some_and(|reason| reason.contains("hook error")),
        "a page of another host is refused: {}",
        results[1]
    );
    assert_eq!(
        outcomes(&host),
        ["spoke"],
        "the read of the source's own host counts"
    );
    assert_eq!(check_ins(&host, chat).len(), 1);
}

#[test]
fn check_binding_refuses_writes_and_unlisted_app_tools() {
    let fixture = Fixture::start();
    let host = host();
    let owner = host.owner();
    let app = host
        .post("/api/apps", json!({"action":"add","address":fixture.url}))
        .1["app"]["id"]
        .clone();
    let sources = json!([{"kind":"app","appId":app,"tool":"job_status"}]);
    let (objective, chat) = objective_with(&host, &owner, "made", sources);
    let teams = query::<i64>(&host, "SELECT count(*) FROM teams");
    let call = |tool: &str, arguments: Value| json!({"tool":tool,"arguments":arguments});
    let table = [
        (
            "objectives_update propose_share",
            objectives(json!({"action":"propose_share","id":objective,"people":[2]})),
            "checkIsReadOnly",
        ),
        (
            "objectives_update note",
            objectives(json!({"action":"note","id":objective,"status":"on track","moved":"x"})),
            "checkIsReadOnly",
        ),
        (
            "people_update",
            call(
                "people_update",
                json!({"command":{"action":"team_add","name":"Raiders"}}),
            ),
            "checkIsReadOnly",
        ),
        (
            "apps_update",
            call(
                "apps_update",
                json!({"command":{"action":"disable","id":app}}),
            ),
            "checkIsReadOnly",
        ),
        (
            "tasks_update schedule",
            call(
                "tasks_update",
                json!({"command":{"action":"schedule","at":"2099-07-01T09:00","why":"x"}}),
            ),
            "checkIsReadOnly",
        ),
        (
            "files_export",
            call(
                "files_export",
                json!({"format":"markdown","title":"T","markdown":"x"}),
            ),
            "checkIsReadOnly",
        ),
        (
            "tools_call of a tool that is no source",
            call(
                "tools_call",
                json!({"appId":app,"tool":"job_write","arguments":{}}),
            ),
            "notASource",
        ),
    ];
    let mut steps: Vec<Value> = table.iter().map(|(_, step, _)| step.clone()).collect();
    steps.push(call(
        "tools_call",
        json!({"appId":app,"tool":"job_status","arguments":{}}),
    ));
    steps.push(say("The job runs"));
    script(&host, json!(steps));
    host.set_clock(DUE);
    wait_for_runs(&host, 1);
    let results = super::support::wait_file(&host, "facade-results.json");
    for (index, (name, _, kind)) in table.iter().enumerate() {
        assert_eq!(
            error_kind(&results[index]),
            kind,
            "{name}: {}",
            results[index]
        );
    }
    assert_eq!(
        results[table.len()]["isError"],
        false,
        "the source tool is allowed"
    );
    assert_eq!(
        outcomes(&host),
        ["spoke"],
        "reading the source tool counts as reading it"
    );
    assert_eq!(host.get("/api/apps")[0]["enabled"], true);
    assert_eq!(query::<i64>(&host, "SELECT count(*) FROM teams"), teams);
    assert_eq!(
        query::<i64>(&host, "SELECT count(*) FROM objective_notes"),
        [0]
    );
    assert_eq!(
        query::<i64>(&host, "SELECT count(*) FROM share_proposals"),
        [0]
    );
    assert_eq!(check_ins(&host, chat).len(), 1);
}

#[test]
fn source_tool_without_read_only_mark_is_refused() {
    let fixture = Fixture::start();
    let host = host();
    let owner = host.owner();
    let app = host
        .post("/api/apps", json!({"action":"add","address":fixture.url}))
        .1["app"]["id"]
        .clone();
    let sources = json!([{"kind":"app","appId":app,"tool":"job_status"}]);
    let (objective, chat) = objective_with(&host, &owner, "made", sources);
    // The app dropped the mark after the objective was agreed: the source names a tool that
    // is not read-only.
    let tampered = rusqlite::Connection::open(host.dir.path().join("jet.sqlite3")).unwrap();
    tampered
        .execute(
            "UPDATE objective_sources SET detail = 'job_write' WHERE objective_id = ?1",
            [objective],
        )
        .unwrap();
    let call =
        json!({"tool":"tools_call","arguments":{"appId":app,"tool":"job_write","arguments":{}}});
    script(&host, json!([call, say("The job runs")]));
    host.set_clock(DUE);
    wait_for_runs(&host, 1);
    let results = super::support::wait_file(&host, "facade-results.json");
    assert_eq!(error_kind(&results[0]), "notReadOnly", "{}", results[0]);
    assert_eq!(
        fixture.app.calls.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "the tool never ran"
    );
    assert_eq!(outcomes(&host), ["held"], "the source counts as unread");
    assert!(check_ins(&host, chat).is_empty());
}

#[test]
fn a_checked_call_moves_the_next_check_and_a_check_with_none_gets_the_default() {
    let host = host();
    let owner = host.owner();
    let (_, _) = objective_with(&host, &owner, "made", json!([{"kind":"jet"}]));
    // 09:05 in New York is five minutes after the check falls due.
    script(
        &host,
        json!([
            checked("2099-06-08T09:05"),
            checked("2099-06-10T09:00"),
            say("Hi there"),
        ]),
    );
    host.set_clock(DUE);
    wait_for_runs(&host, 1);
    let results = super::support::wait_file(&host, "facade-results.json");
    assert_eq!(error_kind(&results[0]), "checkTooSoon", "{}", results[0]);
    assert_eq!(results[1]["isError"], false, "{}", results[1]);
    assert_eq!(
        open_tasks(&host),
        [(DUE + 2 * DAY, "see the next commit".into(), "jet".into())]
    );

    script(&host, json!([say("Hello again")]));
    host.set_clock(DUE + 2 * DAY);
    wait_for_runs(&host, 2);
    assert_eq!(
        open_tasks(&host),
        [(
            DUE + 3 * DAY,
            "Jet set no next check".into(),
            "default".into()
        )]
    );
}

#[test]
fn a_restart_during_a_check_runs_it_again_once_and_three_interruptions_fail_it_with_one_notice() {
    let mut host = host();
    let owner = host.owner();
    let (_, chat) = objective_with(&host, &owner, "made", json!([{"kind":"jet"}]));
    let mut clock = DUE;
    for round in 1..=3 {
        script(&host, json!([{"wait": "never-made"}]));
        host.set_clock(clock);
        wait_for_running_check(&host);
        host = host.restart();
        assert_eq!(
            outcomes(&host).len(),
            round,
            "the cut-off run ended as interrupted"
        );
        clock += 61;
    }
    assert_eq!(outcomes(&host), ["interrupted"; 3]);
    assert_eq!(
        query::<String>(&host, "SELECT state FROM agent_tasks"),
        ["failed"]
    );
    let notices = check_ins(&host, chat);
    assert_eq!(notices.len(), 1, "one notice: {notices:?}");
    assert!(
        notices[0]["text"]
            .as_str()
            .unwrap()
            .contains("stopped trying")
    );

    // One interruption only: the second run is the one that posts, once.
    let mut host = host;
    host.set_clock(DUE);
    let (_, chat) = objective_at(
        &host,
        &host.owner(),
        "again",
        json!([{"kind":"jet"}]),
        "2099-07-01T09:00",
    );
    script(&host, json!([{"wait": "never-made"}]));
    host.set_clock(DUE + 23 * DAY);
    wait_for_running_check(&host);
    host = host.restart();
    script(&host, json!([say("Back again")]));
    host.set_clock(DUE + 23 * DAY + 61);
    wait_for_runs(&host, 5);
    assert_eq!(outcomes(&host)[3..], ["interrupted", "spoke"]);
    assert_eq!(check_ins(&host, chat).len(), 1);
}

#[test]
fn tasks_due_during_downtime_run_once_each_and_are_told_how_late() {
    let host = host();
    let owner = host.owner();
    let (_, first) = objective_with(&host, &owner, "first", json!([{"kind":"jet"}]));
    let (_, second) = objective_with(&host, &owner, "second", json!([{"kind":"jet"}]));
    script(&host, json!([say("I was away, sorry")]));
    // Both were due on 8 June 2099, 09:00 New York; the server is stopped until July.
    host.set_clock(DUE + 30 * DAY);
    let host = host.restart();
    wait_for_runs(&host, 2);
    assert_eq!(outcomes(&host), ["spoke", "spoke"]);
    assert_eq!(check_ins(&host, first).len(), 1);
    assert_eq!(check_ins(&host, second).len(), 1);
    let brief = std::fs::read_to_string(host.dir.path().join("facade-prompt.txt")).unwrap();
    assert!(brief.contains("It runs 30 days late."), "{brief}");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(outcomes(&host).len(), 2, "each ran once");
}

#[test]
fn a_user_message_during_a_check_stops_it_and_it_runs_again_later_without_an_attempt() {
    let host = host();
    let owner = host.owner();
    let (_, chat) = objective_with(&host, &owner, "made", json!([{"kind":"jet"}]));
    script(&host, json!([{"wait": "never-made"}]));
    host.set_clock(DUE);
    wait_for_running_check(&host);
    // The check ran for a while: its rerun is ten minutes after it ended, not after it began.
    host.set_clock(DUE + 100);
    let (status, sent) = send_in(
        &owner,
        chat,
        "hello",
        r#"say:{"parts":["mood: neutral\nHi!"]}"#,
    );
    assert_eq!(status, 200, "{sent}");
    wait_for_runs(&host, 1);
    assert_eq!(outcomes(&host), ["preempted"]);
    assert_eq!(open_tasks(&host)[0].0, DUE + 100 + 10 * MINUTE);
    assert_eq!(query::<i64>(&host, "SELECT attempts FROM agent_tasks"), [0]);
    assert!(
        check_ins(&host, chat).is_empty(),
        "what it staged was dropped"
    );
}

#[test]
fn a_check_waits_for_a_running_reply_in_its_chat() {
    let host = host();
    let owner = host.owner();
    let (_, chat) = objective_with(&host, &owner, "made", json!([{"kind":"jet"}]));
    let (status, sent) = send_in(&owner, chat, "long", "hang");
    assert_eq!(status, 200, "{sent}");
    until("the reply to start", || {
        (!owner.get(&format!("/api/snapshot?chat={chat}"))["active"].is_null()).then_some(())
    });
    script(&host, json!([say("Checking in")]));
    host.set_clock(DUE);
    std::thread::sleep(Duration::from_millis(400));
    assert!(outcomes(&host).is_empty(), "the check waits");
    let (stopped, _) = owner.post(
        &format!("/api/chat/stop?chat={chat}"),
        json!({"requestId":"long"}),
    );
    assert_eq!(stopped, 200);
    wait_for_runs(&host, 1);
    assert_eq!(outcomes(&host), ["spoke"]);
}

#[test]
fn limits_of_a_check_and_a_web_source_on_a_provider_with_web_tools_off() {
    let github = fake_github();
    let host = start(&github);
    let owner = host.owner();
    let (_, chat) = objective_with(&host, &owner, "made", json!([{"kind":"jet"}]));
    // Claude Code carries the money limit in its arguments.
    script(&host, json!([say("Hello")]));
    host.set_clock(DUE);
    wait_for_runs(&host, 1);
    let args = std::fs::read_to_string(host.dir.path().join("fake-claude-args.json")).unwrap();
    let args: Vec<String> = serde_json::from_str(&args).unwrap();
    let at = args
        .iter()
        .position(|arg| arg == "--max-budget-usd")
        .unwrap();
    assert_eq!(args[at + 1], "1.00");
    assert!(
        args.contains(&"--no-session-persistence".to_owned()),
        "a check leaves no session"
    );

    // Codex has no money limit, so the time limit stops a long check.
    let (status, _) = owner.put("/api/settings", json!({"model":"gpt-6-sol"}));
    assert_eq!(status, 200);
    script(&host, json!([{"pause": true}]));
    host.set_clock(DUE + 2 * DAY);
    let started = Instant::now();
    wait_for_runs(&host, 2);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "stopped by the time limit, not by the pause"
    );
    assert_eq!(outcomes(&host)[1], "failed");
    let found = query::<String>(
        &host,
        "SELECT found FROM task_runs WHERE outcome = 'failed'",
    );
    assert!(found[0].contains("time limit"), "{found:?}");
    let posted = check_ins(&host, chat);
    assert_eq!(
        posted.len(),
        2,
        "the check-in of the first check and one notice"
    );
    assert!(
        posted[1]["text"]
            .as_str()
            .unwrap()
            .contains("ran longer than it should")
    );

    // A web source cannot be checked on that provider: the run is held with the reason.
    let sources = json!([{"kind":"web","page":"https://docs.example.com/kites"}]);
    let (_, web_chat) = objective_at(&host, &owner, "web", sources, "2099-07-10T09:00");
    host.set_clock(DUE + 33 * DAY);
    wait_for_runs(&host, 3);
    assert_eq!(outcomes(&host)[2], "held");
    let found = query::<String>(&host, "SELECT found FROM task_runs WHERE outcome = 'held'");
    assert!(found[0].contains("web tools off"), "{found:?}");
    assert!(check_ins(&host, web_chat).is_empty());
}

#[test]
fn store_write_failure_pauses_checks() {
    let github = fake_github();
    let host = start(&github);
    let owner = host.owner();
    let (_, chat) = objective_with(&host, &owner, "made", one_source());
    // The database refuses to change a task, as one that cannot be written does.
    let tampered = rusqlite::Connection::open(host.dir.path().join("jet.sqlite3")).unwrap();
    tampered
        .execute_batch(
            "CREATE TRIGGER read_only BEFORE UPDATE ON agent_tasks
             BEGIN SELECT RAISE(ABORT, 'attempt to write a readonly database'); END;",
        )
        .unwrap();
    script(&host, json!([read_repo(), say("Hello")]));
    host.set_clock(DUE);
    let log = host.dir.path().join("host-stderr.log");
    until("the log line", || {
        std::fs::read_to_string(&log)
            .ok()
            .filter(|text| text.contains("checks are paused"))
    });
    tampered.execute_batch("DROP TRIGGER read_only").unwrap();
    host.set_clock(DUE + 2 * DAY);
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        outcomes(&host).is_empty() && check_ins(&host, chat).is_empty(),
        "no task was claimed"
    );
    let log = std::fs::read_to_string(&log).unwrap();
    assert_eq!(log.matches("checks are paused").count(), 1, "{log}");
    assert!(
        log.contains("attempt to write a readonly database"),
        "{log}"
    );
}

#[test]
fn after_a_turn_read_web_text_a_command_that_adds_a_source_is_refused() {
    let host = host();
    let owner = host.owner();
    let (objective, _) = objective_with(&host, &owner, "made", json!([{"kind":"jet"}]));
    let table = [
        (
            "create with a source",
            create("new", json!([{"kind":"web","search":"kites"}])),
            Some("writeAfterWebText"),
        ),
        (
            "edit that changes the sources",
            objectives(
                json!({"action":"edit","id":objective,"sources":[{"kind":"web","search":"kites"}]}),
            ),
            Some("writeAfterWebText"),
        ),
        (
            "edit that leaves the sources",
            objectives(json!({"action":"edit","id":objective,"title":"New title"})),
            None,
        ),
    ];
    let mut steps = vec![json!({"fetch": "docs.example.com/kites"})];
    steps.extend(table.iter().map(|(_, step, _)| step.clone()));
    let results = run_turn(
        &host,
        &owner,
        "web-then-sources",
        "Read https://docs.example.com/kites",
        json!(steps),
    );
    for (index, (name, _, kind)) in table.iter().enumerate() {
        match kind {
            Some(kind) => assert_eq!(
                error_kind(&results[index + 1]),
                kind,
                "{name}: {}",
                results[index + 1]
            ),
            None => assert_eq!(
                results[index + 1]["isError"],
                false,
                "{name}: {}",
                results[index + 1]
            ),
        }
    }
    let sources = query::<i64>(&host, "SELECT count(*) FROM objective_sources");
    assert_eq!(sources, [1], "no source was added");
    let _ = tool;
}

#[test]
fn a_change_to_the_objective_during_a_check_drops_its_result_and_the_check_runs_again() {
    let host = host();
    let owner = host.owner();
    let (objective, chat) = objective_with(&host, &owner, "made", json!([{"kind":"jet"}]));
    script(&host, json!([{"wait": "go"}, say("Stale words")]));
    host.set_clock(DUE);
    wait_for_running_check(&host);
    // The user renames the objective in another chat while the check runs.
    let edit = objectives(json!({"action":"edit","id":objective,"title":"Ship the big kite"}));
    run_turn(&host, &owner, "rename", "Rename it.", json!([edit]));
    std::fs::write(host.dir.path().join("go"), "").unwrap();
    wait_for_runs(&host, 1);
    assert_eq!(outcomes(&host), ["stale"]);
    assert!(check_ins(&host, chat).is_empty(), "the result was dropped");
    assert_eq!(
        open_tasks(&host)[0].0,
        DUE + MINUTE,
        "it runs again in a minute"
    );
    assert_eq!(
        query::<i64>(&host, "SELECT attempts FROM agent_tasks"),
        [0],
        "not counted"
    );

    script(&host, json!([say("Fresh words")]));
    host.set_clock(DUE + MINUTE);
    wait_for_runs(&host, 2);
    assert_eq!(outcomes(&host), ["stale", "spoke"]);
    assert_eq!(check_ins(&host, chat).len(), 1);
}
