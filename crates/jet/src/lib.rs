//! Host Jet's browser interface while provider processes and conversation data stay on the server.
//!
//! Priorities, in order: correctness of what Jet says (no nudge without fresh evidence, no wrong or duplicate wake-up), visibility (the user sees each objective and agent-task Jet set and when it runs), simplicity (the least new code), cost of idle wake-ups.
//! Never: nudge a user without a fresh read of every outside source of the objective.
//! Never: run one agent-task in two checks at once, or post two check-ins for one due time.
//! Never: show another user a private note, a chat, or an objective that is not shared with them.

mod account;
mod apps;
mod chat;
mod evidence;
mod facade;
mod files;
mod mcp_servers;
mod objectives;
mod scheduler;
mod seal;
mod server;
mod settings;
mod store;
mod voice;

pub use files::{READ_FILE_ARGUMENT, run_file_reader};
pub use server::{Server, ServerConfig, ServerError};

/// Adds the demo organisation's accounts that the database in `data_dir` lacks, and returns how
/// many it added.
pub fn seed(data_dir: &std::path::Path) -> Result<usize, ServerError> {
    let store = store::Store::open(data_dir).map_err(account::AccountError::from)?;
    Ok(account::seed(&store)?)
}

use std::sync::{Mutex, MutexGuard, PoisonError};

/// Locks even when another thread panicked while holding the lock, because the data it guards is
/// still the best state there is.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The thread that ran a call away from the server's own threads panicked or was cancelled.
#[derive(Debug, thiserror::Error)]
#[error(transparent)]
pub(crate) struct WorkerFailed(#[from] tokio::task::JoinError);

/// Runs a call that waits on the network or the disk away from the server's own threads.
pub(crate) async fn on_worker<T: Send + 'static>(
    call: impl FnOnce() -> T + Send + 'static,
) -> Result<T, WorkerFailed> {
    Ok(tokio::task::spawn_blocking(call).await?)
}
