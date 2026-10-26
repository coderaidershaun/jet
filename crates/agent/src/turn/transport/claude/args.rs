//! The exact command line, environment and MCP server config for a request. The flags and
//! their order stay fixed so that Claude's prompt cache keeps hitting.

use crate::chat::FACADE_TOOLS;
use crate::turn::transport::{Request, SessionMode};

/// Keeps Claude's prompt cache alive for an hour instead of five minutes.
pub(super) const CACHE_TTL_ENV: (&str, &str) = ("CLAUDE_CODE_PROMPT_CACHE_TTL", "1h");

/// Turns off CLAUDE.md files and Claude Code's own memory, as safe mode would; safe mode
/// itself drops the MCP servers. Jet keeps its own notes.
pub(super) const ISOLATION_ENV: [(&str, &str); 2] = [
    ("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1"),
    ("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1"),
];

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
    args.extend(
        [
            "--tools",
            "",
            "--setting-sources",
            "",
            "--disable-slash-commands",
            "--strict-mcp-config",
        ]
        .map(String::from),
    );
    if let Some(mcp) = &request.mcp {
        // Exact names prevent unrelated tools from becoming available to the provider.
        let allowed = FACADE_TOOLS
            .map(|name| format!("mcp__jet__{name}"))
            .join(",");
        args.extend([
            "--mcp-config".into(),
            mcp.config(),
            "--allowedTools".into(),
            allowed,
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
    use super::*;
    use crate::chat::{Effort, McpConnection, Model, SessionId};
    use serde_json::json;
    const JET_SERVER: &str = r#"{"mcpServers":{"jet":{"headers":{"x-jet-turn":"token"},"type":"http","url":"http://localhost/mcp"}}}"#;
    const ALLOWED: &str = "mcp__jet__apps_list,mcp__jet__apps_update,mcp__jet__apps_open,mcp__jet__tools_search,mcp__jet__tools_describe,mcp__jet__tools_call";

    fn chat_request(session: SessionMode) -> Request {
        Request {
            prompt: "hello".into(),
            system_prompt: "You-are-Jet.".into(),
            model: Model::Sonnet,
            effort: Effort::Medium,
            budget_usd: 10.0,
            session,
            schema: None,
            mcp: Some(McpConnection {
                url: "http://localhost/mcp".into(),
                token: "token".into(),
            }),
        }
    }

    /// Splits a command line on spaces; `''` stands for one empty argument.
    fn words(line: &str) -> Vec<String> {
        let unquoted = |word: &str| word.trim_matches('\'').to_owned();
        line.split(' ').map(unquoted).collect()
    }

    #[test]
    fn chat_and_review_args_are_exact_without_safe_mode_which_drops_mcp_servers() {
        let new_chat = [
            words(
                "-p --output-format stream-json --verbose --include-partial-messages \
                 --model sonnet --effort medium --system-prompt You-are-Jet. \
                 --tools '' --setting-sources '' --disable-slash-commands \
                 --strict-mcp-config --mcp-config",
            ),
            vec![JET_SERVER.to_owned()],
            words("--allowedTools"),
            vec![ALLOWED.to_owned()],
            words(
                "--no-chrome --permission-prompts none --autocompact 100k --max-budget-usd 10.00",
            ),
        ]
        .concat();
        assert_eq!(args(&chat_request(SessionMode::New)), new_chat);

        let no_servers = Request {
            mcp: None,
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
            mcp: None,
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
    }
}
