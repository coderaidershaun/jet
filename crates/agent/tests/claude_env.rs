//! The environment and command line the real `ClaudeCli` gives Claude Code. This test changes the
//! environment of its own process, so it lives in a file of its own, where no other test runs
//! beside it.

mod support;

use std::path::Path;

use agent::{FACADE_TOOLS, McpConnection, Mood, Request, SessionId, SessionMode, Step, Turn};
use serde_json::json;
use support::{chat_request, fake_claude};

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
            ("CLAUDE_CONFIG_DIR", "/the/users/claude/folder"),
        ];
        for (name, value) in session {
            std::env::set_var(name, value);
        }
    }
    let (claude, cwd) = fake_claude("streams");
    let prompt = "[local time: Tue 14 Oct 2026, 11:20]\nfixture:sonnet-mood-reply";
    let request = Request {
        mcp: Some(McpConnection {
            url: "http://localhost/mcp".into(),
            token: "fixture".into(),
        }),
        ..chat_request(prompt, SessionMode::Resume(SessionId("abc-123".into())))
    };
    let steps: Vec<Step> = Turn::start(&claude, &request).unwrap().collect();

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

    // Claude Code must run with nothing but Jet's own tools and no settings of the user's.
    let args = recorded_args(&cwd);
    let value_of = |flag: &str| &args[args.iter().position(|arg| arg == flag).unwrap() + 1];
    assert_eq!(args[0], "-p");
    assert_eq!(value_of("--system-prompt"), "You are Jet.");
    for (flag, value) in [
        ("--tools", ""),
        ("--setting-sources", ""),
        ("--permission-prompts", "none"),
    ] {
        assert_eq!(value_of(flag), value, "{flag}");
    }
    for flag in [
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--no-chrome",
    ] {
        assert!(args.iter().any(|arg| arg == flag), "{flag}");
    }
    assert!(
        !args.iter().any(|arg| arg == "--safe-mode"),
        "safe mode would drop the MCP servers"
    );
    assert!(value_of("--mcp-config").contains("http://localhost/mcp"));
    let allowed: Vec<&str> = value_of("--allowedTools").split(',').collect();
    assert_eq!(allowed.len(), FACADE_TOOLS.len());
    assert!(
        allowed.iter().all(|tool| tool.starts_with("mcp__jet__")),
        "{allowed:?}"
    );
    assert_eq!(args[args.len() - 2..], ["--resume", "abc-123"]);

    let env = std::fs::read_to_string(cwd.join("fake-claude-env.json")).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&env).unwrap(),
        json!({
            "CLAUDE_CODE_PROMPT_CACHE_TTL": "1h",
            "CLAUDE_CODE_DISABLE_CLAUDE_MDS": "1",
            "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
            "CLAUDE_CONFIG_DIR": "/the/users/claude/folder",
        }),
        "of the Claude variables, only Jet's own settings and the user's config folder reach the program"
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
