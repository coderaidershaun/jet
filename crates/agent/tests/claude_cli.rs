//! Contract tests for the door to Claude Code: the real `ClaudeCli` and the real `Turn`,
//! with the `fake-claude` program standing in for Claude Code itself.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use agent::{ClaudeCli, Effort, Model, Mood, Request, SessionId, SessionMode, Step, Turn};
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
        json!({"CLAUDE_CODE_PROMPT_CACHE_TTL": "1h"}),
        "of the Claude variables, only the cache lifetime reaches the program"
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
