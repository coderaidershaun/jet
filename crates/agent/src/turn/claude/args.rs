//! The exact command line, environment and MCP server config for a request. The flags and
//! their order stay fixed so that Claude's prompt cache keeps hitting.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::chat::{McpServer, McpServers};
use crate::turn::transport::{Request, SessionMode};

/// Keeps Claude's prompt cache alive for an hour instead of five minutes.
pub(super) const CACHE_TTL_ENV: (&str, &str) = ("CLAUDE_CODE_PROMPT_CACHE_TTL", "1h");

/// Turns off CLAUDE.md files and Claude Code's own memory, as safe mode would; safe mode
/// itself drops the MCP servers. Jet keeps its own notes.
pub(super) const ISOLATION_ENV: [(&str, &str); 2] = [
    ("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1"),
    ("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1"),
];

/// The tools Claude may run without asking. The names are exact, so the engine mode switch,
/// and any tool a server adds later, stay off.
const ALLOWED_TOOLS: &str = "mcp__quanty__search,mcp__quanty__answer,mcp__quanty__list_documents,\
    mcp__quanty__read_page,mcp__quanty__health,mcp__quanty__ingest_pdf,\
    mcp__quanty__ingest_status,mcp__polysim__list_strategies,mcp__polysim__start_strategy,\
    mcp__polysim__stop_strategy";

/// How long Claude Code waits for a server to answer before it gives up, in milliseconds.
const SERVER_TIMEOUT_MS: u64 = 300_000;

/// Runs a server in its own folder. Claude Code ignores a folder in the config, so the
/// folder and the program travel as arguments, and no path ever needs quoting here.
const LAUNCH_IN_FOLDER: &str = r#"cd "$1" && exec "$2""#;

/// The MCP servers as Claude Code's config JSON, or `None` when none is enabled. A server in
/// `shared` is reached at its address; any other is started by Claude Code for the reply.
/// The text depends on the settings and on those addresses, which stay the same for the
/// whole session, so it is the same bytes on every turn.
pub(crate) fn mcp_config(
    servers: &McpServers,
    shared: &BTreeMap<String, String>,
) -> Option<String> {
    let launches: Map<String, Value> = servers
        .enabled()
        .map(|(name, server)| {
            let entry = match shared.get(name) {
                Some(url) => reach(url),
                None => launch(name, server),
            };
            (name.to_owned(), entry)
        })
        .collect();
    if launches.is_empty() {
        return None;
    }
    Some(json!({ "mcpServers": launches }).to_string())
}

/// A server that is already running, reached by its address.
fn reach(url: &str) -> Value {
    json!({"timeout": SERVER_TIMEOUT_MS, "type": "http", "url": url})
}

fn launch(name: &str, server: &McpServer) -> Value {
    let command = server.command.to_string_lossy();
    match &server.cwd {
        Some(cwd) => json!({
            "args": ["-c", LAUNCH_IN_FOLDER, name, cwd.to_string_lossy(), command],
            "command": "/bin/sh",
            "timeout": SERVER_TIMEOUT_MS,
        }),
        None => json!({"command": command, "timeout": SERVER_TIMEOUT_MS}),
    }
}

