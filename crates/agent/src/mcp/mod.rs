//! Share registered HTTP app metadata and calls between chat and browsing.

mod catalogue;
mod dispatch;
mod http;
mod metadata;
mod service;

pub use catalogue::{ServerMetadata, ToolDefinition, ToolTarget};
pub use http::HttpMcpClient;
pub use service::{McpError, Progress, ToolCatalogue, ToolRequest, ToolResult};
