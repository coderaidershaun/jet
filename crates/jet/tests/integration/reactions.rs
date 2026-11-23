//! Prove reactions both ways through the real host: the user's emoji on a Jet message, Jet's emoji
//! on the user's message with or instead of words, and the turn a reaction may start.
use super::support::{Host, host, replay, request};
use serde_json::{Value, json};
use std::time::Duration;

/// A message that makes the stand-in stream these parts; with `wait`, the last part waits for a
/// file of that name in the data folder.
fn say(host: &Host, id: &str, parts: &[&str], wait: Option<&str>) {
    let mut message = request(id);
    message["text"] = json!(format!("say:{}", json!({"parts": parts, "wait": wait})));
    let (status, value) = host.post("/api/chat/send", message);
    assert_eq!(status, 200, "{value}");
}

fn react(host: &Host, id: &str, entry_id: &Value, emoji: Value) -> Value {
    let mut body = request(id);
    for field in ["text", "feeling"] {
        body.as_object_mut().unwrap().remove(field);
    }
    body["entryId"] = entry_id.clone();
    body["emoji"] = emoji;
    let (status, value) = host.post("/api/chat/react", body);
    assert_eq!(status, 200, "{value}");
    value["entry"].clone()
}

/// The thread once no turn runs and the provider has been run `calls` times.
fn settled(host: &Host, calls: usize) -> Vec<Value> {
    let snapshot =
        host.until(|snapshot| snapshot["active"].is_null() && host.invocations() == calls);
    snapshot["history"].as_array().unwrap().clone()
}

fn prompt(host: &Host) -> String {
    std::fs::read_to_string(host.dir.path().join("facade-prompt.txt")).unwrap()
}

fn kinds(events: &[Value]) -> Vec<&str> {
    events
        .iter()
        .filter_map(|event| event["kind"].as_str())
        .collect()
}

#[test]
fn a_user_reaction_is_saved_survives_restart_reaches_jet_and_removing_it_calls_nobody() {
    let host = host();
    say(&host, "a-1", &["mood: neutral\nHere is the plan."], None);
    let jet = settled(&host, 1)[1].clone();

    let reacted = react(&host, "a-2", &jet["id"], json!("👍"));
    assert_eq!(reacted["reactions"][0]["by"], "user");
    assert_eq!(reacted["reactions"][0]["emoji"], "👍");
    settled(&host, 2);
    assert!(
        prompt(&host).contains("[The user just put 👍 on your message \"Here is the plan.\""),
        "{}",
        prompt(&host)
    );

    let host = host.restart();
    let thread = host.get("/api/snapshot")["history"].clone();
    assert_eq!(thread[1]["reactions"], json!([reacted["reactions"][0]]));

    let removed = react(&host, "a-3", &jet["id"], Value::Null);
    assert!(removed.get("reactions").is_none(), "{removed}");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(settled(&host, 2)[1].get("reactions"), None);
}

#[test]
fn b_a_turn_in_which_jet_only_reacts_puts_the_emoji_on_the_message_and_adds_no_bubble() {
    let host = host();
    say(&host, "b-1", &["mood: neutral\nreact: 👍\n"], None);
    let thread = settled(&host, 1);
    assert_eq!(thread.len(), 1, "{thread:?}");
    assert_eq!(thread[0]["reactions"][0]["by"], "jet");
    assert_eq!(thread[0]["reactions"][0]["emoji"], "👍");
    let events = replay(&host);
    assert_eq!(kinds(&events).last(), Some(&"noReply"), "{events:?}");
    assert!(kinds(&events).contains(&"reactions"));

    // A restart does not mistake the turn for one the server cut short.
    let host = host.restart();
    assert_eq!(host.get("/api/snapshot")["history"], json!(thread));
}

#[test]
fn c_a_turn_that_reacts_and_replies_shows_both_and_jet_reads_its_reaction_next_time() {
    let host = host();
    say(
        &host,
        "c-1",
        &["mood: neutral\nreact: 🎉\nCongratulations!"],
        None,
    );
    let thread = settled(&host, 1);
    assert_eq!(thread[0]["reactions"][0]["emoji"], "🎉");
    assert_eq!(thread[1]["role"], "jet");
    assert_eq!(thread[1]["text"], "Congratulations!");

    say(&host, "c-2", &["mood: neutral\nThanks."], None);
    settled(&host, 2);
    let prompt = prompt(&host);
    assert!(
        prompt.contains("[Reactions on recent messages: you put 🎉 on the user's message \"say:"),
        "{prompt}"
    );
}

