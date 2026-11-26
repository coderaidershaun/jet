//! The real agy transport against a local stand-in: the command line, the files that limit a turn
//! to Jet's tools, and agy's stream read through a real turn.
use std::path::Path;
use std::time::{Duration, Instant};

use agent::{
    AgyCli, Effort, FACADE_TOOLS, McpConnection, Model, Mood, Request, SessionId, SessionMode,
    Step, Transport, TransportError, Turn, TurnError,
};
use serde_json::{Value, json};

const DENY: &str = r#"{"permissions":{"deny":["command(*)","read_file(*)","write_file(*)","read_url(*)","execute_url(*)"]}}"#;

fn request(prompt: &str) -> Request {
    Request {
        prompt: prompt.into(),
        system_prompt: "Answer briefly.".into(),
        model: Model::Gemini4Neon,
        effort: Effort::XHigh,
        budget_usd: 1.0,
        session: SessionMode::New,
        schema: None,
        mcp: Some(McpConnection {
            url: "http://127.0.0.1:4321/mcp".into(),
            token: "turn-token".into(),
        }),
        hosts: vec!["github.com".into()],
    }
}

/// The stand-in, set to run in a folder that it makes itself, as the host's is.
fn fake(dir: &Path) -> AgyCli {
    AgyCli::at(env!("CARGO_BIN_EXE_fake-agy").into(), dir.join("work"))
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn recorded_args(work: &Path) -> Vec<String> {
    serde_json::from_str(&read(&work.join("fake-agy-args.json"))).unwrap()
}

/// The message the stand-in was given on standard input.
fn sent_message(work: &Path) -> String {
    let line = read(&work.join("fake-agy-stdin.txt"));
    assert!(
        line.ends_with('\n') && line.matches('\n').count() == 1,
        "{line:?}"
    );
    let message: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(message["event"], "user", "{line}");
    message["message"]["content"].as_str().unwrap().to_owned()
}

fn agent_file(name: &str, tools: &str, inherit_mcp: bool, hooks: &str) -> String {
    format!(
        "---\nname: {name}\ndescription: Jet\ntools: [{tools}]\nmainAgent: true\nsubagent: false\n\
         excludeDefaultComponents: true\ninheritMcp: {inherit_mcp}\ninheritCustomizations: false\n\
         hooks:\n  - ../{hooks}\n---\n\n# System Prompt\nAnswer briefly.\n"
    )
}

fn hooks_file(name: &str, allowed: &str) -> Value {
    let command = format!("awk -v allowed='{allowed}' -f allow.awk");
    json!({name: {"PreToolUse": [{"matcher": "*", "hooks": [
        {"type": "command", "command": command, "timeout": 10},
    ]}]}})
}

#[test]
fn an_agy_turn_runs_as_an_agent_that_has_only_jets_tools() {
    let dir = tempfile::tempdir().unwrap();
    let cli = fake(dir.path());
    let work = cli.folder().to_owned();
    let agents = work.join(".agents");
    let facade_names = FACADE_TOOLS.map(|tool| format!("mcp_jet_{tool}")).join(",");

    // A new chat turn: the words, the mood, one call of Jet's tool with its result, and the
    // tokens of this turn's two model calls, not the whole conversation's that agy reports last.
    let mut turn = Turn::start(&cli, &request("hello")).unwrap();
    let steps: Vec<Step> = turn.by_ref().collect();
    assert!(
        matches!(&steps[0], Step::Init { session_id } if session_id.0 == "fake-agy-conversation"),
        "{steps:?}"
    );
    assert_eq!(turn.text(), "Let me look.\n\nHello from agy.\n");
    assert_eq!(turn.mood(), Some(Mood::Hello));
    let [call] = turn.tools() else {
        panic!("the refused manage_task shows no card: {:?}", turn.tools());
    };
    assert_eq!(
        (call.id.as_str(), call.server.as_str(), call.tool.as_str()),
        ("fake-agy-conversation:3", "jet", "tools_search")
    );
    assert_eq!(call.input, json!({"query": "vega"}));
    assert!(call.ok);
    assert_eq!(
        call.result,
        json!({"errors": [], "tools": [], "truncated": false})
    );
    let Some(Step::Finished(summary)) = steps.last() else {
        panic!("{steps:?}");
    };
    assert_eq!(summary.context_tokens, 2048 + 2368 + 520);
    assert_eq!(summary.context.used_tokens, Some(2368 + 520 + 40));
    assert!(!summary.context.estimated);
    assert_eq!(summary.context.limit_tokens, None);

    let mut expected: Vec<String> = [
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
        "--disable-slash-commands",
        "--settings",
        DENY,
        "--agent",
        "jet",
        "--model",
        "gemini-4-neon",
        "--effort",
        "xhigh",
    ]
    .map(String::from)
    .into();
    assert_eq!(recorded_args(&work), expected);
    assert_eq!(sent_message(&work), "hello");
    assert_eq!(
        read(&agents.join("agents/jet.md")),
        agent_file("jet", "", true, "hooks.json")
    );
    assert_eq!(
        serde_json::from_str::<Value>(&read(&agents.join("hooks.json"))).unwrap(),
        hooks_file("jet-allow", &facade_names)
    );
    assert_eq!(
        read(&agents.join("allow.awk")),
        include_str!("../src/turn/transport/agy/allow.awk")
    );
    let eager: serde_json::Map<String, Value> = FACADE_TOOLS
        .iter()
        .map(|tool| ((*tool).to_owned(), json!({"eager": true})))
        .collect();
    assert_eq!(
        serde_json::from_str::<Value>(&read(&work.join("fake-agy-mcp.json"))).unwrap(),
        json!({"mcpServers": {"jet": {
            "url": "http://127.0.0.1:4321/mcp",
            "headers": {"x-jet-turn": "turn-token"},
            "enabledTools": FACADE_TOOLS,
            "tools": eager,
        }}})
    );
    // The file with the turn's token goes once the run is over.
    drop(turn);
    let deadline = Instant::now() + Duration::from_secs(8);
    while agents.join("mcp_config.json").exists() {
        assert!(Instant::now() < deadline, "the token file stayed");
        std::thread::sleep(Duration::from_millis(10));
    }

    // A continued turn names the conversation. agy keeps the system prompt the conversation
    // began with, so a changed one goes in the message, once.
    let mut resumed = request("and again");
    resumed.session = SessionMode::Resume(SessionId("fake-agy-conversation".into()));
    let finished = |request: &Request| {
        let last = Turn::start(&cli, request).unwrap().last();
        assert!(matches!(last, Some(Step::Finished(_))), "{last:?}");
    };
    finished(&resumed);
    expected.extend(["--conversation", "fake-agy-conversation"].map(String::from));
    assert_eq!(recorded_args(&work), expected);
    assert_eq!(sent_message(&work), "and again");
    resumed.system_prompt = "Answer briefly.\n<memory>likes tea</memory>".into();
    finished(&resumed);
    let message = sent_message(&work);
    assert!(
        message.starts_with("[Your instructions and notes have changed")
            && message.contains("\n-----\nAnswer briefly.\n<memory>likes tea</memory>\n-----\n")
            && message.ends_with("\nand again"),
        "{message}"
    );
    finished(&resumed);
    assert_eq!(sent_message(&work), "and again");
    // A turn that fails before the model reads a changed prompt leaves it to send again.
    resumed.system_prompt = "Answer briefly.\n<memory>likes coffee</memory>".into();
    let mut failing = resumed.clone();
    failing.prompt = "exit".into();
    let last = Turn::start(&cli, &failing).unwrap().last();
    assert!(matches!(last, Some(Step::Failed(_))), "{last:?}");
    assert!(sent_message(&work).contains("likes coffee"));
    finished(&resumed);
    assert!(sent_message(&work).contains("likes coffee"));
    finished(&resumed);
    assert_eq!(sent_message(&work), "and again");

    // The notes review: an agent of its own with agy's `finish` tool, which the schema needs,
    // and without Jet's tool server.
    let mut review = request("review");
    review.session = SessionMode::Ephemeral;
    review.model = cli.review_model();
    review.effort = Effort::Low;
    review.mcp = None;
    let schema = json!({"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false});
    review.schema = Some(schema.clone());
    let Some(Step::Finished(summary)) = Turn::start(&cli, &review).unwrap().last() else {
        panic!("the review failed");
    };
    assert_eq!(summary.structured_output, Some(json!({"ok": true})));
    let expected: Vec<String> = [
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
        "--disable-slash-commands",
        "--settings",
        DENY,
        "--agent",
        "jet-review",
        "--model",
        "gemini-4-neon",
        "--effort",
        "low",
        "--json-schema",
        &schema.to_string(),
    ]
    .map(String::from)
    .into();
    assert_eq!(recorded_args(&work), expected);
    assert_eq!(
        read(&agents.join("agents/jet-review.md")),
        agent_file("jet-review", "finish", false, "hooks-review.json")
    );
    assert_eq!(
        serde_json::from_str::<Value>(&read(&agents.join("hooks-review.json"))).unwrap(),
        hooks_file("jet-review-allow", "finish")
    );

    // A tool of agy's own that ran means the limit did not hold, and a line agy does not write
    // at the proven version means it is no longer certain: the turn fails and the program is
    // stopped.
    for (prompt, ran) in [
        ("outside", Some("run_command")),
        ("outside and failed", Some("run_command")),
        ("outside with no name", Some("an unnamed tool")),
        ("a new event", None),
        ("a new step", None),
        ("not json", None),
    ] {
        let mut turn = Turn::start(&cli, &request(prompt)).unwrap();
        let last = turn.by_ref().last();
        let Some(Step::Failed(TurnError::Transport(error))) = &last else {
            panic!("{prompt}: {last:?}");
        };
        match (error, ran) {
            (TransportError::AgyTool { tool }, Some(ran)) => assert_eq!(tool, ran, "{prompt}"),
            (TransportError::AgyLine { .. }, None) => {}
            _ => panic!("{prompt}: {error:?}"),
        }
        assert!(turn.stopper().is_stopped(), "{prompt}");
    }

    // A failure before the turn begins comes back as the program's exit, which is what lets a
    // lost conversation start again; one inside the turn comes back in agy's words.
    let last = Turn::start(&cli, &request("exit")).unwrap().last();
    assert!(
        matches!(&last, Some(Step::Failed(TurnError::Transport(TransportError::Exited { stderr, .. }))) if stderr.contains("authentication failed")),
        "{last:?}"
    );
    let last = Turn::start(&cli, &request("fail")).unwrap().last();
    assert!(
        matches!(&last, Some(Step::Failed(TurnError::Reported { message, .. })) if message == "agent executor error: quota"),
        "{last:?}"
    );
    let mut turn = Turn::start(&cli, &request("hang")).unwrap();
    turn.stopper().stop();
    assert!(matches!(turn.by_ref().last(), Some(Step::Stopped)));

    // agy runs Neon at four thinking levels, and no other model.
    for (model, effort) in [
        (Model::Gemini4Neon, Effort::Max),
        (Model::Gemini4Neon, Effort::Ultra),
        (Model::Sonnet, Effort::Low),
    ] {
        let mut unsupported = request("hello");
        (unsupported.model, unsupported.effort) = (model, effort);
        assert!(matches!(
            Turn::start(&cli, &unsupported),
            Err(TurnError::Transport(TransportError::AgyModel { .. }))
        ));
    }
}

#[test]
fn agy_does_not_run_in_a_folder_that_is_not_its_own_or_lies_below_a_checkout() {
    let dir = tempfile::tempdir().unwrap();
    let program: std::path::PathBuf = env!("CARGO_BIN_EXE_fake-agy").into();
    let at = |path: &str| dir.path().join(path);

    // agy takes its files from a folder of any of these names, in each folder above.
    for name in [".git", ".agents", ".agent", "_agents", "_agent"] {
        std::fs::create_dir_all(at(&format!("below{name}/{name}"))).unwrap();
    }
    // A path that reaches such a folder only through a link.
    std::fs::create_dir_all(at("real/.agents")).unwrap();
    std::fs::create_dir_all(at("real/inside")).unwrap();
    std::os::unix::fs::symlink(at("real/inside"), at("alias")).unwrap();
    // A folder that other users can open.
    std::fs::create_dir(at("open")).unwrap();
    let open = std::os::unix::fs::PermissionsExt::from_mode(0o755);
    std::fs::set_permissions(at("open"), open).unwrap();
    // A link someone put in the folder's place, to a folder that is private.
    let private = AgyCli::at(program.clone(), at("target"));
    let last = Turn::start(&private, &request("hello")).unwrap().last();
    assert!(matches!(last, Some(Step::Finished(_))), "{last:?}");
    std::fs::remove_dir_all(at("target/.agents")).unwrap();
    std::os::unix::fs::symlink(at("target"), at("link")).unwrap();
    for (folder, said) in [
        ("below.git/data/work", "whose .git agy"),
        ("below.agents/work", "whose .agents agy"),
        ("below.agent/work", "whose .agent agy"),
        ("below_agents/work", "whose _agents agy"),
        ("below_agent/work", "whose _agent agy"),
        ("alias/work", "whose .agents agy"),
        ("open", "other users"),
        ("link", "a link"),
    ] {
        let cli = AgyCli::at(program.clone(), at(folder));
        let Err(TurnError::Transport(error @ TransportError::AgyFolder(_))) =
            Turn::start(&cli, &request("hello"))
        else {
            panic!("agy ran in {folder}");
        };
        assert!(error.to_string().contains(said), "{folder}: {error}");
        assert!(!at(folder).join(".agents").exists(), "{folder}");
    }
}

#[test]
fn agy_at_a_version_the_limit_was_not_proven_on_does_not_run() {
    let dir = tempfile::tempdir().unwrap();
    let program: std::path::PathBuf = env!("CARGO_BIN_EXE_fake-agy").into();
    assert!(AgyCli::locate(Some(&program), dir.path(), 1).is_ok());

    // The stand-in says it is the version in the name it is started under, as agy would after it
    // replaced itself with a newer one.
    let newer = dir.path().join("agy-1.5.17");
    std::os::unix::fs::symlink(&program, &newer).unwrap();
    let Err(error @ TransportError::AgyVersion { .. }) =
        AgyCli::locate(Some(&newer), dir.path(), 1)
    else {
        panic!("a version that was not proven was taken");
    };
    let said = error.to_string();
    assert!(
        said.contains("version 1.5.17") && said.contains("only at version 1.5.16"),
        "{said}"
    );
}
