//! Prove, through the real host with the provider stand-in, that the notes review finds what Jet
//! promised in its own lines and sets one follow-up for it, and that "less, please" and a review
//! that falls due too soon both reach the notes.
use super::support::{Host, User, agent, request};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// 2090-03-04 10:00 in New York, the time the stand-in's promise names.
const NAMED: u64 = 3_792_322_800;

fn quiet_host(gap: &str) -> Host {
    Host::start_with(&["--review-quiet-seconds", "1", "--review-gap-seconds", gap])
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn say(user: &User, id: &str, text: &str) {
    let mut message = request(id);
    message["text"] = json!(text);
    message["timeZone"] = json!("America/New_York");
    let (status, answer) = user.post("/api/chat/send", message);
    assert_eq!(status, 200, "{answer}");
}

fn reviews(host: &Host) -> usize {
    std::fs::read_to_string(host.dir.path().join("calls"))
        .unwrap_or_default()
        .lines()
        .filter(|line| *line == "review")
        .count()
}

fn wait_for(what: &str, ready: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !ready() {
        assert!(Instant::now() < deadline, "never saw: {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn tasks(user: &User) -> Vec<Value> {
    user.get("/api/pane")["tasks"].as_array().unwrap().clone()
}

/// Says `text`, waits for the review that reads it, and gives the notes and the tasks after it.
fn say_and_review(host: &Host, user: &User, id: &str, text: &str) -> (Value, Vec<Value>) {
    let before = reviews(host);
    say(user, id, text);
    wait_for("a review", || reviews(host) > before);
    wait_for("the notes to hold the new line", || {
        user.get("/api/memory")["recent"]
            .as_str()
            .is_some_and(|recent| recent.contains(text))
    });
    (user.get("/api/memory"), tasks(user))
}

#[test]
fn review_schedules_unscheduled_promise_once() {
    let host = quiet_host("1");
    let owner = host.owner();
    let (_, found) = say_and_review(&host, &owner, "a", "promiseme about the kite");
    assert_eq!(found.len(), 1, "{found:?}");
    let task = &found[0];
    assert_eq!(task["kind"], "follow_up");
    assert_eq!(task["setBy"], "review");
    assert_eq!(task["state"], "scheduled");
    assert_eq!(task["why"], "I will check in on 2090-03-04 at 10:00");
    assert_eq!(task["localTime"], "2090-03-04T10:00");
    assert_eq!(task["timeZone"], "America/New_York");
    assert_eq!(task["dueAt"], NAMED);

    // Later lines are read again by a second review; the same promise is not set twice.
    let (_, found) = say_and_review(&host, &owner, "b", "promiseme once more");
    assert_eq!(reviews(&host), 2);
    assert_eq!(
        found.len(),
        1,
        "an open follow-up already covers the chat: {found:?}"
    );
}

#[test]
fn review_ignores_user_and_quoted_promises() {
    let host = quiet_host("1");
    let owner = host.owner();
    let (_, found) = say_and_review(
        &host,
        &owner,
        "a",
        "quoteme. I will check in on 2090-05-05 at 10:00",
    );
    assert!(found.is_empty(), "{found:?}");
}

#[test]
fn a_promise_with_no_time_is_due_a_day_after_it_was_said() {
    let host = quiet_host("1");
    let owner = host.owner();
    let sent = now();
    let (_, found) = say_and_review(&host, &owner, "a", "vaguely");
    let due = found[0]["dueAt"].as_u64().unwrap();
    assert!(
        (sent + 86_400..=now() + 86_400).contains(&due),
        "due {due} is not a day after {sent}"
    );
    assert_eq!(found[0]["why"], "I will check in");
}

#[test]
fn a_line_that_asks_jet_to_ease_off_ends_in_the_user_note() {
    let host = quiet_host("1");
    let owner = host.owner();
    let (notes, _) = say_and_review(&host, &owner, "a", "Please check in less about the gym");
    assert_eq!(notes["user"], "- Please check in less about the gym");
}

#[test]
fn the_event_stream_carries_the_pane_change_when_the_review_adds_a_follow_up() {
    let host = quiet_host("1");
    let owner = host.owner();
    let mut response = agent()
        .get(format!("{}/api/events", owner.url))
        .header("cookie", &owner.cookie)
        .header("origin", &owner.origin)
        .call()
        .unwrap();
    let (sender, events) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(response.body_mut().as_reader()).lines() {
            let Ok(line) = line else { return };
            if let Some(data) = line.strip_prefix("data: ")
                && sender
                    .send(serde_json::from_str::<Value>(data).unwrap())
                    .is_err()
            {
                return;
            }
        }
    });
    say(&owner, "a", "promiseme about the kite");
    let heard = std::iter::from_fn(|| events.recv_timeout(Duration::from_secs(15)).ok())
        .any(|event| event["data"]["event"]["kind"] == "paneChanged");
    assert!(heard, "no paneChanged after the review");
    assert_eq!(tasks(&owner).len(), 1);
}

#[test]
fn review_timer_rearms_when_too_soon() {
    let host = quiet_host("4");
    let owner = host.owner();
    say_and_review(&host, &owner, "a", "I like kites");
    let first = Instant::now();
    say(&owner, "b", "I like boats");
    std::thread::sleep(Duration::from_millis(2500));
    assert_eq!(reviews(&host), 1, "the gap has not passed yet");
    wait_for("the second review", || reviews(&host) == 2);
    assert!(
        first.elapsed() >= Duration::from_secs(3),
        "{:?}",
        first.elapsed()
    );
    wait_for("the second notes", || {
        owner.get("/api/memory")["recent"]
            .as_str()
            .is_some_and(|recent| recent.contains("boats"))
    });
}
