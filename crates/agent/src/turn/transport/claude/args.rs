//! The exact command line, environment and MCP server config for a request. The flags and
//! their order stay fixed so that Claude's prompt cache keeps hitting.

use serde_json::json;

use crate::chat::{FACADE_TOOLS, McpConnection, TURN_HEADER};
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
    let hook = request
        .mcp
        .as_ref()
        .and_then(|mcp| web_hook(mcp, &request.hosts));
    let tools = match (&request.mcp, &hook) {
        (None, _) => "",
        (Some(_), None) => "WebSearch",
        (Some(_), Some(_)) => "WebSearch,WebFetch",
    };
    args.extend(["--tools", tools, "--setting-sources", ""].map(String::from));
    if let Some(hook) = hook {
        args.extend(["--settings".into(), hook]);
    }
    args.extend(["--disable-slash-commands", "--strict-mcp-config"].map(String::from));
    if let Some(mcp) = &request.mcp {
        // Exact names prevent unrelated tools from becoming available to the provider. The
        // page-read rules are a second gate behind the hook.
        let mut allowed: Vec<String> = FACADE_TOOLS.map(|name| format!("mcp__jet__{name}")).into();
        allowed.push("WebSearch".into());
        allowed.extend(
            request
                .hosts
                .iter()
                .map(|host| format!("WebFetch(domain:{host})")),
        );
        args.extend([
            "--mcp-config".into(),
            mcp.config(),
            "--allowedTools".into(),
            allowed.join(","),
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

/// The settings that make Claude Code ask Jet before each page read. An allow rule alone lets
/// Claude Code's own list of documentation sites through, so the hook refuses every host the turn
/// did not name, and `onFailure: block` turns any failure to reach Jet into a refusal.
fn web_hook(mcp: &McpConnection, hosts: &[String]) -> Option<String> {
    let url = mcp.web_hook_url(hosts)?;
    let hook = json!({"type": "http", "url": url, "headers": {TURN_HEADER: mcp.token},
        "timeout": 10, "onFailure": "block"});
    let settings = json!({"hooks": {"PreToolUse": [{"matcher": "WebFetch", "hooks": [hook]}]}});
    Some(settings.to_string())
}
