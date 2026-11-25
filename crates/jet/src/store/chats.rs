//! Each user's chats: the main one made with the account and the others they open, the thread of
//! each chat, the record of its provider session and how far the user has read it.

use super::text_enum::text_enum;
use super::{Store, StoreError, UserId, from_json, seconds, to_json};
use agent::{Entry, NewEntry, Session};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::Serialize;

/// What the main chat is called, since it is made with the account and has no title of its own.
const MAIN_TITLE: &str = "Main chat";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub(crate) struct ChatId(pub(crate) i64);

text_enum!(ChatKind {
    Main = "main",
    Objective = "objective",
    Topic = "topic",
});

/// A Jet entry that the user has not read: it is newer than the chat's read mark.
const UNREAD: &str =
    "(SELECT count(*) FROM entries e WHERE e.chat_id = c.id AND e.forgotten_at IS NULL
        AND e.id > c.read_through AND json_extract(e.entry, '$.role') = 'jet')";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Chat {
    pub(crate) id: ChatId,
    pub(crate) user: UserId,
    pub(crate) kind: ChatKind,
    pub(crate) title: String,
}

/// One row of the list of a user's chats.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatSummary {
    pub(crate) id: ChatId,
    pub(crate) kind: ChatKind,
    pub(crate) title: String,
    pub(crate) unread: u64,
    /// Unix milliseconds of the newest entry, or of the chat's making while it has none.
    pub(crate) active_at: u64,
}

