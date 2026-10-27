//! Host Jet's browser interface while provider processes and conversation data stay on the server.

mod chat;
mod facade;
mod files;
mod server;
mod settings;

pub use chat::BridgeError;
pub use server::{Server, ServerConfig, ServerError};
