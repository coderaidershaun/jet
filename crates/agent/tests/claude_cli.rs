//! Contract tests for the door to Claude Code: the real `ClaudeCli` and the real `Turn`,
//! with the `fake-claude` program standing in for Claude Code itself. One test also runs
//! a whole reply through `Conversation`, to the events and the saved thread.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use agent::{
    Conversation, DataDir, Effort, Event, McpConnection, Message, Model, Mood, Persona,
    SessionMode, Step, ToolStart, Turn,
};
use support::{chat_request, fake_claude};

#[test]
fn a_recorded_quanty_search_reaches_the_page_and_the_thread() {
    let (claude, cwd) = fake_claude("quanty");
    let conversation = Conversation::new(DataDir::new(cwd.join("data")));
    let message = Message {
        text: "fixture:quanty-search-reply".to_owned(),
        persona: Persona::default(),
        model: Model::Sonnet,
        effort: Effort::Medium,
        budget_usd: 1.0,
        local_time: "Tue 14 Oct 2026, 11:20".to_owned(),
        mcp: Some(McpConnection {
            url: "http://localhost/mcp".into(),
            token: "fixture".into(),
        }),
        active_app_id: None,
        feeling: None,
    };
    let (_, reply) = conversation.send(Arc::new(claude), message, None).unwrap();
    let events: Vec<Event> = reply.collect();

    let tool_started: Vec<&Event> = events
        .iter()
        .filter(|e| matches!(e, Event::ToolStarted(_)))
        .collect();
    let [
        Event::ToolStarted(ToolStart {
            id,
            server,
            tool,
            input,
        }),
    ] = tool_started[..]
    else {
        panic!("one tool call starts, ToolSearch is left out: {tool_started:?}");
    };
    assert_eq!(id, "toolu_01K3EDj1tq5Co9obfZ2yX4Nx");
    assert_eq!((server.as_str(), tool.as_str()), ("quanty", "search"));
    assert_eq!(
        input["question"],
        "What is vega, the sensitivity of an option price to volatility?"
    );
    let Some(Event::ToolFinished(call)) =
        events.iter().find(|e| matches!(e, Event::ToolFinished(_)))
    else {
        panic!("the call finishes: {events:?}");
    };
    assert_eq!((&call.id, &call.input), (id, input));
    assert!(call.ok);
    assert_eq!(call.result["results"].as_array().unwrap().len(), 5);
    assert_eq!(call.summary, "quanty · search · 5 results");

    let position = |wanted: fn(&Event) -> bool| events.iter().position(wanted).unwrap();
    let order = [
        position(|e| matches!(e, Event::Started { .. })),
        position(|e| matches!(e, Event::ToolStarted(_))),
        position(|e| matches!(e, Event::ToolFinished(_))),
        position(|e| matches!(e, Event::Text { .. })),
        events.len() - 1,
    ];
    assert!(
        order.is_sorted_by(|a, b| a < b),
        "events out of order: {order:?}"
    );
    let text: String = events
        .iter()
        .filter_map(|e| match e {
            Event::Text { delta } => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert!(text.starts_with("Vega is how much"), "{text}");

    let Some(Event::Finished { entry }) = events.last() else {
        panic!("the reply ends with Finished: {:?}", events.last());
    };
    let [saved] = &entry.entry.tools[..] else {
        panic!("the saved entry keeps the call: {:?}", entry.entry.tools);
    };
    assert_eq!(saved, call);
    let capacity = conversation.context_status(Model::Sonnet).unwrap();
    assert_eq!(capacity.used_tokens, Some(8373));
    assert_eq!(capacity.limit_tokens, Some(1_000_000));
    assert!(!capacity.estimated);
    let reloaded = Conversation::new(DataDir::new(cwd.join("data")));
    assert_eq!(reloaded.context_status(Model::Sonnet).unwrap(), capacity);
    assert_eq!(
        reloaded.context_status(Model::Opus).unwrap().used_tokens,
        None
    );
    let history = conversation.history(10).unwrap();
    assert_eq!(history.last().unwrap().entry.tools, entry.entry.tools);
}

fn is_alive(pid: &str) -> bool {
    std::process::Command::new("kill")
        .args(["-0", pid])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[test]
fn stop_kills_the_process_and_keeps_partial_text() {
    let (claude, cwd) = fake_claude("stops");
    let mut turn = Turn::start(&claude, &chat_request("hang", SessionMode::New)).unwrap();
    let stopper = turn.stopper();

    let mut steps = Vec::new();
    for step in turn.by_ref() {
        let partial_arrived = matches!(&step, Step::Text(text) if text == "Partial");
        steps.push(step);
        if partial_arrived {
            break;
        }
    }
    // The clock starts at the stop, because macOS checks the fake Claude program each time it
    // starts, and that check can be held up for half a minute while other programs go first.
    let stop_requested = Instant::now();
    stopper.stop();
    steps.extend(turn.by_ref());

    assert!(matches!(steps.last(), Some(Step::Stopped)), "{steps:?}");
    assert_eq!(turn.text(), "Partial");
    assert_eq!(turn.mood(), Some(Mood::Neutral));

    let pid = std::fs::read_to_string(cwd.join("fake-claude-pid")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while is_alive(&pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!is_alive(&pid), "the process {pid} is still running");
    assert!(
        stop_requested.elapsed() < Duration::from_secs(20),
        "stop must not wait for the sleep"
    );
}
