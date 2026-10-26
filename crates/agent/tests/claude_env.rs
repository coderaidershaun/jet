//! The environment the real `ClaudeCli` gives Claude Code. This test changes the environment of
//! its own process, so it lives in a file of its own, where no other test runs beside it.

use std::path::{Path, PathBuf};

use agent::{ClaudeCli, Effort, Model, Mood, Request, SessionId, SessionMode, Step, Turn};
use serde_json::json;

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
        mcp: None,
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

    assert!(
        matches!(steps.iter().find(|s| matches!(s, Step::Init { .. })),
        Some(Step::Init { model, .. }) if model == "claude-sonnet-5-5")
    );
    let mood_at = steps
        .iter()
        .position(|s| matches!(s, Step::Mood(Mood::Neutral)))
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
    assert_eq!(summary.context_tokens, 1577);

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
