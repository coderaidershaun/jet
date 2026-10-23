//! Share app tool contracts while retaining the existing desktop server lifecycle.

mod catalogue;
mod keeper;
mod process;
mod service;
mod shared;

pub use catalogue::{
    DiscoveryKind, DiscoveryMarker, DiscoveryNode, DiscoveryResult, ServerMetadata, ToolDefinition,
    ToolTarget,
};
pub use service::{McpError, McpFuture, McpService, ToolCatalogue, ToolRequest, ToolResult};
pub use shared::SharedServers;