/// The command line for a request. One function builds both the chat and the review
/// call, so the order of the flags cannot drift between them.
pub(super) fn args(request: &Request) -> Vec<String> {
    let ephemeral = request.session == SessionMode::Ephemeral;
    let mut args: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose"]
        .map(String::from)
        .into();
    if !ephemeral {
        args.push("--include-partial-messages".into());
    }
    args.extend([
        "--model".into(),
        request.model.alias().into(),
        "--effort".into(),
        request.effort.alias().into(),
        "--system-prompt".into(),
        request.system_prompt.clone(),
    ]);
    if let Some(schema) = &request.schema {
        args.extend(["--json-schema".into(), schema.to_string()]);
    }
    // Safe mode would drop the MCP servers, so the parts of it that matter are set one by one.
    let tools = if request.mcp_config.is_some() {
        "ToolSearch"
    } else {
        ""
    };
    args.extend(
        [
            "--tools",
            tools,
            "--setting-sources",
            "",
            "--disable-slash-commands",
            "--strict-mcp-config",
        ]
        .map(String::from),
    );
    if let Some(config) = &request.mcp_config {
        args.extend([
            "--mcp-config".into(),
            config.clone(),
            "--allowedTools".into(),
            ALLOWED_TOOLS.into(),
        ]);
    }
    args.extend(["--no-chrome", "--permission-prompts", "none"].map(String::from));
    if ephemeral {
        args.push("--no-session-persistence".into());
    } else {
        args.extend(["--autocompact".into(), "100k".into()]);
    }
    args.extend([
        "--max-budget-usd".into(),
        format!("{:.2}", request.budget_usd),
    ]);
    if let SessionMode::Resume(id) = &request.session {
        args.extend(["--resume".into(), id.0.clone()]);
    }
    args
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::*;
    use crate::chat::{Effort, McpServer, Model, SessionId};

    const BOTH_SERVERS: &str = r#"{"mcpServers":{"polysim":{"args":["-c","cd \"$1\" && exec \"$2\"","polysim","/p","/p/polysim-mcp"],"command":"/bin/sh","timeout":300000},"quanty":{"args":["-c","cd \"$1\" && exec \"$2\"","quanty","/q","/q/quanty-mcp"],"command":"/bin/sh","timeout":300000}}}"#;

    const QUANTY_SHARED: &str = r#"{"mcpServers":{"polysim":{"args":["-c","cd \"$1\" && exec \"$2\"","polysim","/p","/p/polysim-mcp"],"command":"/bin/sh","timeout":300000},"quanty":{"timeout":300000,"type":"http","url":"http://127.0.0.1:4321/mcp"}}}"#;

    const ALLOWED: &str = "mcp__quanty__search,mcp__quanty__answer,mcp__quanty__list_documents,\
        mcp__quanty__read_page,mcp__quanty__health,mcp__quanty__ingest_pdf,\
        mcp__quanty__ingest_status,mcp__polysim__list_strategies,mcp__polysim__start_strategy,\
        mcp__polysim__stop_strategy";

    fn server(command: &str, cwd: Option<&str>) -> McpServer {
        McpServer {
            enabled: true,
            command: command.into(),
            cwd: cwd.map(Into::into),
        }
    }

    fn chat_request(session: SessionMode) -> Request {
        Request {
            prompt: "hello".into(),
            system_prompt: "You-are-Jet.".into(),
            model: Model::Sonnet,
            effort: Effort::Medium,
            budget_usd: 10.0,
            session,
            schema: None,
            mcp_config: Some(BOTH_SERVERS.to_owned()),
        }
    }

    /// Splits a command line on spaces; `''` stands for one empty argument.
    fn words(line: &str) -> Vec<String> {
        let unquoted = |word: &str| word.trim_matches('\'').to_owned();
        line.split(' ').map(unquoted).collect()
    }

    #[test]
    fn chat_and_review_args_are_exact_without_safe_mode_which_drops_mcp_servers() {
        let both = McpServers {
            quanty: server("/q/quanty-mcp", Some("/q")),
            polysim: server("/p/polysim-mcp", Some("/p")),
        };
        let nothing_shared = BTreeMap::new();
        assert_eq!(
            mcp_config(&both, &nothing_shared).as_deref(),
            Some(BOTH_SERVERS)
        );
        assert_eq!(mcp_config(&McpServers::default(), &nothing_shared), None);
        let quanty_shared =
            BTreeMap::from([("quanty".to_owned(), "http://127.0.0.1:4321/mcp".to_owned())]);
        assert_eq!(
            mcp_config(&both, &quanty_shared).as_deref(),
            Some(QUANTY_SHARED)
        );
        // The address of a library that is switched off emits nothing.
        assert_eq!(mcp_config(&McpServers::default(), &quanty_shared), None);
        let no_folder = McpServers {
            quanty: server("/q/quanty-mcp", None),
            ..McpServers::default()
        };
        assert_eq!(
            mcp_config(&no_folder, &nothing_shared).as_deref(),
            Some(r#"{"mcpServers":{"quanty":{"command":"/q/quanty-mcp","timeout":300000}}}"#)
        );

        let new_chat = [
            words(
                "-p --output-format stream-json --verbose --include-partial-messages \
                 --model sonnet --effort medium --system-prompt You-are-Jet. \
                 --tools ToolSearch --setting-sources '' --disable-slash-commands \
                 --strict-mcp-config --mcp-config",
            ),
            vec![BOTH_SERVERS.to_owned()],
            words("--allowedTools"),
            vec![ALLOWED.to_owned()],
            words(
                "--no-chrome --permission-prompts none --autocompact 100k --max-budget-usd 10.00",
            ),
        ]
        .concat();
        assert_eq!(args(&chat_request(SessionMode::New)), new_chat);

        let no_servers = Request {
            mcp_config: None,
            ..chat_request(SessionMode::New)
        };
        assert_eq!(
            args(&no_servers),
            words(
                "-p --output-format stream-json --verbose --include-partial-messages \
                 --model sonnet --effort medium --system-prompt You-are-Jet. \
                 --tools '' --setting-sources '' --disable-slash-commands --strict-mcp-config \
                 --no-chrome --permission-prompts none --autocompact 100k --max-budget-usd 10.00"
            )
        );

        for (effort, word) in [(Effort::XHigh, "xhigh"), (Effort::Max, "max")] {
            let mut request = chat_request(SessionMode::New);
            request.effort = effort;
            let mut expected = new_chat.clone();
            let at = expected.iter().position(|arg| arg == "--effort").unwrap();
            expected[at + 1] = word.to_owned();
            assert_eq!(args(&request), expected);
        }

        let resume = SessionMode::Resume(SessionId("abc-123".into()));
        let resumed = [new_chat, words("--resume abc-123")].concat();
        assert_eq!(args(&chat_request(resume)), resumed);

        let review = Request {
            prompt: "notes".into(),
            system_prompt: "Keep-notes.".into(),
            model: Model::Haiku,
            effort: Effort::Low,
            budget_usd: 0.2,
            session: SessionMode::Ephemeral,
            schema: Some(json!({"type": "object"})),
            mcp_config: None,
        };
        assert_eq!(
            args(&review),
            words(
                "-p --output-format stream-json --verbose --model haiku --effort low \
                 --system-prompt Keep-notes. --json-schema {\"type\":\"object\"} \
                 --tools '' --setting-sources '' --disable-slash-commands --strict-mcp-config \
                 --no-chrome --permission-prompts none --no-session-persistence \
                 --max-budget-usd 0.20"
            )
        );
        assert_eq!(CACHE_TTL_ENV, ("CLAUDE_CODE_PROMPT_CACHE_TTL", "1h"));
        assert_eq!(
            ISOLATION_ENV,
            [
                ("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1"),
                ("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1"),
            ]
        );
    }
}
