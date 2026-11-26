//! Prove, through the real host with the provider stand-in, the test clock and the seeded accounts,
//! that the task list reads and changes every task and goal of a user from the one table: each
//! change shows in the list and in the plan pane, tells only that user's pages and the goal's
//! viewers, is told to Jet once as one line per task, and another user reaches nothing of it.
use super::{
    objectives::{MANAGER, data, database, error_kind, objectives, run_turn, run_turn_in, tool},
    pane::{OUTSIDER, listen, pane_changed, share_with_manager, user_id},
    support::{Host, OWNER, User, agent, host},
};
use serde_json::{Value, json};
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

const GOAL: &str = "Ship the kite page";
const SPEC: &str = "Draft the spec";

fn utc(text: &str) -> u64 {
    text.parse::<jiff::Timestamp>()
        .unwrap()
        .as_second()
        .unsigned_abs()
}

/// Wed 25 Nov 2026, 10:00 in New York, the zone every message of these tests carries.
fn wednesday() -> u64 {
    utc("2026-11-25T15:00:00Z")
}

/// One goal agreed with Jet on Wednesday, with the step "Draft the spec" for that day.
struct World {
    host: Host,
    owner: User,
    goal: i64,
    goal_chat: i64,
    main: i64,
    spec: i64,
}

fn world() -> World {
    let host = host();
    host.set_clock(wednesday());
    let owner = host.owner();
    let goal = json!({
        "action":"create","title":GOAL,"deliverable":"The kite page live at /kite",
        "start":"2026-11-20","due":"2026-11-28","steps":[{"title":SPEC,"due":"2026-11-25"}],
        "sources":[{"kind":"jet"}],"check":{"at":"2026-11-27T09:00","why":"see how the page goes"}
    });
    run_turn(
        &host,
        &owner,
        "plan",
        "I am shipping the kite page.",
        json!([objectives(goal)]),
    );
    let list = owner.get("/api/task-list");
    let number = |value: &Value| value.as_i64().unwrap();
    World {
        goal: number(&list["goals"][0]["id"]),
        goal_chat: number(&list["goals"][0]["chatId"]),
        main: number(&list["mainChatId"]),
        spec: number(&list["tasks"][0]["id"]),
        host,
        owner,
    }
}

impl World {
    /// Adds a task through the list and gives its id.
    fn add(&self, body: Value) -> i64 {
        let (status, list) = self.owner.post("/api/task-list/tasks", body);
        assert_eq!(status, 200, "{list}");
        list["changed"].as_i64().unwrap()
    }

    fn patch(&self, id: i64, body: Value) -> Value {
        let (status, list) = self
            .owner
            .patch(&format!("/api/task-list/tasks/{id}"), body);
        assert_eq!(status, 200, "{list}");
        list
    }

