//! The libraries' MCP servers as the app runs them: one shared copy of each for the whole
//! session, and the client that calls their tools.

mod client;
mod keeper;
mod process;
mod shared;

pub use shared::SharedServers;

/// Why a call to a library's shared server failed.
#[derive(Debug, thiserror::Error)]
pub enum McpError {
    /// Jet keeps no copy of this library running, so only Claude's own replies can reach it.
    #[error("Jet is not running {server} itself ({reason}), so the page cannot call it")]
    NotShared {
        server: String,
        reason: &'static str,
    },
    #[error("there is no library called {server}")]
    UnknownServer { server: String },
    #[error("the {server} server did not answer")]
    Unreachable {
        server: String,
        #[source]
        source: Box<ureq::Error>,
    },
    #[error("the {server} server answered with HTTP {status}")]
    Status { server: String, status: u16 },
    #[error("the {server} server sent a reply that is not JSON")]
    BadJson {
        server: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("the {server} server ended its reply without an answer to the request")]
    NoResponse { server: String },
    /// The server refused the request itself (an unknown tool, bad parameters).
    #[error("the {server} server refused the request: {message}")]
    Rpc {
        server: String,
        code: i64,
        message: String,
    },
    /// The tool ran and refused, in the server's own words.
    #[error("{0}")]
    Tool(String),
}
