//! A chat kept only in this process, for tests and for a conversation that must not be saved.

use std::sync::Mutex;

use super::{MemoryError, NewEntry, Session, Storage};
use crate::chat::{Entry, Notes};

#[derive(Default)]
pub struct InMemory {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    entries: Vec<Entry>,
    last_id: u64,
    session: Option<Session>,
    notes: Notes,
    objective_summary: Option<String>,
}

impl InMemory {
    /// Makes this chat the chat of an objective whose summary is `summary`.
    pub fn set_objective_summary(&self, summary: &str) {
        self.state().objective_summary = Some(summary.to_owned());
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        crate::lock(&self.state)
    }
}

impl Storage for InMemory {
    fn entries(&self) -> Result<Vec<Entry>, MemoryError> {
        Ok(self.state().entries.clone())
    }

    fn last_entries(&self, limit: usize) -> Result<Vec<Entry>, MemoryError> {
        let entries = &self.state().entries;
        Ok(entries[entries.len().saturating_sub(limit)..].to_vec())
    }

    fn add_entry(&self, entry: NewEntry, at: u64) -> Result<Entry, MemoryError> {
        let mut state = self.state();
        state.last_id += 1;
        let entry = entry.into_entry(state.last_id, at);
        state.entries.push(entry.clone());
        Ok(entry)
    }

    fn replace_entry(&self, entry: &Entry) -> Result<(), MemoryError> {
        if let Some(saved) = self.state().entries.iter_mut().find(|e| e.id == entry.id) {
            *saved = entry.clone();
        }
        Ok(())
    }

    fn forget_entries(&self, _at: u64) -> Result<(), MemoryError> {
        self.state().entries.clear();
        Ok(())
    }

    fn session(&self) -> Result<Option<Session>, MemoryError> {
        Ok(self.state().session.clone())
    }

    fn save_session(&self, session: Option<&Session>) -> Result<(), MemoryError> {
        self.state().session = session.cloned();
        Ok(())
    }

    fn notes(&self) -> Result<Notes, MemoryError> {
        Ok(self.state().notes.clone())
    }

    fn save_notes(&self, notes: &Notes) -> Result<(), MemoryError> {
        self.state().notes = notes.clone();
        Ok(())
    }

    fn objective_summary(&self) -> Result<Option<String>, MemoryError> {
        Ok(self.state().objective_summary.clone())
    }
}