    /// The lines about the step that wait for Jet, each with its chat.
    fn lines(&self, step: i64) -> Vec<(i64, String)> {
        database(&self.host)
            .prepare("SELECT chat_id, line FROM pane_taps WHERE step_id = ?1 AND announced = 0 ORDER BY id")
            .unwrap()
            .query_map([step], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    /// Every line that waits for Jet in the chat.
    fn waiting(&self, chat: i64) -> Vec<String> {
        database(&self.host)
            .prepare("SELECT line FROM pane_taps WHERE chat_id = ?1 AND announced = 0 ORDER BY id")
            .unwrap()
            .query_map([chat], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    /// Sends a message in the chat, so that Jet hears what waits there, and gives what Jet was sent.
    fn tell(&self, chat: i64, id: &str) -> String {
        let idle = json!([tool("people_list")]);
        run_turn_in(&self.host, &self.owner, Some(chat), id, "Thanks.", idle);
        std::fs::read_to_string(self.host.dir.path().join("facade-prompt.txt")).unwrap()
    }

    /// Every step's id, position and date.
    fn rows(&self) -> Vec<(i64, i64, Option<String>)> {
        database(&self.host)
            .prepare("SELECT id, position, due_date FROM objective_steps ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn tap_count(&self) -> i64 {
        database(&self.host)
            .query_row("SELECT count(*) FROM pane_taps", [], |row| row.get(0))
            .unwrap()
    }

    fn version(&self) -> i64 {
        database(&self.host)
            .query_row(
                "SELECT version FROM objectives WHERE id = ?1",
                [self.goal],
                |row| row.get(0),
            )
            .unwrap()
    }
}

fn ids(list: &Value, part: &str) -> Vec<i64> {
    list[part]
        .as_array()
        .unwrap()
        .iter()
        .map(|task| task["id"].as_i64().unwrap())
        .collect()
}

/// The open tasks of the day, in their order.
fn day(list: &Value, name: &str) -> Vec<i64> {
    list["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|task| task["day"] == name)
        .map(|task| task["id"].as_i64().unwrap())
        .collect()
}

fn task(list: &Value, id: i64) -> &Value {
    ["tasks", "done"]
        .iter()
        .flat_map(|part| list[*part].as_array().unwrap())
        .find(|task| task["id"] == id)
        .unwrap_or_else(|| panic!("no task {id} in {list}"))
}

/// True when no paneChanged reaches the stream within a short while.
fn quiet(events: &mpsc::Receiver<Value>) -> bool {
    let deadline = Instant::now() + Duration::from_millis(400);
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        match events.recv_timeout(left) {
            Ok(event) if event["data"]["event"]["kind"] == "paneChanged" => return false,
            Ok(_) => {}
            Err(_) => break,
        }
    }
    true
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
fn the_read_carries_every_field_of_the_contract() {
    let w = world();
    let sketch = w.add(json!({"title":"Sketch the layout","day":"today","goalId":w.goal}));
    w.patch(sketch, json!({"state":"done"}));
    let list = w.owner.get("/api/task-list");
    assert_eq!(
        keys(&list),
        [
            "changed",
            "done",
            "doneCount",
            "doneKeptDays",
            "goals",
            "mainChatId",
            "tasks",
            "timeZone",
            "today",
            "tomorrow"
        ]
    );
    let task_keys = [
        "chatId",
        "date",
        "day",
        "doneAt",
        "goalId",
        "goalTitle",
        "id",
        "late",
        "startedAt",
        "state",
        "title",
    ];
    assert_eq!(keys(&list["tasks"][0]), task_keys);
    assert_eq!(keys(&list["done"][0]), task_keys);
    let goal = &list["goals"][0];
    assert_eq!(
        keys(goal),
        [
            "chatId",
            "daysLeft",
            "deliverable",
            "done",
            "due",
            "id",
            "state",
            "status",
            "tasks",
            "title"
        ]
    );
    assert_eq!(
        (&list["timeZone"], &list["today"], &list["tomorrow"]),
        (
            &json!("America/New_York"),
            &json!("2026-11-25"),
            &json!("2026-11-26")
        )
    );
    assert_eq!(
        (&list["doneKeptDays"], &list["doneCount"], &list["changed"]),
        (&json!(90), &json!(1), &Value::Null)
    );
    assert_eq!(
        [
            &goal["daysLeft"],
            &goal["state"],
            &goal["tasks"],
            &goal["done"],
            &goal["status"]
        ],
        [
            &json!(3),
            &json!("in_progress"),
            &json!(2),
            &json!(1),
            &json!("active")
        ]
    );
    let spec = &list["tasks"][0];
    assert_eq!(
        [
            &spec["title"],
            &spec["goalTitle"],
            &spec["day"],
            &spec["late"],
            &spec["state"]
        ],
        [
            &json!(SPEC),
            &json!(GOAL),
            &json!("today"),
            &json!(false),
            &json!("not_started")
        ]
    );
    let done = &list["done"][0];
    assert_eq!(
        [&done["id"], &done["day"], &done["late"], &done["state"]],
        [&json!(sketch), &Value::Null, &Value::Null, &json!("done")]
    );
    assert!(done["doneAt"].is_u64(), "{done}");
}

#[test]
fn a_task_marked_done_in_the_list_is_told_once_in_its_goals_chat() {
    let w = world();
    w.patch(w.spec, json!({"state":"in_progress"}));
    assert_eq!(w.lines(w.spec).len(), 1, "starting it keeps one line");
    let (events, version) = (listen(&w.owner), w.version());

    let list = w.patch(w.spec, json!({"state":"done"}));
    assert_eq!(w.version(), version + 1, "done raises the goal's version");
    assert!(!ids(&list, "tasks").contains(&w.spec), "it left the day");
    let done = &list["done"][0];
    assert_eq!(
        (&done["id"], &done["state"], &list["changed"]),
        (&json!(w.spec), &json!("done"), &json!(w.spec))
    );
    assert!(
        done["doneAt"].is_u64() && done["startedAt"].is_u64(),
        "{done}"
    );
    assert!(pane_changed(&events), "the user's pages are told");
    let line = format!(
        "[The user changed the task \"{SPEC}\" (step {}) of the goal \"{GOAL}\" in their task list: done, for Wed 25 Nov 2026.]",
        w.spec
    );
    assert_eq!(
        w.lines(w.spec),
        [(w.goal_chat, line.clone())],
        "one line, the newest"
    );
    assert_eq!(
        w.waiting(w.main),
        Vec::<String>::new(),
        "nothing in the main chat"
    );
    let pane = w.owner.get("/api/pane");
    assert!(
        pane["objectives"][0]["steps"][0]["doneAt"].is_u64(),
        "the pane reads the same row"
    );

    assert!(
        w.tell(w.goal_chat, "hi").contains(&line),
        "told before the next message"
    );
    assert!(
        !w.tell(w.goal_chat, "again").contains("in their task list"),
        "and told once"
    );
}

#[test]
fn moving_a_task_to_tomorrow_writes_tomorrows_date_and_its_place() {
    let w = world();
    let bank = w.add(json!({"title":"Call the bank","day":"today"}));
    let venue = w.add(json!({"title":"Book the venue","day":"tomorrow","goalId":w.goal}));
    w.tell(w.main, "heard-bank");
    w.tell(w.goal_chat, "heard-venue");
    let version = w.version();

    let list = w.patch(bank, json!({"day":"tomorrow","after":null}));
    assert_eq!(
        (day(&list, "today"), day(&list, "tomorrow")),
        (vec![w.spec], vec![bank, venue])
    );
    assert_eq!(task(&list, bank)["date"], "2026-11-26");
    let place = |id| w.rows().into_iter().find(|row| row.0 == id).unwrap().1;
    assert!(place(w.spec) < place(bank) && place(bank) < place(venue));
    let line = format!(
        "[The user changed the task \"Call the bank\" (step {bank}) in their task list: not started, for Thu 26 Nov 2026.]"
    );
    assert_eq!(w.lines(bank), [(w.main, line.clone())]);

    let list = w.patch(bank, json!({"after":venue}));
    assert_eq!(day(&list, "tomorrow"), [venue, bank]);
    assert_eq!(
        w.version(),
        version,
        "neither move raises the goal's version"
    );
    assert_eq!(w.lines(bank), [(w.main, line)], "a reorder is not told");
    assert_eq!(w.lines(venue), [], "nor is the task it passed");
}

#[test]
fn tomorrows_task_is_todays_after_midnight_with_no_write() {
    let w = world();
    w.host.set_clock(utc("2026-11-26T04:59:00Z"));
    let venue = w.add(json!({"title":"Book the venue","day":"tomorrow","goalId":w.goal}));
    let before = (w.rows(), w.tap_count());

    w.host.set_clock(utc("2026-11-26T05:01:00Z"));
    let list = w.owner.get("/api/task-list");
    assert_eq!(list["today"], "2026-11-26");
    assert_eq!(
        (&task(&list, venue)["day"], &task(&list, venue)["late"]),
        (&json!("today"), &json!(false))
    );
    assert_eq!(
        (&task(&list, w.spec)["day"], &task(&list, w.spec)["late"]),
        (&json!("today"), &json!(true)),
        "yesterday's open task is carried"
    );
    assert_eq!((w.rows(), w.tap_count()), before, "nothing was written");
}

#[test]
fn moving_a_deleted_task_is_refused_as_gone_and_tells_jet_nothing() {
    let w = world();
    let venue = w.add(json!({"title":"Book the venue","day":"tomorrow","goalId":w.goal}));
    let bank = w.add(json!({"title":"Call the bank","day":"today"}));
    w.tell(w.main, "heard-bank");

    let (status, list) = w.owner.delete(&format!("/api/task-list/tasks/{bank}"));
    assert_eq!((status, &list["changed"]), (200, &Value::Null), "{list}");
    assert!(!ids(&list, "tasks").contains(&bank));
    let deleted = format!("[The user deleted the task \"Call the bank\" (step {bank}).]");
    assert_eq!(w.lines(bank), [(w.main, deleted)]);
    let again = w.add(json!({"title":"Call the bank","day":"today"}));
    assert!(again > bank, "the id {bank} is never used again");
    let added =
        format!("[The user added the task \"Call the bank\" (step {again}) in their task list");
    assert!(
        w.lines(again)[0].1.starts_with(&added),
        "{:?}",
        w.lines(again)
    );

    let before = (w.rows(), w.tap_count());
    let events = listen(&w.owner);
    let (status, refused) = w.owner.patch(
        &format!("/api/task-list/tasks/{bank}"),
        json!({"day":"tomorrow"}),
    );
    assert_eq!(
        (status, refused),
        (
            404,
            json!({"kind":"taskGone","message":"That task is no longer in your list"})
        )
    );
    assert_eq!((w.rows(), w.tap_count()), before, "no write and no line");
    assert!(quiet(&events), "a refusal changes nothing to tell");
    assert!(w.rows().iter().any(|row| row.0 == venue));
}

#[test]
fn deleting_a_goals_chat_takes_its_open_tasks_off_the_list() {
    let w = world();
    let sketch = w.add(json!({"title":"Sketch the layout","day":"today","goalId":w.goal}));
    w.patch(sketch, json!({"state":"done"}));
    let post = w.add(json!({"title":"Write the launch post","day":"later","goalId":w.goal}));
    let events = listen(&w.owner);

    assert_eq!(w.host.delete(&format!("/api/chats/{}", w.goal_chat)), 200);
    assert!(pane_changed(&events));
    let list = w.owner.get("/api/task-list");
    assert_eq!(list["goals"], json!([]));
    assert_eq!(
        (ids(&list, "tasks"), ids(&list, "done")),
        (vec![], vec![sketch])
    );
    let kept: Vec<i64> = w.rows().into_iter().map(|row| row.0).collect();
    assert_eq!(
        kept,
        [w.spec, sketch, post],
        "the rows stay with the dropped goal"
    );
    let listed = run_turn(
        &w.host,
        &w.owner,
        "list",
        "What is left?",
        json!([tool("objectives_list")]),
    );
    let dropped = &data(&listed[0])["objectives"][0];
    assert_eq!(dropped["status"], "dropped");
    assert_eq!(
        ids(dropped, "steps"),
        [w.spec, sketch, post],
        "Jet still lists them"
    );
    assert_eq!(
        w.waiting(w.main),
        Vec::<String>::new(),
        "the drop is not told"
    );
}

#[test]
fn the_purge_spares_open_goals_and_takes_long_closed_ones() {
    let host = host();
    host.set_clock(wednesday());
    let (owner, outsider) = (host.owner(), host.sign_in_as(OUTSIDER));
    let goal = |title: &str| {
        objectives(json!({
            "action":"create","title":title,"deliverable":"Done","start":"2026-08-01","due":"2026-12-01",
            "steps":[],"sources":[{"kind":"jet"}],"check":{"at":"2026-11-27T09:00","why":"look"}
        }))
    };
    let script = json!([
        goal("Open"),
        goal("Closed in August"),
        goal("Closed in November")
    ]);
    run_turn(&host, &owner, "goals", "Three goals.", script);
    let (events, others) = (listen(&owner), listen(&outsider));
    let (august, november) = (utc("2026-08-20T12:00:00Z"), utc("2026-11-01T12:00:00Z"));
    rusqlite::Connection::open(host.dir.path().join("jet.sqlite3"))
        .unwrap()
        .execute_batch(&format!(
            "BEGIN;
             UPDATE objectives SET status = 'done', closed_at = {} WHERE id = 2;
             UPDATE objectives SET status = 'done', closed_at = {november} WHERE id = 3;
             INSERT INTO objective_steps (id, user_id, objective_id, position, title, done_at) VALUES
                 (60, {user}, NULL, 1, 'Of no goal', {august}),
                 (61, {user}, 1, 2, 'Of an open goal', {august}),
                 (62, {user}, 2, 3, 'Of a goal closed in August', {august}),
                 (64, {user}, 2, 4, 'Open, of a goal closed in August', NULL),
                 (63, {user}, 3, 5, 'Of a goal closed lately', {august}),
                 (65, {user}, NULL, 6, 'Of no goal, done lately', {november}),
                 (66, {user}, 2, 7, 'Of a goal closed in August, done lately', {november});
             COMMIT;",
            august + 86_400,
            user = user_id(&host, OWNER),
        ))
        .unwrap();

    let left = || -> Vec<i64> {
        database(&host)
            .prepare("SELECT id FROM objective_steps ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    let deadline = Instant::now() + Duration::from_secs(8);
    while left() != [61, 63, 64, 65, 66] {
        assert!(Instant::now() < deadline, "the purge left {:?}", left());
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(pane_changed(&events), "the owner's pages are told");
    assert!(quiet(&others), "no one else is");
    let lines: i64 = database(&host)
        .query_row("SELECT count(*) FROM pane_taps", [], |row| row.get(0))
        .unwrap();
    assert_eq!(lines, 0, "Jet is not told of the purge");
}

#[test]
fn another_users_tasks_and_goals_are_gone() {
    let w = world();
    let outsider = w.host.sign_in_as(OUTSIDER);
    let before = (w.rows(), w.tap_count(), w.owner.get("/api/task-list"));
    let (spec, goal) = (w.spec, w.goal);
    type Request = fn(&User, i64, i64) -> (u16, Value);
    let rows: [(&str, Request); 4] = [
        ("rename", |user, task, _| {
            user.patch(
                &format!("/api/task-list/tasks/{task}"),
                json!({"title":"x"}),
            )
        }),
        ("delete", |user, task, _| {
            user.delete(&format!("/api/task-list/tasks/{task}"))
        }),
        ("goal", |user, _, goal| {
            user.patch(
                &format!("/api/task-list/goals/{goal}"),
                json!({"title":"x"}),
            )
        }),
        ("add", |user, _, goal| {
            user.post(
                "/api/task-list/tasks",
                json!({"title":"x","day":"today","goalId":goal}),
            )
        }),
    ];
    for (name, request) in rows {
        let theirs = request(&outsider, spec, goal);
        let missing = request(&outsider, 9001, 9001);
        assert_eq!(theirs, missing, "{name} answers as for a missing one");
        assert_eq!(theirs.0, 404, "{name}: {}", theirs.1);
    }
    let gone = |kind: &str, message: &str| json!({"kind":kind,"message":message});
    let (_, task) = outsider.patch(
        &format!("/api/task-list/tasks/{spec}"),
        json!({"title":"x"}),
    );
    assert_eq!(
        task,
        gone("taskGone", "That task is no longer in your list")
    );
    let (_, goal) = outsider.patch(
        &format!("/api/task-list/goals/{goal}"),
        json!({"title":"x"}),
    );
    assert_eq!(
        goal,
        gone("goalGone", "That goal is no longer in your list")
    );
    let theirs = outsider.get("/api/task-list");
    assert_eq!(
        (&theirs["goals"], &theirs["tasks"], &theirs["done"]),
        (&json!([]), &json!([]), &json!([]))
    );
    assert_eq!(
        (w.rows(), w.tap_count(), w.owner.get("/api/task-list")),
        before
    );
}

#[test]
fn a_corrected_mark_leaves_one_true_line_for_jet() {
    let w = world();
    let venue = w.add(json!({"title":"Book the venue","day":"tomorrow","goalId":w.goal}));
    w.tell(w.goal_chat, "heard-venue");
    let line = |state: &str| {
        format!(
            "[The user changed the task \"Book the venue\" (step {venue}) of the goal \"{GOAL}\" in their task list: {state}, for Thu 26 Nov 2026.]"
        )
    };
    w.patch(venue, json!({"state":"in_progress"}));
    assert_eq!(w.lines(venue), [(w.goal_chat, line("in progress"))]);
    w.patch(venue, json!({"state":"not_started"}));
    assert_eq!(w.lines(venue), [(w.goal_chat, line("not started"))]);
    w.patch(venue, json!({"state":"not_started"}));
    assert_eq!(
        w.lines(venue),
        [(w.goal_chat, line("not started"))],
        "the same state writes nothing"
    );
}

/// Sends a request with a raw body, which a well-formed client would never send.
fn raw(user: &User, method: &str, path: &str, body: &str) -> (u16, Value) {
    let url = format!("{}{path}", user.url);
    let request = ureq::http::Request::builder()
        .method(method)
        .uri(url)
        .header("cookie", &user.cookie)
        .header("origin", &user.origin)
        .header("content-type", "application/json")
        .body(body.to_owned())
        .unwrap();
    let mut response = agent().run(request).unwrap();
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().unwrap();
    (
        status,
        serde_json::from_str(&text).unwrap_or(Value::String(text)),
    )
}

#[test]
fn bad_changes_are_refused_and_change_nothing() {
    let w = world();
    let before = (w.rows(), w.tap_count(), w.owner.get("/api/task-list"));
    let (task, goal) = (
        format!("/api/task-list/tasks/{}", w.spec),
        format!("/api/task-list/goals/{}", w.goal),
    );
    let long = |count: usize| "x".repeat(count);
    let rows: Vec<(&str, &str, String, String)> = vec![
        (
            "badBody",
            "POST",
            "/api/task-list/tasks".into(),
            "{not json".into(),
        ),
        (
            "badBody",
            "POST",
            "/api/task-list/tasks".into(),
            json!({"title":"x"}).to_string(),
        ),
        (
            "badBody",
            "PATCH",
            task.clone(),
            json!({"goalId":"seven"}).to_string(),
        ),
        (
            "badBody",
            "PATCH",
            "/api/task-list/tasks/seven".into(),
            json!({"title":"x"}).to_string(),
        ),
        ("badBody", "PATCH", goal.clone(), "[]".into()),
        (
            "badBody",
            "GET",
            "/api/task-list/done?before=soon".into(),
            String::new(),
        ),
        (
            "badTitle",
            "POST",
            "/api/task-list/tasks".into(),
            json!({"title":"  ","day":"today"}).to_string(),
        ),
        (
            "badTitle",
            "PATCH",
            task.clone(),
            json!({"title":long(301)}).to_string(),
        ),
        (
            "badTitle",
            "PATCH",
            goal.clone(),
            json!({"title":long(201)}).to_string(),
        ),
        (
            "badDay",
            "POST",
            "/api/task-list/tasks".into(),
            json!({"title":"x","day":"someday"}).to_string(),
        ),
        (
            "badDay",
            "PATCH",
            task.clone(),
            json!({"day":"monday"}).to_string(),
        ),
        (
            "badState",
            "PATCH",
            task.clone(),
            json!({"state":"half"}).to_string(),
        ),
        (
            "badState",
            "PATCH",
            goal.clone(),
            json!({"state":"paused"}).to_string(),
        ),
        ("nothingToChange", "PATCH", task.clone(), "{}".into()),
        ("nothingToChange", "PATCH", goal.clone(), "{}".into()),
    ];
    let message = |kind: &str| match kind {
        "badBody" => "The page sent a change Jet cannot read",
        "badDay" => "That is not a day of the list",
        "badState" => "That is not a state of a task",
        "nothingToChange" => "Nothing to change",
        _ => "",
    };
    for (kind, method, path, body) in rows {
        let (status, answer) = raw(&w.owner, method, &path, &body);
        assert_eq!(
            (status, &answer["kind"]),
            (400, &json!(kind)),
            "{method} {path} {body}: {answer}"
        );
        if kind == "badTitle" {
            assert!(
                answer["message"]
                    .as_str()
                    .unwrap()
                    .starts_with("A title needs 1 to ")
            );
        } else {
            assert_eq!(answer["message"], message(kind), "{method} {path} {body}");
        }
    }
    assert_eq!(
        (w.rows(), w.tap_count(), w.owner.get("/api/task-list")),
        before
    );
}

#[test]
fn a_task_cannot_move_to_a_closed_goal() {
    let w = world();
    w.patch(w.spec, json!({"state":"done"}));
    let bank = w.add(json!({"title":"Call the bank","day":"today"}));
    let (status, _) = w.owner.patch(
        &format!("/api/task-list/goals/{}", w.goal),
        json!({"state":"done"}),
    );
    assert_eq!(status, 200);
    let before = (w.rows(), w.tap_count());
    let closed = json!({"kind":"goalClosed","message":"That goal is closed"});
    let refused = [
        w.owner.patch(
            &format!("/api/task-list/tasks/{bank}"),
            json!({"goalId":w.goal}),
        ),
        w.owner.post(
            "/api/task-list/tasks",
            json!({"title":"x","day":"today","goalId":w.goal}),
        ),
        w.owner.patch(
            &format!("/api/task-list/tasks/{}", w.spec),
            json!({"title":"Renamed"}),
        ),
        w.owner.patch(
            &format!("/api/task-list/goals/{}", w.goal),
            json!({"title":"Again"}),
        ),
    ];
    for answer in refused {
        assert_eq!(answer, (409, closed.clone()));
    }
    assert_eq!((w.rows(), w.tap_count()), before, "nothing changed");
}

#[test]
fn a_goal_is_renamed_and_marked_done_from_the_list() {
    let w = world();
    let path = format!("/api/task-list/goals/{}", w.goal);
    let events = listen(&w.owner);
    let (status, list) = w.owner.patch(&path, json!({"title":"Ship the kite site"}));
    assert_eq!(
        (status, &list["goals"][0]["title"]),
        (200, &json!("Ship the kite site")),
        "{list}"
    );
    assert!(pane_changed(&events));
    let renamed = format!("[The user renamed the goal \"{GOAL}\" to \"Ship the kite site\".]");
    assert_eq!(w.waiting(w.goal_chat), [renamed.as_str()]);

    let events = listen(&w.owner);
    let (status, list) = w.owner.patch(&path, json!({"state":"done"}));
    assert_eq!(
        (status, &list["goals"], &list["tasks"]),
        (200, &json!([]), &json!([])),
        "{list}"
    );
    assert!(pane_changed(&events));
    let done = "[The user marked the goal \"Ship the kite site\" done. Its waiting checks are cancelled. 1 of its tasks were still open and left the list.]";
    assert_eq!(w.waiting(w.goal_chat), [renamed.as_str(), done]);
    let pane = w.owner.get("/api/pane");
    assert_eq!(
        (&pane["objectives"][0]["status"], &pane["tasks"]),
        (&json!("done"), &json!([])),
        "the goal is closed and its check cancelled"
    );
}

#[test]
fn the_done_pile_pages_older_tasks_with_more() {
    let w = world();
    let user = user_id(&w.host, OWNER);
    // Two tasks share each minute, so the pages part ties by id.
    let mut values: Vec<String> = (0..205)
        .map(|n| {
            format!(
                "({user}, {}, 'Done {n}', {})",
                100 + n,
                wednesday() - (n / 2) * 60
            )
        })
        .collect();
    values.push(format!(
        "({user}, 400, 'Done long ago', {})",
        wednesday() - 100 * 86_400
    ));
    rusqlite::Connection::open(w.host.dir.path().join("jet.sqlite3"))
        .unwrap()
        .execute_batch(&format!(
            "INSERT INTO objective_steps (user_id, position, title, done_at) VALUES {};",
            values.join(", ")
        ))
        .unwrap();
    let kept_since = (wednesday() - 90 * 86_400).cast_signed();
    let mut expected: Vec<(i64, i64)> = database(&w.host)
        .prepare("SELECT done_at, id FROM objective_steps WHERE done_at > ?1")
        .unwrap()
        .query_map([kept_since], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    expected.sort_unstable_by(|a, b| b.cmp(a));

    let list = w.owner.get("/api/task-list");
    assert_eq!(list["doneCount"], 205);
    let mut seen = ids(&list, "done");
    let mut pages = vec![(seen.len(), true)];
    let mut last = list["done"][99].clone();
    loop {
        let page = w.owner.get(&format!(
            "/api/task-list/done?before={}&beforeId={}",
            last["doneAt"], last["id"]
        ));
        let more = page["more"].as_bool().unwrap();
        seen.extend(ids(&page, "done"));
        pages.push((page["done"].as_array().unwrap().len(), more));
        if !more {
            break;
        }
        last = page["done"][99].clone();
    }
    assert_eq!(pages, [(100, true), (100, true), (5, false)]);
    let order: Vec<i64> = expected.into_iter().map(|(_, id)| id).collect();
    assert_eq!(
        seen, order,
        "newest first, ties by id, each once, nothing past 90 days"
    );
}

#[test]
fn jets_own_changes_show_in_the_list_and_are_not_told_back() {
    let w = world();
    let script = json!([
        objectives(json!({"action":"step_add","title":"Call the bank","due":"2026-11-26"})),
        objectives(json!({"action":"step_tick","step":w.spec,"started":true})),
        objectives(json!({"action":"step_edit","step":w.spec,"title":"Draft the full spec"})),
        objectives(json!({"action":"step_tick","step":w.spec,"done":true,"started":true})),
        tool("objectives_list"),
    ]);
    let events = listen(&w.owner);
    let results = run_turn(
        &w.host,
        &w.owner,
        "jet",
        "Add the bank call and start the spec.",
        script,
    );
    let bank = data(&results[0])["step"]["id"].as_i64().unwrap();
    assert_eq!(
        data(&results[1])["objective"]["id"],
        w.goal,
        "a step of a goal answers its goal"
    );
    assert_eq!(error_kind(&results[3]), "nothingToChange");
    let listed = data(&results[4]);
    assert_eq!(ids(listed, "looseSteps"), [bank]);
    assert!(
        listed["objectives"][0]["steps"][0]["startedAt"].is_u64(),
        "{listed}"
    );
    assert!(pane_changed(&events));

    let list = w.owner.get("/api/task-list");
    assert_eq!(
        (&task(&list, bank)["day"], &task(&list, bank)["goalId"]),
        (&json!("tomorrow"), &Value::Null)
    );
    assert_eq!(
        (&task(&list, w.spec)["title"], &task(&list, w.spec)["state"]),
        (&json!("Draft the full spec"), &json!("in_progress"))
    );
    assert_eq!(w.tap_count(), 0, "Jet is not told of its own changes");
    let tick = objectives(json!({"action":"step_tick","step":bank}));
    let done = run_turn(
        &w.host,
        &w.owner,
        "tick",
        "The bank is called.",
        json!([tick]),
    );
    assert_eq!(
        data(&done[0])["step"]["id"],
        bank,
        "a task under no goal answers itself"
    );
    assert_eq!(ids(&w.owner.get("/api/task-list"), "done"), [bank]);
}

#[test]
fn every_change_shows_in_the_list_and_the_pane_and_tells_only_its_users_pages() {
    let w = world();
    share_with_manager(&w.host, &w.owner);
    let (viewer, outsider) = (w.host.sign_in_as(MANAGER), w.host.sign_in_as(OUTSIDER));
    let heard = |act: &dyn Fn() -> Value| {
        let streams = [listen(&w.owner), listen(&viewer), listen(&outsider)];
        let list = act();
        assert!(pane_changed(&streams[0]), "the owner's pages are told");
        assert!(pane_changed(&streams[1]), "the goal's viewer is told");
        assert!(quiet(&streams[2]), "no one else is");
        list
    };
    let steps = || w.owner.get("/api/pane")["objectives"][0]["steps"].clone();
    let titles = || -> Vec<Value> {
        steps()
            .as_array()
            .unwrap()
            .iter()
            .map(|step| step["title"].clone())
            .collect()
    };

    let list = heard(&|| {
        let (status, list) = w.owner.post(
            "/api/task-list/tasks",
            json!({"title":"Book the venue","day":"tomorrow","goalId":w.goal}),
        );
        assert_eq!(status, 200, "{list}");
        list
    });
    let venue = list["changed"].as_i64().unwrap();
    assert_eq!(day(&list, "tomorrow"), [venue]);
    assert_eq!(titles(), [json!(SPEC), json!("Book the venue")]);

    let list = heard(&|| w.patch(venue, json!({"title":"Book the hall"})));
    assert_eq!(task(&list, venue)["title"], "Book the hall");
    assert_eq!(titles(), [json!(SPEC), json!("Book the hall")]);

    let list = heard(&|| w.patch(venue, json!({"day":"later"})));
    assert_eq!(
        (&task(&list, venue)["day"], &task(&list, venue)["date"]),
        (&json!("later"), &Value::Null)
    );
    assert_eq!(steps()[1]["due"], Value::Null);

    let list = heard(&|| w.patch(venue, json!({"state":"done"})));
    assert_eq!(ids(&list, "done"), [venue]);
    assert!(steps()[1]["doneAt"].is_u64());

    let list = heard(&|| w.patch(venue, json!({"state":"not_started"})));
    assert_eq!(day(&list, "later"), [venue]);
    assert_eq!(steps()[1]["doneAt"], Value::Null);

    let list = heard(&|| w.patch(venue, json!({"day":"today","after":null})));
    assert_eq!(day(&list, "today"), [venue, w.spec]);
    assert_eq!(
        titles(),
        [json!("Book the hall"), json!(SPEC)],
        "the pane keeps the one order"
    );
    let shared = viewer.get("/api/pane")["sharedWithMe"][0]["steps"][0]["title"].clone();
    assert_eq!(shared, "Book the hall", "the viewer reads the same order");

    let list = heard(&|| {
        let (status, list) = w.owner.delete(&format!("/api/task-list/tasks/{venue}"));
        assert_eq!(status, 200, "{list}");
        list
    });
    assert_eq!(ids(&list, "tasks"), [w.spec]);
    assert_eq!(titles(), [json!(SPEC)]);
}

/// The done pile offers to put back a done task of a closed goal, so the server does it: the task
/// comes back open and leaves the goal.
#[test]
fn a_done_task_of_a_closed_goal_can_be_put_back() {
    let w = world();
    w.patch(w.spec, json!({"state":"done"}));
    let (status, closed) = w.owner.patch(
        &format!("/api/task-list/goals/{}", w.goal),
        json!({"state":"done"}),
    );
    assert_eq!(status, 200, "{closed}");
    let (status, list) = w.owner.patch(
        &format!("/api/task-list/tasks/{}", w.spec),
        json!({"state":"not_started"}),
    );
    assert_eq!(status, 200, "{list}");
    assert_eq!(ids(&list, "tasks"), [w.spec]);
    assert!(
        list["tasks"][0]["goalId"].is_null(),
        "it left the closed goal"
    );
    assert!(ids(&list, "done").is_empty());
}
