//! Where the conversation code meets the database: one chat's thread and session, and its user's
//! notes, each read and written for that chat and that user only.

use agent::{Entry, MemoryError, NewEntry, Notes, Session, Storage};

use crate::store::{Chat, Store, StoreError};

pub(super) struct ChatMemory {
    pub store: Store,
    pub chat: Chat,
}

fn failed(error: StoreError) -> MemoryError {
    MemoryError::Storage(Box::new(error))
}

impl Storage for ChatMemory {
    fn entries(&self) -> Result<Vec<Entry>, MemoryError> {
        self.store.entries(self.chat.id, None).map_err(failed)
    }

    fn last_entries(&self, limit: usize) -> Result<Vec<Entry>, MemoryError> {
        self.store
            .entries(self.chat.id, Some(limit))
            .map_err(failed)
    }

    fn add_entry(&self, entry: NewEntry, at: u64) -> Result<Entry, MemoryError> {
        self.store
            .add_entry(self.chat.id, entry, at)
            .map_err(failed)
    }

    fn replace_entry(&self, entry: &Entry) -> Result<(), MemoryError> {
        self.store
            .replace_entry(self.chat.id, entry)
            .map_err(failed)
    }

    fn forget_entries(&self, at: u64) -> Result<(), MemoryError> {
        self.store.forget_entries(self.chat.id, at).map_err(failed)
    }

    fn session(&self) -> Result<Option<Session>, MemoryError> {
        self.store.session(self.chat.id).map_err(failed)
    }

    fn save_session(&self, session: Option<&Session>) -> Result<(), MemoryError> {
        self.store
            .set_session(self.chat.id, session)
            .map_err(failed)
    }

    fn notes(&self) -> Result<Notes, MemoryError> {
        self.store.notes(self.chat.user).map_err(failed)
    }

    fn save_notes(&self, notes: &Notes) -> Result<(), MemoryError> {
        self.store.set_notes(self.chat.user, notes).map_err(failed)
    }

    fn page_hosts(&self) -> Result<Vec<String>, MemoryError> {
        self.store.page_hosts(self.chat.id).map_err(failed)
    }
}
