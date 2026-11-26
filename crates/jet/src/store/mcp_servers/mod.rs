//! The MCP servers each user added, each with its sealed key or OAuth sign-in and what Jet found the
//! last time it connected. The store keeps only sealed bytes; it never sees a key or token in clear.

mod servers;
mod sign_in;

pub(crate) use servers::{McpProvider, McpServer, McpState, McpTool, NewMcpServer, SealedKey};
pub(crate) use sign_in::{SealedTokens, SignInSetup, SignInStart};
