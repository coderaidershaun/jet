//! The MCP servers a reply may use and the tool calls it makes: the registry the settings
//! hold, each server's status when a reply starts, and each call as the page and the
//! transcript keep it.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// The MCP servers Jet's Claude may use. Claude Code knows each by its field name, which
/// starts the name of every tool it serves: `mcp__quanty__search`.
// SMELL: Claude Code starts these servers for each reply and closes them when the reply
// ends, so an engine polysim started, or a quanty ingest, stops with the reply.
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
    /// The enabled servers with their names, in name order (polysim, then quanty).
    pub fn enabled(&self) -> impl Iterator<Item = (&'static str, &McpServer)> {
        [("polysim", &self.polysim), ("quanty", &self.quanty)]
            .into_iter()
            .filter(|(_, server)| server.enabled)
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
