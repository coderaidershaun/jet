//! The MCP servers a reply may use and the tool calls it makes: the registry the settings
//! hold, each server's status when a reply starts, and each call as the page and the
//! transcript keep it.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// The MCP servers Jet's Claude may use. Claude Code knows each by its field name, which
/// starts the name of every tool it serves: `mcp__quanty__search`.
// SMELL: a library whose program does not take `--http` is still started by Claude Code for
// each reply and closed when the reply ends, so an engine it started, or a quanty ingest,
// stops with the reply.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct McpServers {
    pub quanty: McpServer,
    pub polysim: McpServer,
}

/// One server: whether Claude may use it, and how to start it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct McpServer {
    pub enabled: bool,
    /// The server program.
    pub command: PathBuf,
    /// The folder the server runs in; `None` runs it in Claude's folder.
    pub cwd: Option<PathBuf>,
}

impl McpServers {
    /// Every server with its name, in name order (polysim, then quanty), enabled or not.
    pub(crate) fn named(&self) -> impl Iterator<Item = (&'static str, &McpServer)> {
        [("polysim", &self.polysim), ("quanty", &self.quanty)].into_iter()
    }

    /// The enabled servers with their names, in name order.
    pub fn enabled(&self) -> impl Iterator<Item = (&'static str, &McpServer)> {
        self.named().filter(|(_, server)| server.enabled)
    }
}

/// A server's state when the reply started, in Claude Code's words. Only `failed` means
/// offline; `pending` is still starting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct McpStatus {
    pub name: String,
    pub status: String,
}

/// One finished call of an MCP tool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub server: String,
    pub tool: String,
    pub input: serde_json::Value,
    pub ok: bool,
    /// The structured result, or the result's text as JSON when it parses, else the text.
    pub result: serde_json::Value,
    /// One line for people, such as `quanty · search · 5 results`.
    pub summary: String,
    pub duration_ms: u64,
}

/// The text blocks of a tool result's content joined with newlines. The content is a
/// string or a list of blocks, and only the text blocks count.
pub(crate) fn content_text(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(items) => items
            .iter()
            .filter(|item| item["type"] == "text")
            .filter_map(|item| item["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// A result's text as JSON when it is JSON, else as a string. This is the rule for
/// `ToolCall.result` when the tool sent no structured result.
pub(crate) fn content_value(content: &serde_json::Value) -> serde_json::Value {
    let text = content_text(content);
    serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text))
}