fn shown_title(kind: ChatKind, title: String) -> String {
    match (kind, title.is_empty()) {
        (ChatKind::Main, true) => MAIN_TITLE.to_owned(),
        _ => title,
    }
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
                        title: shown_title(ChatKind::Main, row.get(1)?),
                    })
                },
            )
        })
    }

    /// Adds a chat with an empty thread for the user and gives its id.
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
    pub(crate) fn chat(&self, user: UserId, chat: ChatId) -> Result<Option<Chat>, StoreError> {
        self.with(|db| {
            db.query_row(
                "SELECT kind, title FROM chats WHERE id = ?1 AND user_id = ?2",
                params![chat.0, user.0],
                |row| {
                    let kind = row.get(0)?;
                    Ok(Chat {
                        id: chat,
                        user,
                        kind,
                        title: shown_title(kind, row.get(1)?),
                    })
                },
            )
            .optional()
        })
    }

    /// The user's chats, the main one first and then the others by their latest entry, newest
    /// first, each with its count of unread Jet entries.
    pub(crate) fn chats_of(&self, user: UserId) -> Result<Vec<ChatSummary>, StoreError> {
        let mut chats = self.with(|db| {
            let mut query = db.prepare(&format!(
                "SELECT c.id, c.kind, c.title,
                    max(c.created_at * 1000, coalesce((SELECT max(json_extract(e.entry, '$.at'))
                        FROM entries e WHERE e.chat_id = c.id AND e.forgotten_at IS NULL), 0)),
                    {UNREAD}
                 FROM chats c WHERE c.user_id = ?1"
            ))?;
            query
                .query_map([user.0], |row| {
                    let kind = row.get(1)?;
                    Ok(ChatSummary {
                        id: ChatId(row.get(0)?),
                        kind,
                        title: shown_title(kind, row.get(2)?),
                        active_at: row.get::<_, i64>(3)?.unsigned_abs(),
                        unread: row.get::<_, i64>(4)?.unsigned_abs(),
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
        })?;
        chats.sort_by_key(|chat| {
            (
                chat.kind != ChatKind::Main,
                std::cmp::Reverse(chat.active_at),
            )
        });
        Ok(chats)
    }

    pub(crate) fn rename_chat(
        &self,
        user: UserId,
        chat: ChatId,
        title: &str,
    ) -> Result<(), StoreError> {
        let renamed = self.with(|db| {
            db.execute(
                "UPDATE chats SET title = ?3 WHERE id = ?1 AND user_id = ?2",
                params![chat.0, user.0, title],
            )
        })?;
        (renamed == 1).then_some(()).ok_or(StoreError::NoSuchChat)
    }

    /// Deletes the chat with its thread. Its objectives that are still open are dropped and their
    /// waiting checks cancelled, as of `at`. The objectives, agent-tasks and share cards then move
    /// to the user's main chat in the same transaction, so their history stays.
    pub(crate) fn delete_chat(
        &self,
        user: UserId,
        chat: ChatId,
        at: u64,
    ) -> Result<(), StoreError> {
        self.try_with(|db| {
            let transaction = db.transaction()?;
            let kind: Option<ChatKind> = transaction
                .query_row(
                    "SELECT kind FROM chats WHERE id = ?1 AND user_id = ?2",
                    params![chat.0, user.0],
                    |row| row.get(0),
                )
                .optional()?;
            match kind {
                None => return Err(StoreError::NoSuchChat),
                Some(ChatKind::Main) => return Err(StoreError::MainChat),
                Some(_) => {}
            }
            let main: i64 = transaction.query_row(
                "SELECT id FROM chats WHERE user_id = ?1 AND kind = 'main'",
                [user.0],
                |row| row.get(0),
            )?;
            transaction.execute(
                "UPDATE agent_tasks SET state = 'cancelled', version = version + 1, updated_at = ?2
                 WHERE state = 'scheduled' AND objective_id IN
                   (SELECT id FROM objectives WHERE chat_id = ?1 AND status IN ('active', 'paused'))",
                params![chat.0, super::seconds(at)],
            )?;
            transaction.execute(
                "UPDATE objectives SET status = 'dropped', closed_at = ?2, version = version + 1, updated_at = ?2
                 WHERE chat_id = ?1 AND status IN ('active', 'paused')",
                params![chat.0, super::seconds(at)],
            )?;
            for table in ["objectives", "agent_tasks", "share_proposals"] {
                transaction.execute(
                    &format!("UPDATE {table} SET chat_id = ?2 WHERE chat_id = ?1"),
                    params![chat.0, main],
                )?;
            }
            super::files::rehome_files(&transaction, chat)?;
            transaction.execute("DELETE FROM chats WHERE id = ?1", [chat.0])?;
            transaction.commit()?;
            Ok(())
        })
    }

    /// How many Jet entries of the chat come after the last one the user has read.
    pub(crate) fn unread(&self, chat: ChatId) -> Result<u64, StoreError> {
        self.with(|db| {
            db.query_row(
                &format!("SELECT {UNREAD} FROM chats c WHERE c.id = ?1"),
                [chat.0],
                |row| row.get::<_, i64>(0).map(i64::unsigned_abs),
            )
        })
    }

    /// Moves the chat's read mark to entry `through`, or to the newest entry when it is `None`.
    /// The mark never moves back and never passes the newest entry. Gives the unread count that
    /// is left.
    pub(crate) fn mark_read(
        &self,
        user: UserId,
        chat: ChatId,
        through: Option<u64>,
    ) -> Result<u64, StoreError> {
        let through = through.map_or(i64::MAX, |id| i64::try_from(id).unwrap_or(i64::MAX));
        let moved = self.with(|db| {
            db.execute(
                "UPDATE chats SET read_through = max(read_through, min(?3,
                    coalesce((SELECT max(id) FROM entries WHERE chat_id = chats.id), 0)))
                 WHERE id = ?1 AND user_id = ?2",
                params![chat.0, user.0, through],
            )
        })?;
        match moved {
            1 => self.unread(chat),
            _ => Err(StoreError::NoSuchChat),
        }
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

    /// The emoji the user put on one entry of the chat, if any.
    pub(crate) fn user_reaction(
        &self,
        chat: ChatId,
        entry: u64,
    ) -> Result<Option<String>, StoreError> {
        self.with(|db| {
            db.query_row(
                "SELECT json_extract(r.value, '$.emoji') FROM entries e, json_each(e.entry, '$.reactions') r
                 WHERE e.chat_id = ?1 AND e.id = ?2 AND e.forgotten_at IS NULL
                   AND json_extract(r.value, '$.by') = 'user'",
                params![chat.0, seconds(entry)],
                |row| row.get(0),
            )
            .optional()
        })
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
