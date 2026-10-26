//! The requests, results and errors that chat and browsing exchange with registered HTTP tool servers.
use super::{ServerMetadata, ToolDefinition, ToolTarget};
use crate::apps::AppId;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCatalogue {
    pub server: ServerMetadata,
    pub tools: Vec<ToolDefinition>,
    pub is_stale: bool,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRequest {
    pub request_id: String,
    pub target: ToolTarget,
    pub arguments: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub request_id: String,
    pub content: Vec<Value>,
    pub structured_content: Option<Value>,
    pub is_error: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum McpError {
    #[error("app {app_id} is disabled or removed")]
    Unavailable { app_id: AppId },
    #[error("tool {tool} is not listed by app {app_id}")]
    UnknownTool { app_id: AppId, tool: String },
    #[error("invalid tool arguments: {message}")]
    InvalidArguments { message: String },
    #[error("MCP protocol error {code}: {message}")]
    Protocol {
        code: i32,
        message: String,
        data: Option<Value>,
    },
    #[error("MCP request failed: {message}")]
    Transport { message: String },
    #[error("MCP request {request_id} was cancelled")]
    Cancelled { request_id: String },
}
