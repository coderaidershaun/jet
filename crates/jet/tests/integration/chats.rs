//! Prove, through the real host with the provider stand-ins and two signed-in users, that a user
//! has many chats: each with its own thread, provider session, unread count and place in the
//! notes review, and none of them reachable by another user.
use super::support::{Host, User, agent, host, request, wait_file};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    sync::mpsc,
    time::{Duration, Instant},
};

const SECOND: &str = "admin1@gmail.com";

/// A message the fake provider answers with `words`.
fn say_words(words: &str) -> String {
    format!(
        "say:{}",
        json!({"parts": [format!("mood: neutral\n{words}")]})
    )
}

fn send_in(user: &User, chat: i64, id: &str, text: &str) -> (u16, Value) {
    let mut message = request(id);
    message["text"] = json!(text);
    message["timeZone"] = json!("America/New_York");
    user.post(&format!("/api/chat/send?chat={chat}"), message)
}

fn snapshot(user: &User, chat: i64) -> Value {
    user.get(&format!("/api/snapshot?chat={chat}"))
}

/// Waits until the chat has no running reply and its thread has `entries` entries.
fn settled(user: &User, chat: i64, entries: usize) -> Value {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let shown = snapshot(user, chat);
        if shown["active"].is_null() && shown["history"].as_array().unwrap().len() == entries {
            return shown;
        }
        assert!(
            Instant::now() < deadline,
            "chat {chat} did not settle: {shown}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn chats(user: &User) -> Vec<Value> {
    user.get("/api/chats").as_array().unwrap().clone()
}

pub(super) fn main_chat(user: &User) -> i64 {
    chats(user)[0]["id"].as_i64().unwrap()
}

pub(super) fn add_chat(user: &User) -> i64 {
    let (status, chat) = user.post("/api/chats", json!({}));
    assert_eq!(status, 200, "{chat}");
    chat["id"].as_i64().unwrap()
}

/// Any request, with the sign-in and `Origin` of the user's page.
fn call(user: &User, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
    let url = format!("{}{path}", user.url);
    let agent = agent();
    let request = match method {
        "PATCH" => agent.patch(&url),
        "DELETE" => agent.delete(&url).force_send_body(),
        other => panic!("{other} is not used here"),
    };
    let request = request
        .header("cookie", &user.cookie)
        .header("origin", &user.origin)
        .header("content-type", "application/json");
    let mut response = match body {
        Some(body) => request.send(body.to_string()),
        None => request.send_empty(),
    }
    .unwrap();
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().unwrap_or_default();
    (
        status,
        serde_json::from_str(&text).unwrap_or(Value::String(text)),
    )
}

/// Reads the user's event stream on a thread of its own, for the chat's snapshot first.
fn listen(user: &User, chat: i64) -> mpsc::Receiver<Value> {
    let mut response = agent()
        .get(format!("{}/api/events?chat={chat}", user.url))
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

/// Waits for the stream's event of `kind` about `chat`.
fn event_of(events: &mpsc::Receiver<Value>, kind: &str, chat: i64) -> Value {
    loop {
        let event = events
            .recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|_| panic!("no {kind} event for chat {chat}"));
        let data = &event["data"];
        if event["kind"] == "event" && data["event"]["kind"] == kind && data["chatId"] == chat {
            return data.clone();
        }
    }
}

/// Sends one message that carries `script` as the provider's instruction, waits for the reply to
/// end, and gives the result of each call of the script.
pub(super) fn run_turn(host: &Host, user: &User, chat: i64, id: &str, script: Value) -> Vec<Value> {
    run_turn_with(host, user, chat, id, script, &[])
}

/// Like `run_turn`, with files sent in the message.
pub(super) fn run_turn_with(
    host: &Host,
    user: &User,
    chat: i64,
    id: &str,
    script: Value,
    files: &[&str],
) -> Vec<Value> {
    let _ = std::fs::remove_file(host.dir.path().join("facade-results.json"));
    let before = snapshot(user, chat)["history"].as_array().unwrap().len();
    let mut message = request(id);
    message["text"] = json!(format!("Go.\nfacade:{script}"));
    message["timeZone"] = json!("America/New_York");
    message["attachments"] = json!(files);
    let (status, accepted) = user.post(&format!("/api/chat/send?chat={chat}"), message);
    assert_eq!(status, 200, "{accepted}");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !(snapshot(user, chat)["active"].is_null()
        && snapshot(user, chat)["history"].as_array().unwrap().len() >= before + 2)
    {
        assert!(Instant::now() < deadline, "the turn did not end");
        std::thread::sleep(Duration::from_millis(20));
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

fn tool(name: &str, arguments: Value) -> Value {
    json!({"tool": name, "arguments": arguments})
}

fn data(result: &Value) -> &Value {
    assert_eq!(result["isError"], false, "{result}");
    &result["structuredContent"]
}

fn prompt_of_last_run(host: &Host) -> String {
    std::fs::read_to_string(host.dir.path().join("facade-prompt.txt")).unwrap()
}

fn last_args(host: &Host) -> Vec<String> {
    serde_json::from_str(
        &std::fs::read_to_string(host.dir.path().join("fake-claude-args.json")).unwrap(),
    )
    .unwrap()
}

#[test]
fn two_chats_keep_separate_histories_and_provider_sessions() {
    let host = host();
    let user = host.owner();
    let (main, topic) = (main_chat(&user), add_chat(&user));
    let resumes = |host: &Host| last_args(host).contains(&"--resume".to_owned());

    send_in(&user, main, "m1", &say_words("kites"));
    settled(&user, main, 2);
    assert!(!resumes(&host), "the first message starts a session");
    send_in(&user, main, "m2", &say_words("more kites"));
    settled(&user, main, 4);
    assert!(resumes(&host), "the second message continues it");

    send_in(&user, topic, "t1", &say_words("boats"));
    let boats = settled(&user, topic, 2);
    assert!(!resumes(&host), "another chat starts a session of its own");
    assert!(!prompt_of_last_run(&host).contains("kites"));
    send_in(&user, topic, "t2", &say_words("more boats"));
    settled(&user, topic, 4);
    assert!(resumes(&host));

    assert_eq!(boats["history"][0]["text"], say_words("boats"));
    let shown = snapshot(&user, main);
    assert!(
        shown["history"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| !entry["text"].as_str().unwrap().contains("boats"))
    );
}

#[test]
fn reply_in_one_chat_does_not_block_another() {
    let host = host();
    let user = host.owner();
    let (main, topic) = (main_chat(&user), add_chat(&user));
    send_in(&user, main, "slow", "hang");
    user.until(|shown| shown["active"]["text"] == "Partial");

    send_in(&user, topic, "quick", &say_words("done"));
    settled(&user, topic, 2);
    assert!(
        !snapshot(&user, main)["active"].is_null(),
        "the first chat still answers"
    );
    assert_eq!(
        user.post(
            &format!("/api/chat/stop?chat={main}"),
            json!({"requestId": "slow"})
        )
        .0,
        200
    );
    settled(&user, main, 2);
}

#[test]
fn a_reply_in_a_chat_that_is_not_open_raises_its_unread_count_until_it_is_read() {
    let host = host();
    let user = host.owner();
    let (main, topic) = (main_chat(&user), add_chat(&user));
    let events = listen(&user, main);

    send_in(&user, topic, "t1", &say_words("hello"));
    let raised = event_of(&events, "unread", topic);
    assert_eq!(raised["event"]["unread"], 1);
    assert_eq!(snapshot(&user, topic)["unread"], 1);
    let listed = chats(&user);
    assert_eq!(
        listed.iter().find(|chat| chat["id"] == topic).unwrap()["unread"],
        1
    );
    assert_eq!(snapshot(&user, main)["unread"], 0);

    // The page shows the chat and moves its read mark through the entry it has seen.
    let (status, read) = user.post(&format!("/api/chats/{topic}/read"), json!({"through": 2}));
    assert_eq!((status, &read["unread"]), (200, &json!(0)), "{read}");
    assert_eq!(event_of(&events, "unread", topic)["event"]["unread"], 0);
    assert_eq!(snapshot(&user, topic)["unread"], 0);

    // A reply in a chat whose mark the page moves is read at once, with no entry left over.
    send_in(&user, topic, "t2", &say_words("again"));
    settled(&user, topic, 4);
    assert_eq!(snapshot(&user, topic)["unread"], 1);
    user.post(&format!("/api/chats/{topic}/read"), json!({"through": 4}));
    assert_eq!(snapshot(&user, topic)["unread"], 0);
}

#[test]
fn chats_are_added_renamed_and_deleted_and_the_main_chat_stays() {
    let host = host();
    let user = host.owner();
    let main = main_chat(&user);
    let events = listen(&user, main);

    let first = add_chat(&user);
    let second = add_chat(&user);
    event_of(&events, "chatsChanged", second);
    assert_eq!(chats(&user)[0]["kind"], "main");
    assert_eq!(chats(&user)[1]["title"], "New chat");
    // The chat with the latest entry comes first after the main chat.
    send_in(&user, first, "f1", &say_words("hi"));
    settled(&user, first, 2);
    let order: Vec<_> = chats(&user)
        .iter()
        .map(|chat| chat["id"].as_i64().unwrap())
        .collect();
    assert_eq!(order, [main, first, second]);

    assert_eq!(
        call(
            &user,
            "PATCH",
            &format!("/api/chats/{first}"),
            Some(json!({"title": "Boats"}))
        )
        .0,
        200
    );
    assert_eq!(chats(&user)[1]["title"], "Boats");
    assert_eq!(
        call(
            &user,
            "PATCH",
            &format!("/api/chats/{first}"),
            Some(json!({"title": "  "}))
        )
        .0,
        400
    );

    assert_eq!(
        call(&user, "DELETE", &format!("/api/chats/{first}"), None).0,
        200
    );
    assert_eq!(snapshot_status(&user, first), 404);
    assert_eq!(chats(&user).len(), 2);
    let (status, refused) = call(&user, "DELETE", &format!("/api/chats/{main}"), None);
    assert_eq!(
        (status, &refused["kind"]),
        (400, &json!("invalidRequest")),
        "{refused}"
    );
    assert_eq!(chats(&user)[0]["id"], main);
}

fn snapshot_status(user: &User, chat: i64) -> u16 {
    user.fetch(&format!("/api/snapshot?chat={chat}")).0
}

#[test]
fn deleting_chats_drops_their_objectives_and_moves_follow_ups_to_the_main_chat() {
    let host = host();
    let user = host.owner();
    let main = main_chat(&user);
    let create = tool(
        "objectives_update",
        json!({"command": {
            "action":"create","title":"Ship the kite","deliverable":"A kite that flies",
            "start":"2099-06-01","due":"2099-07-01","steps":[],"sources":[],
            "check":{"at":"2099-06-08T09:00","why":"see the frame"}
        }}),
    );
    let results = run_turn(
        &host,
        &user,
        main,
        "make",
        json!([create, tool("objectives_list", json!({}))]),
    );
    let objective = &data(&results[1])["objectives"][0];
    let kite_chat = objective["chatId"].as_i64().unwrap();
    assert_ne!(kite_chat, main);
    assert_eq!(objective["tasks"][0]["chatId"], kite_chat);

    // The objective's chat is in the list with its summary as the first entry, unread.
    let listed = chats(&user)
        .into_iter()
        .find(|chat| chat["id"] == kite_chat)
        .unwrap();
    assert_eq!(
        (&listed["kind"], &listed["title"], &listed["unread"]),
        (&json!("objective"), &json!("Ship the kite"), &json!(1))
    );
    let first = &snapshot(&user, kite_chat)["history"][0];
    assert!(
        first["text"]
            .as_str()
            .unwrap()
            .starts_with("Ship the kite\n\nDeliverable: A kite that flies")
    );

    // Renaming the objective renames the chat that still carries its title.
    run_turn(
        &host,
        &user,
        main,
        "rename",
        json!([tool(
            "objectives_update",
            json!({"command": {"action":"edit","id":objective["id"],"title":"Fly the kite"}}),
        )]),
    );
    let renamed = chats(&user)
        .into_iter()
        .find(|chat| chat["id"] == kite_chat)
        .unwrap();
    assert_eq!(renamed["title"], "Fly the kite");

    // The first message of a provider session in that chat carries the summary.
    send_in(&user, kite_chat, "k1", &say_words("hello"));
    settled(&user, kite_chat, 3);
    assert!(prompt_of_last_run(&host).contains("Deliverable: A kite that flies"));

    let topic = add_chat(&user);
    let follow = tool(
        "tasks_update",
        json!({"command": {"action":"schedule","at":"2099-06-20T09:00","why":"ask how it went"}}),
    );
    run_turn(&host, &user, topic, "later", json!([follow]));

    assert_eq!(
        call(&user, "DELETE", &format!("/api/chats/{kite_chat}"), None).0,
        200
    );
    assert_eq!(
        call(&user, "DELETE", &format!("/api/chats/{topic}"), None).0,
        200
    );
    let results = run_turn(
        &host,
        &user,
        main,
        "look",
        json!([
            tool("objectives_list", json!({})),
            tool("tasks_list", json!({}))
        ]),
    );
    let objective = &data(&results[0])["objectives"][0];
    assert_eq!(
        (&objective["status"], &objective["chatId"]),
        (&json!("dropped"), &json!(main)),
        "the objective is dropped, its history kept in the main chat"
    );
    assert!(
        objective["closedAt"].as_u64().unwrap() < 10_000_000_000,
        "closedAt is in seconds, not milliseconds"
    );
    assert_eq!(
        objective["tasks"],
        json!([]),
        "its waiting check is cancelled"
    );
    let tasks = data(&results[1])["tasks"].as_array().unwrap().clone();
    let follow_up = tasks
        .iter()
        .find(|task| task["kind"] == "follow_up")
        .unwrap();
    assert_eq!(
        (&follow_up["state"], &follow_up["chatId"]),
        (&json!("scheduled"), &json!(main))
    );
}

#[test]
fn another_user_reaches_none_of_a_users_chats() {
    let host = host();
    let (ada, bob) = (host.owner(), host.sign_in_as(SECOND));
    let secret = "the kite plan is private";
    let topic = add_chat(&ada);
    let bobs_events = listen(&bob, main_chat(&bob));

    send_in(&ada, topic, "a1", &say_words(secret));
    settled(&ada, topic, 2);
    let entry = snapshot(&ada, topic)["history"][1]["id"].clone();
    assert!(
        chats(&bob).iter().all(|chat| chat["id"] != topic),
        "B cannot list A's chats"
    );

    // Each route that takes a chat id answers B about A's chat as it answers about no chat.
    let routes = |chat: i64| -> Vec<(u16, Value)> {
        let react = json!({"requestId":"r","clientId":"b","entryId":entry,"emoji":"👍","budgetUsd":1.0,"persona":{"name":"Jet","jobTitle":"","notes":""},"localTime":"Friday"});
        vec![
            bob.fetch(&format!("/api/status?chat={chat}")),
            bob.fetch(&format!("/api/snapshot?chat={chat}")),
            bob.fetch(&format!("/api/events?chat={chat}")),
            send_in(&bob, chat, "b1", "hello"),
            bob.post(&format!("/api/chat/react?chat={chat}"), react),
            bob.post(
                &format!("/api/chat/stop?chat={chat}"),
                json!({"requestId": "a1"}),
            ),
            bob.post(&format!("/api/chat/forget?chat={chat}"), json!({})),
            bob.post(&format!("/api/chats/{chat}/read"), json!({})),
            call(
                &bob,
                "PATCH",
                &format!("/api/chats/{chat}"),
                Some(json!({"title": "mine"})),
            ),
            call(&bob, "DELETE", &format!("/api/chats/{chat}"), None),
        ]
    };
    let unknown = routes(999_999);
    assert!(
        unknown.iter().all(|(status, _)| *status == 404),
        "{unknown:?}"
    );
    assert_eq!(routes(topic), unknown);

    let looked = run_turn(
        &host,
        &bob,
        main_chat(&bob),
        "peek",
        json!([
            tool("chats_read", json!({"chat": topic})),
            tool("chats_read", json!({"chat": 999_999})),
        ]),
    );
    assert_eq!(looked[0]["isError"], true);
    assert_eq!(
        looked[0]["structuredContent"],
        looked[1]["structuredContent"]
    );

    // Nothing of A's reached B: not the chat, not its text, in B's stream or A's thread.
    assert_eq!(
        snapshot(&ada, topic)["history"].as_array().unwrap().len(),
        2
    );
    std::thread::sleep(Duration::from_millis(300));
    while let Ok(event) = bobs_events.try_recv() {
        assert!(!event.to_string().contains(secret), "{event}");
    }
}

#[test]
fn chats_read_lists_the_callers_chats_and_reads_the_last_entries_of_one() {
    let host = host();
    let user = host.owner();
    let (main, topic) = (main_chat(&user), add_chat(&user));
    send_in(&user, topic, "t1", &say_words("the boat is blue"));
    settled(&user, topic, 2);

    let results = run_turn(
        &host,
        &user,
        main,
        "look",
        json!([
            tool("chats_read", json!({})),
            tool("chats_read", json!({"chat": topic, "limit": 1})),
        ]),
    );
    let listed = data(&results[0])["chats"].as_array().unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0]["kind"], "main");
    let read = data(&results[1]);
    assert_eq!(read["chat"]["id"], topic);
    let entries = read["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1, "only the last entry was asked for");
    assert_eq!(
        (&entries[0]["role"], &entries[0]["text"]),
        (&json!("jet"), &json!("the boat is blue"))
    );
}

/// A host whose chats go quiet after a second, with the stand-in that writes each user line into
/// RECENT beside the chat it came from.
fn quiet_host() -> Host {
    Host::start_with(&["--review-quiet-seconds", "1"])
}

fn reviews(host: &Host) -> usize {
    std::fs::read_to_string(host.dir.path().join("calls"))
        .unwrap_or_default()
        .lines()
        .filter(|line| *line == "review")
        .count()
}

/// Says one thing in the main chat and one in a chat called Boats, at the same time, and waits for
/// the notes to name both.
fn two_chats_go_quiet_together(host: &Host) -> String {
    let user = host.owner();
    let (main, boats) = (main_chat(&user), add_chat(&user));
    call(
        &user,
        "PATCH",
        &format!("/api/chats/{boats}"),
        Some(json!({"title": "Boats"})),
    );
    send_in(&user, main, "k", "I like kites");
    send_in(&user, boats, "b", "I like boats");
    settled(&user, main, 2);
    settled(&user, boats, 2);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let recent = user.get("/api/memory")["recent"]
            .as_str()
            .unwrap()
            .to_owned();
        if recent.contains("kites") && recent.contains("boats") {
            return recent;
        }
        assert!(
            Instant::now() < deadline,
            "the notes never read both chats: {recent:?}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn notes_review_reads_all_chats_of_one_user() {
    let host = quiet_host();
    let recent = two_chats_go_quiet_together(&host);
    assert!(recent.contains("- I like kites [Main chat]"), "{recent}");
    assert!(recent.contains("- I like boats [Boats]"), "{recent}");
    let second = host.sign_in_as(SECOND);
    assert_eq!(
        second.get("/api/memory")["recent"],
        "",
        "another user's notes are not touched"
    );
}

#[test]
fn two_chats_due_together_give_one_review_and_no_entry_twice() {
    let host = quiet_host();
    let recent = two_chats_go_quiet_together(&host);
    std::thread::sleep(Duration::from_secs(3));
    assert_eq!(
        reviews(&host),
        1,
        "the second chat's timer found nothing left to read"
    );
    assert_eq!(recent.matches("I like kites").count(), 1);
    assert_eq!(host.owner().get("/api/memory")["recent"], recent);
}

#[test]
fn a_new_chat_takes_its_title_from_the_first_message_unless_it_was_renamed() {
    let host = host();
    let user = host.owner();
    let chat = add_chat(&user);
    let title = |user: &User| {
        chats(user).iter().find(|row| row["id"] == chat).unwrap()["title"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    send_in(
        &user,
        chat,
        "t1",
        &say_words("Plan the kite build for the next long weekend"),
    );
    let derived = title(&user);
    assert!(derived.starts_with("say:"), "{derived}");
    assert!(
        derived.chars().count() <= 40 && derived != "New chat",
        "{derived}"
    );

    call(
        &user,
        "PATCH",
        &format!("/api/chats/{chat}"),
        Some(json!({"title": "Kites"})),
    );
    settled(&user, chat, 2);
    send_in(&user, chat, "t2", &say_words("something else"));
    settled(&user, chat, 4);
    assert_eq!(title(&user), "Kites");
}

#[test]
fn forgetting_or_deleting_a_chat_leaves_the_files_of_the_others() {
    let host = host();
    let user = host.owner();
    let (first, second) = (main_chat(&user), add_chat(&user));
    let mut files = Vec::new();
    for (chat, name) in [(first, "one.txt"), (second, "two.txt")] {
        let (status, file) = user.upload(name, b"hello");
        assert_eq!(status, 200, "{file}");
        let id = file["id"].as_str().unwrap().to_owned();
        let mut message = request(name);
        message["text"] = json!(say_words("got it"));
        message["attachments"] = json!([id]);
        assert_eq!(
            user.post(&format!("/api/chat/send?chat={chat}"), message).0,
            200
        );
        settled(&user, chat, 2);
        files.push(id);
    }
    let status = |id: &str| user.fetch(&format!("/api/files/{id}")).0;
    user.post(&format!("/api/chat/forget?chat={second}"), json!({}));
    assert_eq!((status(&files[0]), status(&files[1])), (200, 404));
    assert_eq!(
        call(&user, "DELETE", &format!("/api/chats/{second}"), None).0,
        200
    );
    assert_eq!(status(&files[0]), 200);
}

// A task line that waits for Jet in a goal's chat is told in the main chat after that chat is
// deleted, where the goal now lives.
#[test]
fn a_deleted_chats_waiting_task_line_reaches_the_main_chat() {
    use super::objectives::{database, objectives, run_turn, run_turn_in, tool};
    let host = host();
    let wednesday = "2026-11-25T15:00:00Z"
        .parse::<jiff::Timestamp>()
        .unwrap()
        .as_second()
        .unsigned_abs();
    host.set_clock(wednesday);
    let owner = host.owner();
    let goal = json!({
        "action":"create","title":"Ship the kite page","deliverable":"The kite page live at /kite",
        "start":"2026-11-20","due":"2026-11-28","steps":[{"title":"Draft the spec","due":"2026-11-25"}],
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
    let goal_chat = list["goals"][0]["chatId"].as_i64().unwrap();
    let main = list["mainChatId"].as_i64().unwrap();
    let spec = list["tasks"][0]["id"].as_i64().unwrap();
    let (status, body) = owner.patch(
        &format!("/api/task-list/tasks/{spec}"),
        json!({"state":"done"}),
    );
    assert_eq!(status, 200, "{body}");
    let waiting = || -> Vec<(i64, String)> {
        database(&host)
            .prepare("SELECT chat_id, line FROM pane_taps WHERE announced = 0 ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    let before = waiting();
    assert_eq!(before.len(), 1, "{before:?}");
    assert_eq!(before[0].0, goal_chat, "the line waits in the goal's chat");
    let line = before[0].1.clone();

    assert_eq!(host.delete(&format!("/api/chats/{goal_chat}")), 200);
    let after = waiting();
    run_turn_in(
        &host,
        &owner,
        Some(main),
        "hi",
        "Thanks.",
        json!([tool("people_list")]),
    );
    let prompt = std::fs::read_to_string(host.dir.path().join("facade-prompt.txt")).unwrap();
    assert!(
        prompt.contains(&line),
        "Jet in the main chat is told {line:?}; lines waiting after the delete: {after:?}"
    );
}
