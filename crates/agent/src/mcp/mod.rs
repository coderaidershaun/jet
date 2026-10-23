//! Share registered HTTP app metadata and calls between chat and browsing.

mod catalogue;
mod service;

pub use catalogue::{
    DiscoveryKind, DiscoveryMarker, DiscoveryNode, DiscoveryResult, ServerMetadata, ToolDefinition,
    ToolTarget,
};
pub use service::{McpError, McpFuture, McpService, ToolCatalogue, ToolRequest, ToolResult};

mod dispatch;
mod http;
mod metadata;
pub use http::HttpMcpClient;
