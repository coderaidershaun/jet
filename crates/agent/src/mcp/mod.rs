//! The libraries' MCP servers as the app runs them: one shared copy of each for the whole
//! session.

mod keeper;
mod process;
mod shared;

pub use shared::SharedServers;
