//! Keep provider connection details separate from the tool calls saved in the transcript.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct McpConnection {
    pub url: String,
    pub token: String,
}

pub const FACADE_TOOLS: [&str; 6] = [
    "apps_list",
    "apps_update",
    "apps_open",
    "tools_search",
    "tools_describe",
    "tools_call",
];

impl McpConnection {
    pub fn config(&self) -> String {
        serde_json::json!({"mcpServers":{"jet":{"type":"http","url":self.url,"headers":{"x-jet-turn":self.token}}}}).to_string()
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
