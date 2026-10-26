//! The real Codex transport against a local stand-in, plus an opt-in live smoke test.
use agent::{
    CodexCli, Effort, McpConnection, Model, Request, SessionId, SessionMode, Step, Transport,
    TransportError, Turn, TurnError,
};
use serde_json::json;
fn request(prompt: &str) -> Request {
    Request {
        prompt: prompt.into(),
        system_prompt: "Answer briefly.".into(),
        model: Model::Gpt61Sol,
        effort: Effort::High,
        budget_usd: 1.0,
        session: SessionMode::New,
        schema: None,
        mcp: None,
    }
}
fn fake(dir: &std::path::Path) -> CodexCli {
    CodexCli::at(env!("CARGO_BIN_EXE_fake-codex").into(), dir.into())
}
#[test]
fn codex_stream_resume_schema_usage_and_tool_results() {
    let dir = tempfile::tempdir().unwrap();
    let cli = fake(dir.path());
    let mut req = request("hello");
    req.mcp = Some(McpConnection {
        url: "http://127.0.0.1:4321/mcp".into(),
        token: "turn-token".into(),
    });
    let mut turn = Turn::start(&cli, &req).unwrap();
    let steps: Vec<_> = turn.by_ref().collect();
    assert_eq!(turn.text(), "Hello from Codex.");
    assert_eq!(turn.tools().len(), 1);
    assert_eq!(turn.tools()[0].result, json!({"results":[]}));
    let Step::Finished(summary) = steps.last().unwrap() else {
        panic!("{steps:?}");
    };
    assert_eq!(summary.context_tokens, 100);
    assert_eq!(summary.context.used_tokens, Some(112));
    assert!(summary.context.estimated);
    assert_eq!(summary.context.limit_tokens, None);
    let args: Vec<String> =
        serde_json::from_slice(&std::fs::read(dir.path().join("fake-codex-args.json")).unwrap())
            .unwrap();
    assert!(args.contains(&"model_reasoning_effort=\"high\"".into()));
    assert!(args.contains(&"features.shell_tool=false".into()));
    assert!(args.contains(&"mcp_servers.jet.http_headers.x-jet-turn=\"turn-token\"".into()));
    assert!(args.contains(&format!(
        "mcp_servers.jet.enabled_tools={}",
        json!(agent::FACADE_TOOLS)
    )));
    assert!(args.contains(&"mcp_servers.jet.default_tools_approval_mode=\"approve\"".into()));
    for (prompt, expected) in [("context-usage", 42), ("context-overflow", u64::MAX)] {
        let Step::Finished(summary) = Turn::start(&cli, &request(prompt)).unwrap().last().unwrap()
        else {
            panic!("context measurement failed");
        };
        assert_eq!(summary.context.used_tokens, Some(expected));
        assert_eq!(summary.context.limit_tokens, Some(90000));
        assert!(!summary.context.estimated);
    }
    let mut failed_tool = Turn::start(&cli, &request("tool-fail")).unwrap();
    assert!(matches!(
        failed_tool.by_ref().last(),
        Some(Step::Finished(_))
    ));
    assert_eq!(failed_tool.tools().len(), 1);
    assert!(!failed_tool.tools()[0].ok);
    assert_eq!(
        failed_tool.tools()[0].result,
        json!({"message":"tool unavailable"})
    );
    req.session = SessionMode::Resume(SessionId("codex-session".into()));
    assert!(matches!(
        Turn::start(&cli, &req).unwrap().last(),
        Some(Step::Finished(_))
    ));
    let args: Vec<String> =
        serde_json::from_slice(&std::fs::read(dir.path().join("fake-codex-args.json")).unwrap())
            .unwrap();
    assert!(args.contains(&"resume".into()));
    assert_eq!(&args[args.len() - 2..], ["codex-session", "-"]);
    req.session = SessionMode::Ephemeral;
    req.model = cli.review_model();
    req.schema = Some(
        json!({"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}),
    );
    let Step::Finished(summary) = Turn::start(&cli, &req).unwrap().last().unwrap() else {
        panic!("review failed");
    };
    assert_eq!(summary.structured_output, Some(json!({"ok":true})));
}
#[test]
fn codex_errors_and_cancellation_are_terminal() {
    let dir = tempfile::tempdir().unwrap();
    let cli = fake(dir.path());
    for prompt in ["fail", "exit"] {
        let steps: Vec<_> = Turn::start(&cli, &request(prompt)).unwrap().collect();
        assert!(matches!(steps.last(), Some(Step::Failed(_))), "{steps:?}");
    }
    let mut turn = Turn::start(&cli, &request("hang")).unwrap();
    turn.stopper().stop();
    assert!(matches!(turn.by_ref().last(), Some(Step::Stopped)));
    let mut req = request("hello");
    req.model = Model::Gpt6Luna;
    req.effort = Effort::Ultra;
    assert!(matches!(
        Turn::start(&cli, &req),
        Err(TurnError::Transport(TransportError::CodexModel { .. }))
    ));
}
#[test]
#[ignore = "uses the locally signed-in Codex subscription"]
fn live_codex_chat_and_resume() {
    let dir = tempfile::tempdir().unwrap();
    let cli = CodexCli::locate(None, dir.path()).unwrap();
    let mut req = request("Remember the word marigold. Reply with just OK.");
    req.effort = Effort::Low;
    let steps: Vec<_> = Turn::start(&cli, &req).unwrap().collect();
    assert!(matches!(steps.last(), Some(Step::Finished(_))), "{steps:?}");
    let id = steps
        .iter()
        .find_map(|s| {
            if let Step::Init { session_id, .. } = s {
                Some(session_id.clone())
            } else {
                None
            }
        })
        .unwrap();
    req.session = SessionMode::Resume(id);
    req.prompt = "What word did I ask you to remember? Reply with just the word.".into();
    let steps: Vec<_> = Turn::start(&cli, &req).unwrap().collect();
    let Some(Step::Finished(summary)) = steps.last() else {
        panic!("{steps:?}");
    };
    assert!(
        summary.result.to_lowercase().contains("marigold"),
        "{}",
        summary.result
    );
}

#[test]
#[ignore = "uses the locally signed-in Codex subscription"]
fn live_codex_review_schema() {
    let dir = tempfile::tempdir().unwrap();
    let cli = CodexCli::locate(None, dir.path()).unwrap();
    let mut req = request("Set changed to false and all three notes to empty strings.");
    req.session = SessionMode::Ephemeral;
    req.model = cli.review_model();
    req.effort = Effort::Low;
    req.schema = Some(
        json!({"type":"object","additionalProperties":false,"required":["changed","memory","user","recent"],"properties":{"changed":{"type":"boolean"},"memory":{"type":"string","maxLength":agent::MEMORY_LIMIT},"user":{"type":"string","maxLength":agent::USER_LIMIT},"recent":{"type":"string","maxLength":agent::RECENT_LIMIT}}}),
    );
    let steps: Vec<_> = Turn::start(&cli, &req).unwrap().collect();
    let Some(Step::Finished(summary)) = steps.last() else {
        panic!("{steps:?}");
    };
    assert_eq!(
        summary.structured_output.as_ref().unwrap()["changed"],
        false
    );
}
