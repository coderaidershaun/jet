//! The files the app keeps in its data folder: the thread, the session record and the
//! three notes. Each file sits behind one small module so a database could replace it.

mod notes;
mod session;
mod transcript;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) use session::Session;
pub(crate) use transcript::{NewEntry, Transcript};

/// The folder that holds everything the app remembers.
#[derive(Debug, Clone)]
pub struct DataDir {
    root: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum MemoryError {
    #[error("could not read {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not write {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("{path} line {line} is not valid: {source}")]
    Json {
        path: PathBuf,
        line: usize,
        #[source]
        source: serde_json::Error,
    },
}

impl DataDir {
    pub fn new(root: impl Into<PathBuf>) -> DataDir {
        DataDir { root: root.into() }
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    /// The text of a file, or `None` when it does not exist yet.
    fn read(&self, name: &str) -> Result<Option<String>, MemoryError> {
        let path = self.path(name);
        match std::fs::read_to_string(&path) {
            Ok(text) => Ok(Some(text)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(source) => Err(MemoryError::Read { path, source }),
        }
    }

    /// Replaces a file in one step, so a crash leaves the old or the new text, never half.
    /// Each write gets its own temporary file, because the reply and the review can save
    /// the same file at the same moment.
    fn write(&self, name: &str, text: &str) -> Result<(), MemoryError> {
        static NEXT_WRITE: AtomicU64 = AtomicU64::new(0);
        let path = self.path(name);
        let write_number = NEXT_WRITE.fetch_add(1, Ordering::Relaxed);
        let temporary = self.path(&format!("{name}.{write_number}.tmp"));
        let write_failed = |source| MemoryError::Write {
            path: path.clone(),
            source,
        };
        std::fs::create_dir_all(&self.root).map_err(write_failed)?;
        std::fs::write(&temporary, text).map_err(write_failed)?;
        std::fs::rename(&temporary, &path).map_err(write_failed)
    }

    fn remove(&self, name: &str) -> Result<(), MemoryError> {
        let path = self.path(name);
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(MemoryError::Write { path, source }),
        }
    }

    /// An empty folder under the system temp folder, for tests.
    #[cfg(test)]
    pub(crate) fn scratch(name: &str) -> DataDir {
        let root = std::env::temp_dir().join(format!("agent-test-{}-{name}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        DataDir::new(root)
    }
}

/// The current time in Unix milliseconds.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}
