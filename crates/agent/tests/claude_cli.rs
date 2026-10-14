//! Contract tests for the door to Claude Code: the real `ClaudeCli` and the real `Turn`,
//! with the `fake-claude` program standing in for Claude Code itself. One test also runs
//! a whole reply through `Conversation`, to the events and the saved thread.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use agent::{
    ClaudeCli, Conversation, DataDir, Effort, Event, McpServer, McpServers, McpStatus, Message,
    Model, Mood, Persona, Request, SessionId, SessionMode, Step, Tone, Turn,
};
use serde_json::json;

const SONNET_RECORDING: &str = include_str!("fixtures/sonnet-mood-reply.jsonl");

fn fake_claude(name: &str) -> (ClaudeCli, PathBuf) {
    let cwd = std::env::temp_dir().join(format!("agent-contract-{}-{name}", std::process::id()));
    std::fs::remove_dir_all(&cwd).ok();
    let program = PathBuf::from(env!("CARGO_BIN_EXE_fake-claude"));
    (ClaudeCli::at(program, cwd.clone()), cwd)
}

fn chat_request(prompt: &str, session: SessionMode) -> Request {
    Request {
        prompt: prompt.to_owned(),
        system_prompt: "You are Jet.".to_owned(),
        model: Model::Sonnet,
        effort: Effort::Medium,
        budget_usd: 1.0,
        session,
        schema: None,
        mcp_config: None,
    }
}

