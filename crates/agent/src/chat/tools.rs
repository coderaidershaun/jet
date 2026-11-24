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

/// The `server` of a card for the provider's own web search or page reading.
const WEB_SERVER: &str = "web";

impl McpConnection {
    pub fn config(&self) -> String {
        serde_json::json!({"mcpServers":{"jet":{"type":"http","url":self.url,"headers":{TURN_HEADER:self.token}}}}).to_string()
    }

    /// Where the provider asks before each page read, beside the tool server: `/web-hook`, with
    /// the hosts the turn may read in the `hosts` query, comma-separated.
    pub fn web_hook_url(&self, hosts: &[String]) -> Option<String> {
        let mut url = url::Url::parse(&self.url).ok()?.join("web-hook").ok()?;
        url.query_pairs_mut().append_pair("hosts", &hosts.join(","));
        Some(url.into())
    }
}

/// A tool call that has just begun: an MCP tool, or the provider's own web search or page read.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolStart {
    pub id: String,
    pub server: String,
    pub tool: String,
    pub input: serde_json::Value,
}

impl ToolStart {
    /// A web card: `tool` is `fetch` or `search`, and `input` is what the model wrote, with the
    /// address in `url` or the words in `query`.
    pub(crate) fn web(id: String, tool: &str, input: serde_json::Value) -> ToolStart {
        ToolStart {
            id,
            server: WEB_SERVER.to_owned(),
            tool: tool.to_owned(),
            input,
        }
    }
}

/// One finished tool call, as the thread keeps it.
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

impl ToolCall {
    /// True for a web search or page read, refused or not, since its result can hold a
    /// stranger's text.
    pub fn read_web(&self) -> bool {
        self.server == WEB_SERVER
    }
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
