//! Recover accepted requests without repeating uncertain provider work.

use super::memory::{MemoryError, NewEntry, Transcript, now_ms};
use super::{Conversation, shown};
use crate::chat::{EntryStatus, Role, ShownEntry};

impl Conversation {
    /// Finds an accepted request even when its reply has already finished.
    pub fn accepted_request(&self, request_id: &str) -> Result<Option<ShownEntry>, MemoryError> {
        Ok(Transcript::open(&self.dir)
            .entries()?
            .into_iter()
            .find(|entry| {
                entry.role == Role::User
                    && entry
                        .turn
                        .as_ref()
                        .is_some_and(|turn| turn.request_id == request_id)
            })
            .map(shown))
    }

    /// Marks orphaned requests interrupted at server startup, without calling a provider.
    pub fn recover_interrupted(&self) -> Result<(), MemoryError> {
        let transcript = Transcript::open(&self.dir);
        let entries = transcript.entries()?;
        for user in entries.iter().filter(|entry| entry.role == Role::User) {
            let Some(identity) = &user.turn else { continue };
            if entries.iter().any(|entry| {
                entry.role == Role::Jet
                    && entry
                        .turn
                        .as_ref()
                        .is_some_and(|turn| turn.turn_id == identity.turn_id)
            }) {
                continue;
            }
            transcript.append(
                NewEntry {
                    turn: Some(identity.clone()),
                    role: Role::Jet,
                    status: EntryStatus::Stopped,
                    error: Some(
                        "The server stopped before this reply completed. It was not run again."
                            .into(),
                    ),
                    ..NewEntry::user("")
                },
                now_ms(),
            )?;
        }
        Ok(())
    }
}
