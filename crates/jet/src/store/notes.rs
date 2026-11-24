//! Each user's three notes, shared by all of that user's chats.

use super::{Store, StoreError, UserId};
use agent::Notes;
use rusqlite::{OptionalExtension, params};

impl Store {
    /// The user's notes; empty ones before anything was saved.
    pub(crate) fn notes(&self, user: UserId) -> Result<Notes, StoreError> {
        let saved = self.with(|db| {
            db.query_row(
                "SELECT memory, about_user, recent FROM notes WHERE user_id = ?1",
                [user.0],
                |row| {
                    Ok(Notes {
                        memory: row.get(0)?,
                        user: row.get(1)?,
                        recent: row.get(2)?,
                    })
                },
            )
            .optional()
        })?;
        Ok(saved.unwrap_or_default())
    }

    pub(crate) fn set_notes(&self, user: UserId, notes: &Notes) -> Result<(), StoreError> {
        self.with(|db| {
            db.execute(
                "INSERT INTO notes (user_id, memory, about_user, recent) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (user_id) DO UPDATE SET
                     memory = excluded.memory, about_user = excluded.about_user, recent = excluded.recent",
                params![user.0, notes.memory, notes.user, notes.recent],
            )
            .map(drop)
        })
    }
}
