//! The requests, results and errors that chat and browsing exchange with registered HTTP tool servers.
use super::{ServerMetadata, ToolDefinition, ToolTarget};
use crate::apps::AppId;
use rmcp::model::ProgressNotificationParam;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The longest progress message kept, in characters.
const MAX_MESSAGE_CHARS: usize = 300;

/// How far a running tool call says it has got. It comes from outside, so it is cleaned on the
/// way in.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Progress {
    pub progress: f64,
    pub total: Option<f64>,
    pub message: Option<String>,
}

impl Progress {
    /// Reads a progress notification. A notification whose progress is not a finite number is
    /// dropped, a total that is not finite is left out, and a long message is cut short.
    pub(super) fn from_notification(notification: ProgressNotificationParam) -> Option<Self> {
        notification.progress.is_finite().then(|| Self {
            progress: notification.progress,
            total: notification.total.filter(|total| total.is_finite()),
            message: notification
                .message
                .map(|message| message.chars().take(MAX_MESSAGE_CHARS).collect()),
        })
    }
}

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
