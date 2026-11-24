//! Prove, through the real host with the provider stand-in and the seeded accounts, what the
//! right-hand plan pane reads and what its one-tap controls do: the read keeps everything private
//! to its owner, each tap acts on the owner's own things and raises their version, Jet is told of
//! each tap once, and the user's event stream carries each change.
use super::{
    objectives::{MANAGER, create, database, objectives, run_turn},
    support::{Host, OWNER, User, agent, host},
};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    sync::mpsc,
    time::Duration,
};

const OUTSIDER: &str = "admin3@gmail.com";
const PRIVATE_NOTE: &str = "I think this will fail";
const PUBLIC_NOTE: &str = "The frame is built";
const SECRET_TITLE: &str = "Secret plan";
const CHECK_WHY: &str = "see whether the frame is built";

pub(super) fn user_id(host: &Host, email: &str) -> i64 {
    database(host)
        .query_row("SELECT id FROM users WHERE email = ?1", [email], |row| {
            row.get(0)
        })
        .unwrap()
}

/// The owner agrees a kite objective with a public and a private note, and a second objective
/// that is shared with nobody. Both live in the main chat.
fn owner_plans(host: &Host, owner: &User) {
    let secret = objectives(json!({
        "action":"create","title":SECRET_TITLE,"deliverable":"A plan nobody sees",
        "start":"2099-06-01","due":"2099-08-01","steps":[],"sources":[{"kind":"jet"}],
        "check":{"at":"2099-06-09T09:00","why":"secret check reason"},"chat":"this"
    }));
    let note = |moved: &str, private: bool| {
        objectives(
            json!({"action":"note","id":1,"status":"on track","moved":moved,"private":private}),
        )
    };
    let script = json!([
        create("this", json!([{"kind":"jet"}])),
        note(PUBLIC_NOTE, false),
        note(PRIVATE_NOTE, true),
        secret
    ]);
    run_turn(host, owner, "plan", "I am building a kite.", script);
}

/// Seeds one finished run of the first task, the way the scheduler will leave it.
fn seed_run(host: &Host) {
    let db = rusqlite::Connection::open(host.dir.path().join("jet.sqlite3")).unwrap();
    db.execute(
        "INSERT INTO task_runs (task_id, started_at, ended_at, outcome, found, sources_read, tokens)
         VALUES (1, 1767225600, 1767225660, 'spoke', 'The frame is half built', '[\"github octo/jet\"]', 900)",
        [],
    )
    .unwrap();
}

/// Shares the first objective with the manager and with a team the owner belongs to, through
/// the pane's own routes.
fn share_with_manager(host: &Host, owner: &User) {
    let manager = user_id(host, MANAGER);
    let db = rusqlite::Connection::open(host.dir.path().join("jet.sqlite3")).unwrap();
    db.execute(
        "INSERT INTO team_members (team_id, user_id) SELECT t.id, ?1 FROM teams t WHERE t.name = 'Commercial'",
        [user_id(host, OWNER)],
    )
    .unwrap();
    let team: i64 = db
        .query_row(
            "SELECT id FROM teams WHERE name = 'Commercial'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let (status, card) = owner.post(
        "/api/objectives/1/share-proposals",
        json!({"people":[manager],"teams":[team]}),
    );
    assert_eq!(status, 200, "{card}");
    let (status, applied) = owner.post(
        &format!("/api/shares/proposals/{}/apply", card["id"]),
        json!({"people":[manager],"teams":[team]}),
    );
    assert_eq!(status, 200, "{applied}");
}

fn keys(value: &Value) -> Vec<&str> {
    let mut keys: Vec<_> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    keys
}

