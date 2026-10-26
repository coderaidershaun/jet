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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::{Entry, EntryId, MEMORY_LIMIT, Mood, Notes, Role, USER_LIMIT};

    #[test]
    fn saved_files_survive_a_crash_and_older_versions() {
        // Notes are cut to their caps on a line boundary.
        assert_eq!(notes::trim_to_limit("a\nbb\nccc", 4), "a\nbb");
        assert_eq!(notes::trim_to_limit("ééééé\nnext", 3), "ééé");
        let dir = DataDir::scratch("notes-caps");
        let saved = Notes {
            memory: "- fact\n".repeat(MEMORY_LIMIT),
            user: "u".repeat(USER_LIMIT + 50),
            recent: String::new(),
        }
        .save(&dir)
        .unwrap();
        assert!(saved.memory.chars().count() <= MEMORY_LIMIT);
        assert!(saved.memory.ends_with("- fact"), "cut on a line boundary");
        assert_eq!(saved.user.chars().count(), USER_LIMIT);
        assert_eq!(Notes::load(&dir).unwrap(), saved);

        // Notes and a session record written by an older version still load.
        let old = DataDir::scratch("older-shape");
        old.write("MEMORY.md", &"- old fact\n".repeat(MEMORY_LIMIT))
            .unwrap();
        let notes = Notes::load(&old).unwrap();
        assert!(
            notes.memory.starts_with("- old fact") && notes.memory.chars().count() <= MEMORY_LIMIT
        );
        assert_eq!((notes.user.as_str(), notes.recent.as_str()), ("", ""));
        old.write(
            "session.json",
            r#"{"sessionId":"abc","startedAt":5,"lastRequestAt":7,"contextTokens":9}"#,
        )
        .unwrap();
        let session = Session::load(&old).unwrap().unwrap();
        assert_eq!(session.session_id.0, "abc");
        assert_eq!((session.last_request_at, session.context_tokens), (7, 9));

        // A half-written last line is skipped, then replaced by the next entry.
        let dir = DataDir::scratch("transcript-torn");
        let transcript = Transcript::open(&dir);
        transcript.append(NewEntry::user("one"), 10).unwrap();
        let reply = NewEntry {
            role: Role::Jet,
            mood: Some(Mood::Hello),
            ..NewEntry::user("two")
        };
        transcript.append(reply, 20).unwrap();
        let path = dir.path("transcript.jsonl");
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        std::io::Write::write_all(&mut file, br#"{"id":3,"role":"us"#).unwrap();

        let entries = transcript.entries().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].text, "two");
        for mood in Mood::ALL {
            let entry = Entry {
                mood: Some(mood),
                ..entries[1].clone()
            };
            let json = serde_json::to_string(&entry).unwrap();
            assert_eq!(
                serde_json::from_str::<Entry>(&json).unwrap().mood,
                Some(mood)
            );
        }
        for word in [
            "happy", "excited", "thinking", "curious", "sorry", "alert", "annoyed", "unknown",
        ] {
            let mut json = serde_json::to_value(&entries[1]).unwrap();
            json["mood"] = serde_json::json!(word);
            let entry = serde_json::from_value::<Entry>(json).unwrap();
            assert_eq!(entry.mood, Some(Mood::Neutral), "{word}");
        }
        let third = transcript.append(NewEntry::user("three"), 30).unwrap();
        assert_eq!(third.id, EntryId(3));
        assert_eq!(transcript.entries().unwrap().len(), 3);

        // A bad line anywhere else is an error, not a silent gap.
        let broken = std::fs::read_to_string(&path)
            .unwrap()
            .replacen("\"two\"", "tw0", 1);
        std::fs::write(&path, broken).unwrap();
        assert!(matches!(
            transcript.entries(),
            Err(MemoryError::Json { line: 2, .. })
        ));
    }
}