#[test]
fn d_a_reaction_that_jet_finds_needs_nothing_leaves_the_thread_unchanged() {
    let host = host();
    say(&host, "d-1", &["mood: neutral\nDone."], None);
    let before = settled(&host, 1);
    let cursor = host.get("/api/snapshot")["cursor"].as_u64().unwrap() as usize;

    react(&host, "d-2", &before[1]["id"], json!("😂"));
    let mut after = settled(&host, 2);
    after[1].as_object_mut().unwrap().remove("reactions");
    assert_eq!(after, before);
    let events = replay(&host).split_off(cursor);
    assert_eq!(
        kinds(&events),
        ["reactions", "accepted", "started", "mood", "noReply"],
        "{events:?}"
    );

    // Stopping a reaction turn before it says anything leaves no empty bubble either.
    react(&host, "d-3", &before[1]["id"], json!("⏳"));
    host.until(|snapshot| {
        snapshot["active"]["reaction"]["emoji"] == "⏳" && snapshot["active"]["mood"] == "neutral"
    });
    host.post("/api/chat/stop", json!({"requestId": "d-3"}));
    let mut stopped = settled(&host, 3);
    stopped[1].as_object_mut().unwrap().remove("reactions");
    assert_eq!(stopped, before);
    assert_eq!(kinds(&replay(&host)).last(), Some(&"noReply"));
}

#[test]
fn e_a_transcript_written_before_reactions_loads_and_takes_one() {
    let host = host();
    let old = [
        json!({"id":1,"role":"user","text":"old question","status":"complete","at":10,"old":1}),
        json!({"id":2,"role":"jet","text":"old answer","mood":"hello","status":"complete","at":11}),
    ]
    .map(|entry| entry.to_string())
    .join("\n")
        + "\n";
    let path = host.dir.path().join("transcript.jsonl");
    std::fs::write(&path, &old).unwrap();
    let thread = host.get("/api/snapshot")["history"].clone();
    assert_eq!(thread[1]["text"], "old answer");
    assert!(thread[1].get("reactions").is_none());

    react(&host, "e-1", &json!(2), json!("❤️"));
    let thread = settled(&host, 1);
    assert_eq!(thread.len(), 2);
    assert_eq!(thread[0]["text"], "old question");
    assert_eq!(thread[1]["mood"], "hello");
    assert_eq!(thread[1]["reactions"][0]["emoji"], "❤️");
    // The line that did not change keeps its text exactly, even a field this version ignores.
    let saved = std::fs::read_to_string(&path).unwrap();
    assert_eq!(saved.lines().next(), old.lines().next());
}

#[test]
fn f_a_reaction_placed_while_a_reply_runs_is_saved_and_answered_after_it() {
    let host = host();
    say(&host, "f-1", &["mood: neutral\nFirst reply."], None);
    let first = settled(&host, 1)[1].clone();

    say(
        &host,
        "f-2",
        &["mood: neutral\nSecond ", "reply whole."],
        Some("go"),
    );
    host.until(|snapshot| snapshot["active"]["text"] == "Second ");
    let reacted = react(&host, "f-3", &first["id"], json!("👍"));
    assert_eq!(reacted["reactions"][0]["emoji"], "👍");
    assert_eq!(host.invocations(), 2, "the reaction waits for the reply");

    std::fs::write(host.dir.path().join("go"), "").unwrap();
    let thread = settled(&host, 3);
    assert_eq!(thread.len(), 4, "{thread:?}");
    assert_eq!(thread[3]["text"], "Second reply whole.");
    assert_eq!(thread[3]["status"], "complete");
    assert_eq!(thread[1]["reactions"][0]["emoji"], "👍");

    let events = replay(&host);
    let finished = events.iter().rposition(|event| event["kind"] == "finished");
    let answered = events.iter().rposition(|event| event["kind"] == "accepted");
    assert!(finished < answered, "{events:?}");
    let active = &events[answered.unwrap()]["snapshot"]["active"];
    assert!(active["user"].is_null(), "{active}");
    assert_eq!(
        active["reaction"],
        json!({"entryId": first["id"], "emoji": "👍"})
    );
    assert_eq!(kinds(&events).last(), Some(&"noReply"));
}
