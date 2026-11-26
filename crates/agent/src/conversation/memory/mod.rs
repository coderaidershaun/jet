//! What one chat keeps between messages: its thread, its provider session and its user's three
//! notes. The host decides where they are saved by implementing [`Storage`], one value for each
//! chat, so this crate never knows about users, files or databases.

mod entry;
mod in_memory;
mod notes;
mod session;

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub use entry::NewEntry;
pub use in_memory::InMemory;
pub use session::Session;

use crate::chat::{Entry, EntryId, Notes, Role};

/// Where one chat's thread and session, and the notes of the user it belongs to, are saved. Each
/// call acts only for that chat and that user.
pub trait Storage: Send + Sync {
    /// Every entry of the thread, oldest first. Entries of a forgotten thread are not in it.
    fn entries(&self) -> Result<Vec<Entry>, MemoryError>;
    /// The newest `limit` entries of the thread, oldest first.
    fn last_entries(&self, limit: usize) -> Result<Vec<Entry>, MemoryError>;
    /// Saves the entry under the next id of this chat, one more than any id it ever gave, and
    /// gives it back.
    fn add_entry(&self, entry: NewEntry, at: u64) -> Result<Entry, MemoryError>;
    /// Replaces the saved entry that has the same id.
    fn replace_entry(&self, entry: &Entry) -> Result<(), MemoryError>;
    /// Starts the thread over: every entry so far leaves it.
    fn forget_entries(&self, at: u64) -> Result<(), MemoryError>;
    fn session(&self) -> Result<Option<Session>, MemoryError>;
    /// Saves the session record, or removes it with `None`.
    fn save_session(&self, session: Option<&Session>) -> Result<(), MemoryError>;
    /// The notes as saved; never-written notes are empty.
    fn notes(&self) -> Result<Notes, MemoryError>;
    fn save_notes(&self, notes: &Notes) -> Result<(), MemoryError>;
    /// The hosts of the pages that this chat's objectives name, which a turn may read besides
    /// the sites the user linked. A chat with no objective has none.
    fn page_hosts(&self) -> Result<Vec<String>, MemoryError> {
        Ok(Vec::new())
    }
    /// What the open objectives of this chat are, when the chat was made for them: the text that
    /// tells Jet at the start of a provider session what the chat is for.
    fn objective_summary(&self) -> Result<Option<String>, MemoryError> {
        Ok(None)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum MemoryError {
    #[error("the saved chat could not be read or written: {0}")]
    Storage(#[source] Box<dyn std::error::Error + Send + Sync>),
}

/// The chat's storage, shared by the conversation and the replies it starts.
#[derive(Clone)]
pub(crate) struct Saved {
    storage: Arc<dyn Storage>,
    /// Held while a reaction is read and written back, so the user and Jet reacting at the same
    /// moment cannot undo each other's change.
    reacting: Arc<Mutex<()>>,
    /// Held while the session is read and written back, so the review and a reply saving their own
    /// parts of it cannot undo each other.
    session_writing: Arc<Mutex<()>>,
}

impl Saved {
    pub(crate) fn new(storage: Arc<dyn Storage>) -> Saved {
        Saved {
            storage,
            reacting: Arc::new(Mutex::new(())),
            session_writing: Arc::new(Mutex::new(())),
        }
    }

    pub(crate) fn entries(&self) -> Result<Vec<Entry>, MemoryError> {
        self.storage.entries()
    }

    pub(crate) fn last(&self, limit: usize) -> Result<Vec<Entry>, MemoryError> {
        self.storage.last_entries(limit)
    }

    /// Entries newer than `id`, oldest first.
    pub(crate) fn after(&self, id: EntryId) -> Result<Vec<Entry>, MemoryError> {
        let mut entries = self.entries()?;
        entries.retain(|entry| entry.id > id);
        Ok(entries)
    }

    pub(crate) fn append(&self, entry: NewEntry, at: u64) -> Result<Entry, MemoryError> {
        self.storage.add_entry(entry, at)
    }

    /// Puts one side's emoji on the other side's entry, or takes it off with `None`, and gives the
    /// entry back with `true` when it changed. `None` when no entry of the other side has that id.
    pub(crate) fn react(
        &self,
        id: EntryId,
        by: Role,
        emoji: Option<&str>,
        at: u64,
    ) -> Result<Option<(Entry, bool)>, MemoryError> {
        let _reacting = crate::lock(&self.reacting);
        let Some(mut entry) = self.entries()?.into_iter().find(|entry| entry.id == id) else {
            return Ok(None);
        };
        if entry.role == by {
            return Ok(None);
        }
        if entry.reaction_by(by) == emoji {
            return Ok(Some((entry, false)));
        }
        entry.set_reaction(by, emoji, at);
        self.storage.replace_entry(&entry)?;
        Ok(Some((entry, true)))
    }

    pub(crate) fn forget(&self, at: u64) -> Result<(), MemoryError> {
        let _held = self.hold_session();
        self.storage.forget_entries(at)?;
        self.storage.save_session(None)
    }

    pub(crate) fn session(&self) -> Result<Option<Session>, MemoryError> {
        self.storage.session()
    }

    pub(crate) fn save_session(&self, session: &Session) -> Result<(), MemoryError> {
        self.storage.save_session(Some(session))
    }

    /// Holds off every `update_session` while a caller reads the session and writes it back itself.
    pub(crate) fn hold_session(&self) -> std::sync::MutexGuard<'_, ()> {
        crate::lock(&self.session_writing)
    }

    /// Changes the saved session with `change`, which sees the newest one. Does nothing when the
    /// chat has no session.
    pub(crate) fn update_session(
        &self,
        change: impl FnOnce(&mut Session),
    ) -> Result<(), MemoryError> {
        let _held = self.hold_session();
        let Some(mut session) = self.storage.session()? else {
            return Ok(());
        };
        change(&mut session);
        self.storage.save_session(Some(&session))
    }

    pub(crate) fn objective_summary(&self) -> Result<Option<String>, MemoryError> {
        self.storage.objective_summary()
    }

    pub(crate) fn page_hosts(&self) -> Result<Vec<String>, MemoryError> {
        self.storage.page_hosts()
    }

    /// The notes, cut to their limits.
    pub(crate) fn notes(&self) -> Result<Notes, MemoryError> {
        Ok(self.storage.notes()?.trimmed())
    }

    /// Saves the notes after cutting them to their limits, and returns what was saved.
    pub(crate) fn save_notes(&self, notes: &Notes) -> Result<Notes, MemoryError> {
        let notes = notes.trimmed();
        self.storage.save_notes(&notes)?;
        Ok(notes)
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
    use crate::chat::{MEMORY_LIMIT, Mood, USER_LIMIT};

    #[test]
    fn notes_are_cut_on_a_line_boundary_and_ids_keep_counting_after_forget() {
        assert_eq!(notes::trim_to_limit("a\nbb\nccc", 4), "a\nbb");
        assert_eq!(notes::trim_to_limit("ééééé\nnext", 3), "ééé");
        let saved = Saved::new(Arc::new(InMemory::default()));
        let kept = saved
            .save_notes(&Notes {
                memory: "- fact\n".repeat(MEMORY_LIMIT),
                user: "u".repeat(USER_LIMIT + 50),
                recent: String::new(),
            })
            .unwrap();
        assert!(kept.memory.chars().count() <= MEMORY_LIMIT);
        assert!(kept.memory.ends_with("- fact"), "cut on a line boundary");
        assert_eq!(kept.user.chars().count(), USER_LIMIT);
        assert_eq!(saved.notes().unwrap(), kept);

        saved.append(NewEntry::user_text("one"), 10).unwrap();
        let reply = NewEntry {
            role: Role::Jet,
            mood: Some(Mood::Hello),
            ..NewEntry::user_text("two")
        };
        saved.append(reply, 20).unwrap();
        saved.forget(30).unwrap();
        assert!(saved.entries().unwrap().is_empty());
        let third = saved.append(NewEntry::user_text("three"), 40).unwrap();
        assert_eq!(third.id, EntryId(3));
    }
}
