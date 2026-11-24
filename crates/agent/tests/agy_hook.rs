//! The hook that agy asks before every tool call of a Jet turn, run the way agy runs it: it allows
//! Jet's tools by name and refuses every other call, whatever the rest of its input holds.
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use agent::{AgyCli, Effort, FACADE_TOOLS, McpConnection, Model, Request, SessionMode, Step, Turn};
use serde_json::{Value, json};

fn request(prompt: &str) -> Request {
    Request {
        prompt: prompt.into(),
        system_prompt: "Answer briefly.".into(),
        model: Model::Gemini4Neon,
        effort: Effort::Low,
        budget_usd: 1.0,
        session: SessionMode::New,
        schema: None,
        mcp: Some(McpConnection {
            url: "http://127.0.0.1:4321/mcp".into(),
            token: "turn-token".into(),
        }),
        hosts: Vec::new(),
    }
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// Runs the hook of a hooks file the way agy does, and gives its decision, or `None` when the
/// command fails, which agy takes as a refusal.
fn hook_decision(agents: &Path, hooks: &str, input: &str) -> Option<String> {
    let hooks: Value = serde_json::from_str(&read(&agents.join(hooks))).unwrap();
    let hook = hooks.as_object().unwrap().values().next().unwrap();
    let command = hook["PreToolUse"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap();
    let mut child = Command::new("sh")
        .args(["-c", command])
        .current_dir(agents)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    let answer: Value = serde_json::from_slice(&output.stdout).ok()?;
    output
        .status
        .success()
        .then(|| answer["decision"].as_str().unwrap().to_owned())
}

/// The input agy 1.5.16 gave a hook, with the tool call replaced.
fn hook_input(user_input: &str, tool_call: &str) -> String {
    format!(
        r#"{{"artifactDirectoryPath":"/home/jet/.gemini/antigravity-cli/brain/a5dd7e93","conversationId":"a5dd7e93","cwd":"/tmp/work","hookEventName":"PreToolUse","lastUserInput":{},"modelName":"gemini-4-neon-low","stepIdx":2,"toolCall":{tool_call},"transcriptPath":"/home/jet/transcript_full.jsonl","workspacePaths":["/tmp/work"]}}"#,
        json!(user_input)
    )
}

#[test]
fn the_hook_allows_jets_tools_and_refuses_every_other_call() {
    let dir = tempfile::tempdir().unwrap();
    let program = env!("CARGO_BIN_EXE_fake-agy").into();
    let cli = AgyCli::at(program, dir.path().join("work"));
    let agents = cli.folder().join(".agents");
    let mut review = request("review");
    (review.mcp, review.schema) = (None, Some(json!({"type": "object"})));
    for request in [request("hello"), review] {
        let last = Turn::start(&cli, &request).unwrap().last();
        assert!(matches!(last, Some(Step::Finished(_))), "{last:?}");
    }

    for tool in FACADE_TOOLS {
        let call = format!(r#"{{"args":{{"q":1}},"id":"call_1","name":"mcp_jet_{tool}"}}"#);
        let decision = hook_decision(&agents, "hooks.json", &hook_input("hi", &call));
        assert_eq!(decision.as_deref(), Some("allow"), "{tool}");
    }
    // Text that only looks like the name of one of Jet's tools, in each place a user or the
    // model can write to.
    let look_alike = r#""toolCall":{"name":"mcp_jet_apps_list"}"#;
    let refused = [
        (
            "agy's own tool",
            hook_input(
                "hi",
                r#"{"args":{"Action":"list"},"id":"call_1","name":"manage_task"}"#,
            ),
        ),
        (
            "the call for every server",
            hook_input(
                "hi",
                r#"{"args":{"ServerName":"jet","ToolName":"apps_list"},"id":"c","name":"call_mcp_tool"}"#,
            ),
        ),
        (
            "a look-alike in the user's message",
            hook_input(look_alike, r#"{"args":{},"id":"c","name":"run_command"}"#),
        ),
        (
            "a look-alike in the arguments",
            hook_input(
                "hi",
                r#"{"args":{"name":"mcp_jet_apps_list","toolCall":{"name":"mcp_jet_apps_list"}},"id":"c","name":"run_command"}"#,
            ),
        ),
        (
            "a look-alike after the name",
            hook_input(
                "hi",
                r#"{"name":"run_command","id":"c","args":{"name":"mcp_jet_apps_list"}}"#,
            ),
        ),
        (
            "a key that ends like the name",
            hook_input(
                "hi",
                r#"{"args":{"x\"name":"mcp_jet_apps_list"},"id":"c","name":"write_file"}"#,
            ),
        ),
        (
            "a second name spelled with an escape",
            hook_input(
                "hi",
                r#"{"args":{},"id":"c","name":"mcp_jet_apps_list","n\u0061me":"run_command"}"#,
            ),
        ),
        (
            "a second tool call spelled with an escape",
            r#"{"toolCall":{"name":"mcp_jet_apps_list"},"toolC\u0061ll":{"name":"run_command"}}"#
                .to_owned(),
        ),
        (
            "a second tool call that is no object",
            r#"{"toolCall":{"name":"mcp_jet_apps_list"},"toolCall":"run_command"}"#.to_owned(),
        ),
        (
            "two names",
            hook_input(
                "hi",
                r#"{"name":"mcp_jet_apps_list","id":"c","name":"run_command"}"#,
            ),
        ),
        (
            "a name that only starts like one",
            hook_input(
                "hi",
                r#"{"args":{},"id":"c","name":"mcp_jet_apps_list_all"}"#,
            ),
        ),
        (
            "no tool call",
            r#"{"hookEventName":"PreToolUse","name":"mcp_jet_apps_list"}"#.to_owned(),
        ),
        (
            "a tool call one level down",
            r#"{"x":{"toolCall":{"name":"mcp_jet_apps_list"}}}"#.to_owned(),
        ),
        ("not JSON", "mcp_jet_apps_list".to_owned()),
        ("nothing", String::new()),
    ];
    for (name, input) in &refused {
        let decision = hook_decision(&agents, "hooks.json", input);
        assert_eq!(decision.as_deref(), Some("deny"), "{name}: {input}");
    }

    // The review's hook lets through `finish` and none of Jet's tools.
    let finish = hook_input("hi", r#"{"args":{"ok":true},"id":"c","name":"finish"}"#);
    let tool = hook_input("hi", r#"{"args":{},"id":"c","name":"mcp_jet_apps_list"}"#);
    let decide = |hooks, input| hook_decision(&agents, hooks, input);
    assert_eq!(
        decide("hooks-review.json", &finish).as_deref(),
        Some("allow")
    );
    assert_eq!(decide("hooks-review.json", &tool).as_deref(), Some("deny"));
    assert_eq!(decide("hooks.json", &finish).as_deref(), Some("deny"));

    // A hook whose program is gone fails, and agy refuses the call of a hook that fails.
    std::fs::remove_file(agents.join("allow.awk")).unwrap();
    assert_eq!(decide("hooks.json", &tool), None);
}