fn recorded_args(cwd: &Path) -> Vec<String> {
    let text = std::fs::read_to_string(cwd.join("fake-claude-args.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

#[test]
fn fake_claude_streams_a_turn() {
    // SAFETY: in this test binary only Rust's standard library touches the environment, and
    // `set_var`, `remove_var`, `vars_os` and `Command::spawn` take the same internal lock,
    // so no reader ever sees a half-written value.
    unsafe {
        // Claude variables this test inherited are dropped first, so that the result does
        // not depend on how the tests were started.
        for (name, _) in std::env::vars_os() {
            if name.to_string_lossy().starts_with("CLAUDE") {
                std::env::remove_var(name);
            }
        }
        let session = [
            ("CLAUDECODE", "1"),
            ("CLAUDE_PID", "1"),
            ("CLAUDE_EFFORT", "high"),
            ("CLAUDE_CODE_FOO", "bar"),
        ];
        for (name, value) in session {
            std::env::set_var(name, value);
        }
    }
    let (claude, cwd) = fake_claude("streams");
    let prompt = "[local time: Tue 14 Oct 2026, 11:20]\nfixture:sonnet-mood-reply";
    let resume = SessionMode::Resume(SessionId("abc-123".into()));
    let turn = Turn::start(&claude, &chat_request(prompt, resume)).unwrap();
    let steps: Vec<Step> = turn.collect();

    let raw_lines = steps
        .iter()
        .filter(|step| matches!(step, Step::Raw(_)))
        .count();
    assert_eq!(raw_lines, SONNET_RECORDING.lines().count());
    assert!(
        matches!(steps.iter().find(|s| matches!(s, Step::Init { .. })),
        Some(Step::Init { model, .. }) if model == "claude-sonnet-5-5")
    );
    let mood_at = steps
        .iter()
        .position(|s| matches!(s, Step::Mood(Mood::Excited)))
        .unwrap();
    let text_at = steps
        .iter()
        .position(|s| matches!(s, Step::Text(_)))
        .unwrap();
    assert!(mood_at < text_at, "the mood comes before the first text");
    let text: String = steps
        .iter()
        .filter_map(|step| match step {
            Step::Text(delta) => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert!(text.starts_with("Congratulations"), "{text}");
    let Some(Step::Finished(summary)) = steps.last() else {
        panic!("a turn ends with Finished: {:?}", steps.last());
    };
    assert_eq!(summary.usage.cache_creation_tokens, 1575);

    let args = recorded_args(&cwd);
    assert_eq!(args[0], "-p");
    let at = |flag: &str| args.iter().position(|arg| arg == flag).unwrap();
    assert_eq!(args[at("--system-prompt") + 1], "You are Jet.");
    assert_eq!(
        args[at("--tools") + 1],
        "",
        "the empty tool list is one empty argument"
    );
    assert_eq!(args[args.len() - 2..], ["--resume", "abc-123"]);
    let env = std::fs::read_to_string(cwd.join("fake-claude-env.json")).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&env).unwrap(),
        json!({
            "CLAUDE_CODE_PROMPT_CACHE_TTL": "1h",
            "CLAUDE_CODE_DISABLE_CLAUDE_MDS": "1",
            "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
        }),
        "of the Claude variables, only Jet's own settings reach the program"
    );

    let review = Request {
        schema: Some(json!({"type": "object"})),
        session: SessionMode::Ephemeral,
        ..chat_request("fixture:haiku-review", SessionMode::New)
    };
    let steps: Vec<Step> = Turn::start(&claude, &review).unwrap().collect();
    let Some(Step::Finished(summary)) = steps.last() else {
        panic!("the review ends with Finished: {:?}", steps.last());
    };
    let notes = summary
        .structured_output
        .as_ref()
        .expect("the review answers as data");
    assert_eq!(notes["changed"], true);
    let args = recorded_args(&cwd);
    assert!(args.contains(&"--no-session-persistence".to_owned()));
    assert!(args.contains(&"{\"type\":\"object\"}".to_owned()));
}

#[test]
fn a_recorded_quanty_search_reaches_the_page_and_the_thread() {
    let (claude, cwd) = fake_claude("quanty");
    let conversation = Conversation::new(DataDir::new(cwd.join("data")));
    let enabled = |command: &str| McpServer {
        enabled: true,
        command: command.into(),
        cwd: None,
    };
    let message = Message {
        text: "fixture:quanty-search-reply".to_owned(),
        persona: Persona::default(),
        tone: Tone::default(),
        model: Model::Sonnet,
        effort: Effort::Medium,
        budget_usd: 1.0,
        local_time: "Tue 14 Oct 2026, 11:20".to_owned(),
        mcp: McpServers {
            quanty: enabled("/q/quanty-mcp"),
            polysim: enabled("/p/polysim-mcp"),
        },
    };
    let (_, reply) = conversation.send(Arc::new(claude), message).unwrap();
    let events: Vec<Event> = reply.collect();

    let Some(Event::Started { mcp, .. }) =
        events.iter().find(|e| matches!(e, Event::Started { .. }))
    else {
        panic!("the reply starts with Started: {events:?}");
    };
    let status = |name: &str, status: &str| McpStatus {
        name: name.to_owned(),
        status: status.to_owned(),
    };
    assert_eq!(
        mcp,
        &[status("polysim", "failed"), status("quanty", "connected")]
    );

    let tool_started: Vec<&Event> = events
        .iter()
        .filter(|e| matches!(e, Event::ToolStarted { .. }))
        .collect();
    let [
        Event::ToolStarted {
            id,
            server,
            tool,
            input,
        },
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
    let Some(Event::ToolFinished {
        id: finished_id,
        ok,
        result,
        summary,
        ..
    }) = events
        .iter()
        .find(|e| matches!(e, Event::ToolFinished { .. }))
    else {
        panic!("the call finishes: {events:?}");
    };
    assert_eq!(finished_id, id);
    assert!(ok);
    assert_eq!(result["results"].as_array().unwrap().len(), 5);
    assert_eq!(summary, "quanty · search · 5 results");

    let position = |wanted: fn(&Event) -> bool| events.iter().position(wanted).unwrap();
    let order = [
        position(|e| matches!(e, Event::Started { .. })),
        position(|e| matches!(e, Event::ToolStarted { .. })),
        position(|e| matches!(e, Event::ToolFinished { .. })),
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

    let Some(Event::Finished { entry, .. }) = events.last() else {
        panic!("the reply ends with Finished: {:?}", events.last());
    };
    let [saved] = &entry.entry.tools[..] else {
        panic!("the saved entry keeps the call: {:?}", entry.entry.tools);
    };
    assert_eq!(
        (&saved.id, &saved.input, &saved.result, &saved.summary),
        (id, input, result, summary)
    );
    let history = conversation.history(10).unwrap();
    assert_eq!(history.last().unwrap().entry.tools, entry.entry.tools);

    let args = recorded_args(&cwd);
    let at = |flag: &str| args.iter().position(|arg| arg == flag).unwrap();
    assert_eq!(args[at("--tools") + 1], "ToolSearch");
    assert!(args[at("--mcp-config") + 1].contains("/q/quanty-mcp"));
    assert!(args.contains(&"--allowedTools".to_owned()));
    assert!(!args.contains(&"--safe-mode".to_owned()));
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
    let started = Instant::now();

    let mut steps = Vec::new();
    for step in turn.by_ref() {
        let partial_arrived = matches!(&step, Step::Text(text) if text == "Partial");
        steps.push(step);
        if partial_arrived {
            stopper.stop();
            break;
        }
    }
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
        started.elapsed() < Duration::from_secs(20),
        "stop must not wait for the sleep"
    );
}
