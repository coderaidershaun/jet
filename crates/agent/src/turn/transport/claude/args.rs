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
