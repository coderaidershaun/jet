//! The environment and command line the real `ClaudeCli` gives Claude Code. This test changes the
//! environment of its own process, so it lives in a file of its own, where no other test runs
//! beside it.

mod support;

use std::path::Path;

use agent::{FACADE_TOOLS, McpConnection, Request, SessionId, SessionMode, Step, Turn};
use serde_json::json;
use support::{chat_request, fake_claude};

fn recorded_args(cwd: &Path) -> Vec<String> {
    let text = std::fs::read_to_string(cwd.join("fake-claude-args.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

#[test]
fn claude_runs_with_only_jets_tools_and_a_scrubbed_environment() {
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
    let (claude, cwd) = fake_claude();
    let prompt = "[local time: Tue 14 Oct 2026, 11:20]\nfixture:quanty-search-reply";
    let request = Request {
        mcp: Some(McpConnection {
            url: "http://localhost/mcp".into(),
            token: "fixture".into(),
        }),
        hosts: vec!["docs.rs".into(), "github.com".into()],
        ..chat_request(prompt, SessionMode::Resume(SessionId("abc-123".into())))
    };
    let steps: Vec<Step> = Turn::start(&claude, &request).unwrap().collect();
    assert!(matches!(steps.last(), Some(Step::Finished(_))), "{steps:?}");

    // Claude Code must run with nothing but Jet's tools, its own web search, page reading that
    // asks Jet first, and no settings of the user's. Safe mode is left out, because it would drop
    // the MCP servers.
    let hook = r#"{"hooks":{"PreToolUse":[{"hooks":[{"headers":{"x-jet-turn":"fixture"},"onFailure":"block","timeout":10,"type":"http","url":"http://localhost/web-hook?hosts=docs.rs%2Cgithub.com"}],"matcher":"WebFetch"}]}}"#;
    let mcp = r#"{"mcpServers":{"jet":{"headers":{"x-jet-turn":"fixture"},"type":"http","url":"http://localhost/mcp"}}}"#;
    let allowed = FACADE_TOOLS
        .map(|tool| format!("mcp__jet__{tool}"))
        .join(",")
        + ",WebSearch,WebFetch(domain:docs.rs),WebFetch(domain:github.com)";
    let expected = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model",
        "sonnet",
        "--effort",
        "medium",
        "--system-prompt",
        "You are Jet.",
        "--tools",
        "WebSearch,WebFetch",
        "--setting-sources",
        "",
        "--settings",
        hook,
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--mcp-config",
        mcp,
        "--allowedTools",
        &allowed,
        "--no-chrome",
        "--permission-prompts",
        "none",
        "--autocompact",
        "100k",
        "--max-budget-usd",
        "1.00",
        "--resume",
        "abc-123",
    ];
    assert_eq!(recorded_args(cwd.path()), expected);
    // The two configs hold the turn's token, so Claude Code gets them as files, not on the
    // command line, where every account on the machine can read them.
    let argv = std::fs::read_to_string(cwd.path().join("fake-claude-argv.json")).unwrap();
    assert!(!argv.contains("x-jet-turn"), "{argv}");

    let env = std::fs::read_to_string(cwd.path().join("fake-claude-env.json")).unwrap();
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
    let args = recorded_args(cwd.path());
    assert!(args.contains(&"--no-session-persistence".to_owned()));
    assert!(args.contains(&"{\"type\":\"object\"}".to_owned()));
}
