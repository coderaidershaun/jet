//! Host Jet's browser interface while provider processes and conversation data stay on the server.

mod chat;
mod facade;
mod files;
mod server;
mod settings;

pub use chat::BridgeError;
pub use files::{READ_FILE_ARGUMENT, run_file_reader};
pub use server::{Server, ServerConfig, ServerError};