#[test]
fn the_pane_reads_the_owners_plan_and_gives_a_colleague_only_what_is_shared() {
    let host = host();
    let (owner, manager) = (host.owner(), host.sign_in_as(MANAGER));
    owner_plans(&host, &owner);
    share_with_manager(&host, &owner);
    seed_run(&host);

    let mine = owner.get("/api/pane");
    assert_eq!(mine["timeZone"], "America/New_York");
    let (kite, secret) = (&mine["objectives"][0], &mine["objectives"][1]);
    assert_eq!(
        (&kite["title"], &kite["durationDays"], &kite["private"]),
        (&json!("Ship the kite"), &json!(30), &json!(false))
    );
    assert_eq!(kite["sharedWith"]["people"][0]["name"], "Admin 123");
    assert_eq!(kite["sharedWith"]["teams"][0]["name"], "Commercial");
    assert_eq!(kite["steps"].as_array().unwrap().len(), 2);
    assert!(
        kite["daysLeft"].is_i64() && kite["chatId"].is_i64() && kite["deliverable"].is_string()
    );
    let notes = kite["notes"].as_array().unwrap();
    assert_eq!(
        (notes[1]["moved"].as_str(), &notes[1]["isPrivate"]),
        (Some(PRIVATE_NOTE), &json!(true)),
        "the owner reads their private note"
    );
    assert_eq!(
        (&secret["title"], &secret["private"]),
        (&json!(SECRET_TITLE), &json!(true))
    );
    let tasks = mine["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 2);
    let first = &tasks[0];
    assert_eq!(
        (
            &first["why"],
            &first["kind"],
            &first["setBy"],
            &first["isDefault"]
        ),
        (
            &json!(CHECK_WHY),
            &json!("check"),
            &json!("jet"),
            &json!(false)
        )
    );
    assert_eq!(
        (
            &first["timeZone"],
            &first["localTime"],
            &first["objectiveTitle"]
        ),
        (
            &json!("America/New_York"),
            &json!("2099-06-08T09:00"),
            &json!("Ship the kite")
        )
    );
    let run = &mine["runs"][0];
    assert_eq!(
        (
            &run["found"],
            &run["outcome"],
            &run["tokens"],
            &run["sourcesRead"]
        ),
        (
            &json!("The frame is half built"),
            &json!("spoke"),
            &json!(900),
            &json!(["github octo/jet"])
        )
    );
    assert_eq!(mine["sharedWithMe"], json!([]));

    let theirs = manager.get("/api/pane");
    assert_eq!(
        (&theirs["objectives"], &theirs["tasks"], &theirs["runs"]),
        (&json!([]), &json!([]), &json!([]))
    );
    let shared = theirs["sharedWithMe"].as_array().unwrap();
    assert_eq!(shared.len(), 1, "{theirs}");
    assert_eq!(
        keys(&shared[0]),
        [
            "daysLeft", "due", "id", "latest", "owner", "status", "steps", "title"
        ]
    );
    assert_eq!(shared[0]["owner"], "Shaun");
    assert_eq!(shared[0]["latest"]["moved"], PUBLIC_NOTE);
    let body = theirs.to_string();
    for hidden in [
        PRIVATE_NOTE,
        SECRET_TITLE,
        CHECK_WHY,
        "chatId",
        "octo/jet",
        "sources",
    ] {
        assert!(
            !body.contains(hidden),
            "the colleague's read holds {hidden}: {body}"
        );
    }
}

#[test]
fn another_user_reads_nothing_and_every_tap_answers_not_found() {
    let host = host();
    let (owner, outsider) = (host.owner(), host.sign_in_as(OUTSIDER));
    owner_plans(&host, &owner);
    let before = owner.get("/api/pane");

    let nothing = outsider.get("/api/pane");
    for part in ["objectives", "tasks", "runs", "sharedWithMe"] {
        assert_eq!(nothing[part], json!([]), "{part}");
    }

    // Each row: the request on a thing of the owner's, and on one that does not exist, where the
    // missing ids 9001 and 9002 stand in the answer for the real ones.
    type Request = fn(&User, i64, i64) -> (u16, Value);
    let rows: [(&str, Request); 4] = [
        ("tick", |user, o, s| {
            user.put(
                &format!("/api/objectives/{o}/steps/{s}"),
                json!({"done":true}),
            )
        }),
        ("snooze", |user, _, t| {
            user.post(&format!("/api/tasks/{t}/snooze"), json!({}))
        }),
        ("cancel", |user, _, t| {
            user.post(&format!("/api/tasks/{t}/cancel"), json!({}))
        }),
        ("note flip", |user, o, n| {
            user.put(
                &format!("/api/objectives/{o}/notes/{n}"),
                json!({"private":true}),
            )
        }),
    ];
    for (name, request) in rows {
        let (status, body) = request(&outsider, 1, 1);
        let (missing_status, missing) = request(&outsider, 9001, 9002);
        assert_eq!((status, missing_status), (404, 404), "{name}: {body}");
        let expected = missing
            .to_string()
            .replace("9001", "1")
            .replace("9002", "1");
        assert_eq!(
            body.to_string(),
            expected,
            "{name} answers as for a missing thing"
        );
    }
    assert_eq!(
        owner.get("/api/pane"),
        before,
        "nothing of the owner's changed"
    );
}

/// The next 08:00 in New York strictly after now.
fn next_eight() -> (i64, String) {
    let zone = jiff::tz::TimeZone::get("America/New_York").unwrap();
    let now = jiff::Timestamp::now();
    let mut day = zone.to_datetime(now).date();
    loop {
        let morning = day.at(8, 0, 0, 0);
        let instant = zone.to_ambiguous_timestamp(morning).compatible().unwrap();
        if instant > now {
            return (
                instant.as_second(),
                morning.strftime("%Y-%m-%dT%H:%M").to_string(),
            );
        }
        day = day.tomorrow().unwrap();
    }
}

#[test]
fn a_tick_a_snooze_and_a_cancel_change_what_the_pane_says_and_raise_the_version() {
    let host = host();
    let owner = host.owner();
    owner_plans(&host, &owner);
    let before = owner.get("/api/pane");
    let (kite, check) = (&before["objectives"][0], &before["tasks"][0]);
    let (second_check, step) = (
        before["tasks"][1]["id"].as_i64().unwrap(),
        kite["steps"][0]["id"].as_i64().unwrap(),
    );
    let (kite_id, check_id) = (kite["id"].as_i64().unwrap(), check["id"].as_i64().unwrap());
    let (kite_version, check_version) = (
        kite["version"].as_u64().unwrap(),
        check["version"].as_u64().unwrap(),
    );
    let (eight, local) = next_eight();

    let (status, ticked) = owner.put(
        &format!("/api/objectives/{kite_id}/steps/{step}"),
        json!({"done":true}),
    );
    assert_eq!(
        (status, &ticked["version"]),
        (200, &json!(kite_version + 1)),
        "{ticked}"
    );
    let (status, snoozed) = owner.post(&format!("/api/tasks/{check_id}/snooze"), json!({}));
    assert_eq!(
        (status, &snoozed["version"]),
        (200, &json!(check_version + 1)),
        "{snoozed}"
    );
    let (status, cancelled) = owner.post(&format!("/api/tasks/{second_check}/cancel"), json!({}));
    assert_eq!(status, 200, "{cancelled}");
    assert_eq!(cancelled["state"], "cancelled");

    let after = owner.get("/api/pane");
    assert!(
        after["objectives"][0]["steps"][0]["doneAt"].is_u64(),
        "the step is ticked"
    );
    let moved = after["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["id"] == check_id)
        .unwrap();
    assert_eq!(
        (
            &moved["dueAt"],
            &moved["localTime"],
            &moved["timeZone"],
            &moved["setBy"]
        ),
        (
            &json!(eight),
            &json!(local),
            &json!("America/New_York"),
            &json!("user")
        ),
        "the next 08:00 in the user's zone"
    );
    assert_eq!(
        after["tasks"].as_array().unwrap().len(),
        1,
        "the cancelled task is no longer open"
    );
    let version = database(&host)
        .query_row(
            "SELECT version FROM agent_tasks WHERE id = ?1",
            [second_check],
            |row| row.get::<_, i64>(0),
        )
        .unwrap();
    assert_eq!(version, before["tasks"][1]["version"].as_i64().unwrap() + 1);

    let (status, unticked) = owner.put(
        &format!("/api/objectives/{kite_id}/steps/{step}"),
        json!({"done":false}),
    );
    assert_eq!(
        (status, &unticked["steps"][0]["doneAt"]),
        (200, &Value::Null)
    );
}

type Tap = fn(&User, &Value) -> (u16, Value);

/// The taps of the pane on the first objective, its first task and its second note.
fn taps() -> [(&'static str, Tap); 4] {
    [
        ("tick", |user, pane| {
            let step = &pane["objectives"][0]["steps"][0]["id"];
            user.put(
                &format!("/api/objectives/1/steps/{step}"),
                json!({"done":true}),
            )
        }),
        ("snooze", |user, pane| {
            user.post(
                &format!("/api/tasks/{}/snooze", pane["tasks"][0]["id"]),
                json!({}),
            )
        }),
        ("cancel", |user, pane| {
            user.post(
                &format!("/api/tasks/{}/cancel", pane["tasks"][0]["id"]),
                json!({}),
            )
        }),
        ("note flip", |user, pane| {
            let note = &pane["objectives"][0]["notes"][0]["id"];
            user.put(
                &format!("/api/objectives/1/notes/{note}"),
                json!({"private":true}),
            )
        }),
    ]
}

#[test]
fn tap_is_told_to_jet_on_next_turn() {
    let rows: [(&str, &str); 4] = [
        (
            "tick",
            "tapped step \"Build the frame\" of \"Ship the kite\" in the pane: it is now marked done",
        ),
        (
            "snooze",
            "tapped Snooze in the pane on your task \"see whether the frame is built\"",
        ),
        (
            "cancel",
            "tapped Cancel in the pane on your task \"see whether the frame is built\": it is cancelled",
        ),
        (
            "note flip",
            "tapped your note \"The frame is built\" on \"Ship the kite\" in the pane: it is now private",
        ),
    ];
    for ((name, tap), (row, told)) in taps().into_iter().zip(rows) {
        assert_eq!(name, row);
        let host = host();
        let owner = host.owner();
        owner_plans(&host, &owner);
        let (status, answer) = tap(&owner, &owner.get("/api/pane"));
        assert_eq!(status, 200, "{name}: {answer}");
        let prompt = || std::fs::read_to_string(host.dir.path().join("facade-prompt.txt")).unwrap();
        let idle = json!([{"tool":"people_list","arguments":{}}]);
        run_turn(&host, &owner, "after-tap", "Thanks.", idle.clone());
        assert!(prompt().contains(told), "{name}: {}", prompt());
        run_turn(&host, &owner, "after-that", "And again.", idle);
        assert!(
            !prompt().contains("in the pane"),
            "{name} is told once: {}",
            prompt()
        );
    }
}

/// Reads the user's event stream on a thread of its own.
pub(super) fn listen(user: &User) -> mpsc::Receiver<Value> {
    let mut response = agent()
        .get(format!("{}/api/events", user.url))
        .header("cookie", &user.cookie)
        .header("origin", &user.origin)
        .call()
        .unwrap();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(response.body_mut().as_reader()).lines() {
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

pub(super) fn pane_changed(events: &mpsc::Receiver<Value>) -> bool {
    while let Ok(event) = events.recv_timeout(Duration::from_secs(10)) {
        if event["kind"] == "event" && event["data"]["event"]["kind"] == "paneChanged" {
            return true;
        }
    }
    false
}

#[test]
fn the_event_stream_carries_a_change_for_each_tap_and_each_objectives_update() {
    let host = host();
    let owner = host.owner();
    owner_plans(&host, &owner);
    let pane = owner.get("/api/pane");
    type Row<'a> = (&'a str, Box<dyn Fn() + 'a>);
    let mut rows: Vec<Row> = Vec::new();
    for (name, tap) in taps() {
        // The cancel row runs on the task the snooze row left open.
        let (owner, pane) = (owner.clone(), pane.clone());
        rows.push((
            name,
            Box::new(move || assert_eq!(tap(&owner, &pane).0, 200)),
        ));
    }
    let note = objectives(
        json!({"action":"note","id":1,"status":"at risk","moved":"Wind","private":false}),
    );
    let (turn_host, turn_owner) = (&host, owner.clone());
    rows.push((
        "objectives_update",
        Box::new(move || {
            run_turn(
                turn_host,
                &turn_owner,
                "note",
                "A note.",
                json!([note.clone()]),
            );
        }),
    ));
    for (name, act) in rows {
        let events = listen(&owner);
        act();
        assert!(pane_changed(&events), "{name} sent no paneChanged");
    }
    // A colleague the objective is shared with hears of a tap on it too.
    share_with_manager(&host, &owner);
    let viewer = host.sign_in_as(MANAGER);
    let events = listen(&viewer);
    let (_, tick) = taps().into_iter().next().unwrap();
    assert_eq!(tick(&owner, &pane).0, 200);
    assert!(
        pane_changed(&events),
        "the viewer's stream sent no paneChanged"
    );
}
