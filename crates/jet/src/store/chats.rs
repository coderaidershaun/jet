//! Each user's chats: the main one made with the account, the thread of each chat and the record of
//! its provider session.

use super::text_enum::text_enum;
use super::{Store, StoreError, UserId, from_json, to_json};
use agent::{Entry, NewEntry, Session};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub(crate) struct ChatId(pub(crate) i64);

text_enum!(ChatKind {
    Main = "main",
    Objective = "objective",
    Topic = "topic",
});

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Chat {
    pub(crate) id: ChatId,
    pub(crate) user: UserId,
    pub(crate) kind: ChatKind,
    pub(crate) title: String,
}

impl Store {
    /// The user's main chat. Every account has one from the moment it is made.
    pub(crate) fn main_chat(&self, user: UserId) -> Result<Chat, StoreError> {
        self.with(|db| {
            db.query_row(
                "SELECT id, title FROM chats WHERE user_id = ?1 AND kind = 'main'",
                [user.0],
                |row| {
                    Ok(Chat {
                        id: ChatId(row.get(0)?),
                        user,
                        kind: ChatKind::Main,
                        title: row.get(1)?,
                    })
                },
            )
        })
    }

    /// Adds a chat with an empty thread for the user and gives its id.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the step that gives each user many chats calls it"
        )
    )]
    pub(crate) fn add_chat(&self, user: UserId, title: &str) -> Result<ChatId, StoreError> {
        self.with(|db| {
            db.execute(
                "INSERT INTO chats (user_id, kind, title, created_at) VALUES (?1, 'topic', ?2, unixepoch())",
                params![user.0, title],
            )?;
            Ok(ChatId(db.last_insert_rowid()))
        })
    }

    /// The chat when it belongs to `user`; another user's chat is `None`, as a missing one is.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the step that gives each user many chats calls it"
        )
    )]
    pub(crate) fn chat(&self, user: UserId, chat: ChatId) -> Result<Option<Chat>, StoreError> {
        self.with(|db| {
            db.query_row(
                "SELECT kind, title FROM chats WHERE id = ?1 AND user_id = ?2",
                params![chat.0, user.0],
                |row| {
                    Ok(Chat {
                        id: chat,
                        user,
                        kind: row.get(0)?,
                        title: row.get(1)?,
                    })
                },
            )
            .optional()
        })
    }

    /// The thread of the chat, oldest first: all of it, or the newest `limit` entries.
    pub(crate) fn entries(
        &self,
        chat: ChatId,
        limit: Option<usize>,
    ) -> Result<Vec<Entry>, StoreError> {
        let limit = limit.map_or(-1, |limit| i64::try_from(limit).unwrap_or(i64::MAX));
        let texts = self.with(|db| {
            let mut query = db.prepare(
                "SELECT entry FROM (
                     SELECT id, entry FROM entries WHERE chat_id = ?1 AND forgotten_at IS NULL
                     ORDER BY id DESC LIMIT ?2
                 ) ORDER BY id",
            )?;
            let rows = query.query_map(params![chat.0, limit], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<String>>>()
        })?;
        texts
            .iter()
            .map(|text| from_json("an entry", text))
            .collect()
    }

    /// Saves the entry under the next id of the chat: one more than any id it ever had, forgotten
    /// entries included.
    pub(crate) fn add_entry(
        &self,
        chat: ChatId,
        entry: NewEntry,
        at: u64,
    ) -> Result<Entry, StoreError> {
        self.try_with(|db| {
            let transaction = db.transaction()?;
            let entry = insert_entry(&transaction, chat, entry, at)?;
            transaction.commit()?;
            Ok(entry)
        })
    }

    pub(crate) fn replace_entry(&self, chat: ChatId, entry: &Entry) -> Result<(), StoreError> {
        let text = to_json(entry)?;
        let id = i64::try_from(entry.id.number()).unwrap_or(i64::MAX);
        self.with(|db| {
            db.execute(
                "UPDATE entries SET entry = ?3 WHERE chat_id = ?1 AND id = ?2",
                params![chat.0, id, text],
            )
            .map(drop)
        })
    }

    /// Takes every entry out of the chat's thread. The rows stay, marked with the time.
    pub(crate) fn forget_entries(&self, chat: ChatId, at: u64) -> Result<(), StoreError> {
        let at = i64::try_from(at).unwrap_or(i64::MAX);
        self.with(|db| {
            db.execute(
                "UPDATE entries SET forgotten_at = ?2 WHERE chat_id = ?1 AND forgotten_at IS NULL",
                params![chat.0, at],
            )
            .map(drop)
        })
    }

    pub(crate) fn session(&self, chat: ChatId) -> Result<Option<Session>, StoreError> {
        let text: Option<String> = self.with(|db| {
            db.query_row("SELECT session FROM chats WHERE id = ?1", [chat.0], |row| {
                row.get(0)
            })
        })?;
        text.map(|text| from_json("a session record", &text))
            .transpose()
    }

    pub(crate) fn set_session(
        &self,
        chat: ChatId,
        session: Option<&Session>,
    ) -> Result<(), StoreError> {
        let text = session.map(to_json).transpose()?;
        self.with(|db| {
            db.execute(
                "UPDATE chats SET session = ?2 WHERE id = ?1",
                params![chat.0, text],
            )
            .map(drop)
        })
    }
}

/// Saves the entry under the next id of the chat inside a transaction that the caller commits.
pub(super) fn insert_entry(
    transaction: &Transaction,
    chat: ChatId,
    entry: NewEntry,
    at: u64,
) -> Result<Entry, StoreError> {
    let last: i64 = transaction.query_row(
        "SELECT coalesce(max(id), 0) FROM entries WHERE chat_id = ?1",
        [chat.0],
        |row| row.get(0),
    )?;
    let entry = entry.into_entry(last.unsigned_abs() + 1, at);
    transaction.execute(
        "INSERT INTO entries (chat_id, id, entry) VALUES (?1, ?2, ?3)",
        params![chat.0, last + 1, to_json(&entry)?],
    )?;
    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Email, NewUser};

    fn user(store: &Store, email: &str) -> UserId {
        store
            .add_user(&NewUser {
                email: &Email::from(email),
                display_name: email,
                password_hash: "not a real hash",
                is_admin: false,
            })
            .unwrap()
    }

    #[test]
    fn a_user_reads_only_their_own_chats_and_each_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let (ada, bob) = (
            user(&store, "ada@example.com"),
            user(&store, "bob@example.com"),
        );
        let main = store.main_chat(ada).unwrap();
        assert_eq!(main.kind, ChatKind::Main);
        assert!(store.entries(main.id, None).unwrap().is_empty());

        let topic = store.add_chat(ada, "Kites").unwrap();
        let read = store.chat(ada, topic).unwrap().unwrap();
        assert_eq!((read.title.as_str(), read.kind), ("Kites", ChatKind::Topic));
        assert_eq!(store.chat(bob, topic).unwrap(), None);
        assert_eq!(store.chat(bob, main.id).unwrap(), None);
        assert_ne!(store.main_chat(bob).unwrap().id, main.id);

        let first = store
            .add_entry(topic, NewEntry::user_text("one"), 1)
            .unwrap();
        store.forget_entries(topic, 2).unwrap();
        let second = store
            .add_entry(topic, NewEntry::user_text("two"), 3)
            .unwrap();
        assert_eq!((first.id.number(), second.id.number()), (1, 2));
        assert_eq!(store.entries(topic, None).unwrap(), [second]);
        assert!(store.entries(main.id, None).unwrap().is_empty());
    }
}
