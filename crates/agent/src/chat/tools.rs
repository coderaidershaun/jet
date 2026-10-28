//! Keep provider connection details separate from the tool calls saved in the transcript.

use serde::{Deserialize, Serialize};

/// Where a provider reaches Jet's tools, and the token that ties its calls to one turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpConnection {
    pub url: String,
    pub token: String,
}

/// The request header that carries `McpConnection::token`.
pub const TURN_HEADER: &str = "x-jet-turn";

/// The request metadata key where Claude Code names the tool use a call belongs to. Its value is
/// the id of the call's card.
pub const TOOL_USE_META: &str = "claudecode/toolUseId";

pub const FACADE_TOOLS: [&str; 9] = [
    "apps_list",
    "apps_update",
    "apps_open",
    "tools_search",
    "tools_describe",
    "tools_call",
    "files_export",
    "files_list",
    "files_read",
];

impl McpConnection {
    pub fn config(&self) -> String {
        serde_json::json!({"mcpServers":{"jet":{"type":"http","url":self.url,"headers":{TURN_HEADER:self.token}}}}).to_string()
    }
}

/// An MCP tool call that has just begun.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolStart {
    pub id: String,
    pub server: String,
    pub tool: String,
    pub input: serde_json::Value,
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
