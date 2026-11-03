//! Host Jet's browser interface while provider processes and conversation data stay on the server.

mod apps;
mod chat;
mod facade;
mod files;
mod server;
mod settings;
mod voice;

pub use files::{READ_FILE_ARGUMENT, run_file_reader};
pub use server::{Server, ServerConfig, ServerError};

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
