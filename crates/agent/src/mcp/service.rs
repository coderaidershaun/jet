//! Give chat and browsing one cancellable interface to registered HTTP tool servers.
use super::{ServerMetadata, ToolDefinition, ToolTarget};
use crate::apps::AppId;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{future::Future, pin::Pin};

pub type McpFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, McpError>> + Send + 'a>>;

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
    #[error("MCP request failed: {message}")]
    Transport { message: String },
    #[error("MCP request {request_id} was cancelled")]
    Cancelled { request_id: String },
}

/// Implementations recheck registry enablement at dispatch and never replay uncertain calls.
pub trait McpService: Send + Sync {
    fn catalogue<'a>(&'a self, app_id: &'a AppId) -> McpFuture<'a, ToolCatalogue>;
    fn refresh<'a>(&'a self, app_id: &'a AppId) -> McpFuture<'a, ToolCatalogue>;
    fn call(&self, request: ToolRequest) -> McpFuture<'_, ToolResult>;
    fn cancel<'a>(&'a self, request_id: &'a str) -> McpFuture<'a, ()>;
}
