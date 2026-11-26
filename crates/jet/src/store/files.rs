//! The files of each user, whole: their details and their bytes, the chats that hold them and the
//! earlier versions kept of them.

use super::{ChatId, Store, StoreError, UserId, from_json, to_json};
use crate::files::{About, Origin};
use rusqlite::{Connection, OptionalExtension, params};

/// How many earlier versions of a file are kept.
const VERSIONS_KEPT: i64 = 5;
/// How long an upload that was never sent is kept, in milliseconds.
const UNSENT_MS: i64 = 24 * 60 * 60 * 1000;

/// What `add_file` did.
pub(crate) enum Added {
    Kept,
    /// Keeping the file would take every user's files together past the store's limit.
    Full,
    /// Keeping the file would take this user's files and their kept versions past the user's limit.
    UserFull,
    /// The chat was forgotten after the file was begun, so no thread would link to it.
    Forgotten,
}

/// What `change_file` did.
pub(crate) enum Changed {
    Done,
    /// The new contents would take the user's files past the user's limit.
    Full,
    /// The new contents would take every user's files together past the store's limit.
    StoreFull,
    Missing,
}

/// A file that Jet can see, with the chats that hold it (the keeper first) and the numbers of the
/// earlier versions kept, newest first.
pub(crate) struct Held {
    pub about: About,
    pub chats: Vec<ChatId>,
    pub earlier: Vec<u32>,
}

/// The files of one user that a chat holds: the ones it keeps and the ones shared into it.
const HELD_BY_CHAT: &str = "user_id = ?1 AND attached = 1 AND (chat_id = ?2
    OR EXISTS (SELECT 1 FROM file_chats WHERE file_id = files.id AND chat_id = ?2))";
/// Newest change first.
const NEWEST: &str = "max(at, coalesce(json_extract(about, '$.changed'), 0)) DESC, id";
/// One file of a user that Jet can see.
const ONE_SEEN: &str = "SELECT about FROM files WHERE id = ?1 AND user_id = ?2 AND attached = 1";

impl Store {
    /// Keeps the file, unless all the files together would then be over `limit` bytes, or the
    /// user's own over `user_limit`. `chat` is the chat that wrote it, or `None` for an upload
    /// that is not sent yet. A file of a chat that was forgotten at or after `about.at`, the time
    /// the file was begun, is not kept.
    pub(crate) fn add_file(
        &self,
        user: UserId,
        chat: Option<ChatId>,
        about: &About,
        contents: &[u8],
        (limit, user_limit): (u64, u64),
    ) -> Result<Added, StoreError> {
        let text = to_json(about)?;
        self.try_with(|db| {
            let transaction = db.transaction()?;
            let begun = i64::try_from(about.at).unwrap_or(i64::MAX);
            // Every user's uploads that were never sent are dropped after a day, so neither this
            // user nor the store is filled by files nobody can see.
            transaction.execute(
                "DELETE FROM files WHERE attached = 0 AND at < ?1",
                [begun - UNSENT_MS],
            )?;
            if let Some(chat) = chat
                && transaction.query_row(
                    "SELECT EXISTS (SELECT 1 FROM entries WHERE chat_id = ?1 AND forgotten_at >= ?2)",
                    params![chat.0, begun],
                    |row| row.get::<_, bool>(0),
                )?
            {
                return Ok(Added::Forgotten);
            }
            if store_bytes(&transaction)? + contents.len() as u64 > limit {
                return Ok(Added::Full);
            }
            if user_bytes(&transaction, user)? + contents.len() as u64 > user_limit {
                return Ok(Added::UserFull);
            }
            transaction.execute(
                "INSERT INTO files (id, user_id, at, attached, about, contents, chat_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    about.id.to_string(),
                    user.0,
                    begun,
                    about.attached,
                    text,
                    contents,
                    chat.map(|chat| chat.0)
                ],
            )?;
            transaction.commit()?;
            Ok(Added::Kept)
        })
    }

    /// The details of the user's file. Another user's file is `None`, as a missing one is.
    pub(crate) fn file_about(&self, user: UserId, id: &str) -> Result<Option<About>, StoreError> {
        let row = self.with(|db| {
            db.query_row(
                "SELECT about, attached FROM files WHERE id = ?1 AND user_id = ?2",
                params![id, user.0],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
            )
            .optional()
        })?;
        row.map(|(text, attached)| about(&text, attached))
            .transpose()
    }

    /// The details and the bytes of a file: the user's own, or with `None` any user's, for an
    /// address whose proof names this one file.
    pub(crate) fn file(
        &self,
        user: Option<UserId>,
        id: &str,
    ) -> Result<Option<(About, Vec<u8>)>, StoreError> {
        let row = self.with(|db| {
            db.query_row(
                "SELECT about, attached, contents FROM files
                 WHERE id = ?1 AND (?2 IS NULL OR user_id = ?2)",
                params![id, user.map(|user| user.0)],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, bool>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                    ))
                },
            )
            .optional()
        })?;
        row.map(|(text, attached, contents)| Ok((about(&text, attached)?, contents)))
            .transpose()
    }

    /// Marks the user's files as sent with a message in `chat`, all of them or, when one is
    /// missing, none. A file already sent keeps the chat it was first sent in. Gives the id of the
    /// first missing file.
    pub(crate) fn attach_files(
        &self,
        user: UserId,
        chat: ChatId,
        ids: &[&str],
    ) -> Result<Option<String>, StoreError> {
        self.try_with(|db| {
            let transaction = db.transaction()?;
            for id in ids {
                let marked = transaction.execute(
                    "UPDATE files SET attached = 1, chat_id = coalesce(chat_id, ?3)
                     WHERE id = ?1 AND user_id = ?2 AND json_extract(about, '$.origin') = 'upload'",
                    params![id, user.0, chat.0],
                )?;
                if marked == 0 {
                    return Ok(Some((*id).to_owned()));
                }
            }
            transaction.commit()?;
            Ok(None)
        })
    }

    /// Deletes the user's file, sent or not, with its earlier versions and its place in every
    /// chat, and says whether there was one.
    pub(crate) fn delete_file(&self, user: UserId, id: &str) -> Result<bool, StoreError> {
        self.with(|db| {
            db.execute(
                "DELETE FROM files WHERE id = ?1 AND user_id = ?2",
                params![id, user.0],
            )
            .map(|removed| removed > 0)
        })
    }

    /// The bytes of the user's files and of the earlier versions kept of them.
    pub(crate) fn file_bytes(&self, user: UserId) -> Result<u64, StoreError> {
        self.with(|db| user_bytes(db, user))
    }

    /// The earlier versions kept of the user's file, newest first: each one's number, when it was
    /// written and its size.
    pub(crate) fn earlier_versions(
        &self,
        user: UserId,
        id: &str,
    ) -> Result<Vec<(u32, u64, u64)>, StoreError> {
        self.with(|db| {
            db.prepare(
                "SELECT v.version, v.at, length(v.contents) FROM file_versions v
                 JOIN files f ON f.id = v.file_id
                 WHERE f.id = ?1 AND f.user_id = ?2 ORDER BY v.version DESC",
            )?
            .query_map(params![id, user.0], |row| {
                Ok((
                    row.get(0)?,
                    row.get::<_, i64>(1)?.unsigned_abs(),
                    row.get::<_, i64>(2)?.unsigned_abs(),
                ))
            })?
            .collect()
        })
    }

    /// Deletes the files that only this chat holds. A file shared with another chat stays there.
    pub(crate) fn remove_files(&self, chat: ChatId) -> Result<(), StoreError> {
        self.with(|db| {
            let transaction = db.transaction()?;
            rehome_files(&transaction, chat)?;
            transaction.execute("DELETE FROM files WHERE chat_id = ?1", [chat.0])?;
            transaction.commit()
        })
    }

    /// The files of the user that the chat holds, newest change first, at most `limit` of them,
    /// and how many more there are.
    pub(crate) fn held_by_chat(
        &self,
        user: UserId,
        chat: ChatId,
        limit: usize,
    ) -> Result<(Vec<Held>, usize), StoreError> {
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        self.try_with(|db| {
            let total: i64 = db.query_row(
                &format!("SELECT count(*) FROM files WHERE {HELD_BY_CHAT}"),
                params![user.0, chat.0],
                |row| row.get(0),
            )?;
            let held = held_where(
                db,
                &format!(
                    "SELECT id, about FROM files WHERE {HELD_BY_CHAT} ORDER BY {NEWEST} LIMIT ?3"
                ),
                params![user.0, chat.0, limit],
            )?;
            let more = usize::try_from(total)
                .unwrap_or(0)
                .saturating_sub(held.len());
            Ok((held, more))
        })
    }

    /// Every file of the user that Jet can see, newest change first, at most `limit` of them.
    pub(crate) fn held_by_user(&self, user: UserId, limit: usize) -> Result<Vec<Held>, StoreError> {
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        self.try_with(|db| {
            held_where(
                db,
                &format!(
                    "SELECT id, about FROM files WHERE user_id = ?1 AND attached = 1 ORDER BY {NEWEST} LIMIT ?2"
                ),
                params![user.0, limit],
            )
        })
    }

    /// One file of the user that Jet can see. Another user's is `None`, as a missing one is.
    pub(crate) fn held_file(&self, user: UserId, id: &str) -> Result<Option<Held>, StoreError> {
        self.try_with(|db| {
            let sql = "SELECT id, about FROM files WHERE id = ?1 AND user_id = ?2 AND attached = 1";
            Ok(held_where(db, sql, params![id, user.0])?.pop())
        })
    }

    /// Changes the details of a file of the user that Jet can see, and gives them as they are now.
    pub(crate) fn update_about(
        &self,
        user: UserId,
        id: &str,
        change: impl FnOnce(&mut About),
    ) -> Result<Option<About>, StoreError> {
        self.try_with(|db| {
            let transaction = db.transaction()?;
            let Some(text) = transaction
                .query_row(ONE_SEEN, params![id, user.0], |row| row.get::<_, String>(0))
                .optional()?
            else {
                return Ok(None);
            };
            let mut about = about(&text, true)?;
            change(&mut about);
            transaction.execute(
                "UPDATE files SET about = ?2 WHERE id = ?1",
                params![id, to_json(&about)?],
            )?;
            transaction.commit()?;
            Ok(Some(about))
        })
    }

    /// Gives the file new contents at time `at`. The contents it had stay as an earlier version,
    /// and only the newest few earlier versions are kept.
    pub(crate) fn change_file(
        &self,
        user: UserId,
        id: &str,
        (contents, details): (&[u8], String),
        (at, store_limit, user_limit): (u64, u64, u64),
    ) -> Result<Changed, StoreError> {
        self.try_with(|db| {
            let transaction = db.transaction()?;
            let Some(text) = transaction
                .query_row(ONE_SEEN, params![id, user.0], |row| row.get::<_, String>(0))
                .optional()?
            else {
                return Ok(Changed::Missing);
            };
            if store_bytes(&transaction)? + contents.len() as u64 > store_limit {
                return Ok(Changed::StoreFull);
            }
            if user_bytes(&transaction, user)? + contents.len() as u64 > user_limit {
                return Ok(Changed::Full);
            }
            let mut about = about(&text, true)?;
            // A kept version is stamped with the time it was written, not the time it was replaced.
            let written = i64::try_from(about.changed_at()).unwrap_or(i64::MAX);
            transaction.execute(
                "INSERT INTO file_versions (file_id, version, at, contents)
                 SELECT id, ?2, ?3, contents FROM files WHERE id = ?1",
                params![id, about.version, written],
            )?;
            // What the user uploaded is never pruned: its first version stays.
            let original = i64::from(about.origin == Origin::Upload);
            transaction.execute(
                "DELETE FROM file_versions WHERE file_id = ?1 AND version <= ?2 AND version > ?3",
                params![id, i64::from(about.version) - VERSIONS_KEPT, original],
            )?;
            about.bytes = contents.len() as u64;
            about.details = details;
            about.changed = at;
            about.version += 1;
            transaction.execute(
                "UPDATE files SET about = ?2, contents = ?3 WHERE id = ?1",
                params![id, to_json(&about)?, contents],
            )?;
            transaction.commit()?;
            Ok(Changed::Done)
        })
    }

    /// The contents of an earlier version of the user's file: the one asked for, or the newest.
    pub(crate) fn earlier_contents(
        &self,
        user: UserId,
        id: &str,
        version: Option<u32>,
    ) -> Result<Option<(u32, Vec<u8>)>, StoreError> {
        self.with(|db| {
            db.query_row(
                "SELECT v.version, v.contents FROM file_versions v JOIN files f ON f.id = v.file_id
                 WHERE f.id = ?1 AND f.user_id = ?2 AND (?3 IS NULL OR v.version = ?3)
                 ORDER BY v.version DESC LIMIT 1",
                params![id, user.0, version],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
        })
    }

    /// Lets a chat of the user hold the user's file too. Says whether there was such a file.
    pub(crate) fn share_file(
        &self,
        user: UserId,
        id: &str,
        chat: ChatId,
    ) -> Result<bool, StoreError> {
        self.with(|db| {
            let Some(keeper) = db
                .query_row(
                    "SELECT chat_id FROM files WHERE id = ?1 AND user_id = ?2 AND attached = 1",
                    params![id, user.0],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .optional()?
            else {
                return Ok(false);
            };
            if keeper != Some(chat.0) {
                db.execute(
                    "INSERT OR IGNORE INTO file_chats (file_id, chat_id) VALUES (?1, ?2)",
                    params![id, chat.0],
                )?;
            }
            Ok(true)
        })
    }

    /// Takes the file out of one chat that holds it. The file goes when no other chat holds it.
    /// Gives whether it went and the chats that hold it still, or `None` when the user has no such
    /// file or the chat does not hold it.
    pub(crate) fn release_file(
        &self,
        user: UserId,
        id: &str,
        chat: ChatId,
    ) -> Result<Option<(bool, Vec<ChatId>)>, StoreError> {
        self.try_with(|db| {
            let transaction = db.transaction()?;
            let mut holders = holders(&transaction, id)?;
            let found = transaction
                .query_row(ONE_SEEN, params![id, user.0], |_| Ok(()))
                .optional()?;
            if found.is_none() || !holders.contains(&chat) {
                return Ok(None);
            }
            let keeper = holders[0] == chat;
            holders.retain(|holder| *holder != chat);
            match holders.first() {
                None => {
                    transaction.execute("DELETE FROM files WHERE id = ?1", [id])?;
                }
                Some(next) if keeper => {
                    transaction.execute(
                        "UPDATE files SET chat_id = ?2 WHERE id = ?1",
                        params![id, next.0],
                    )?;
                    transaction.execute(
                        "DELETE FROM file_chats WHERE file_id = ?1 AND chat_id = ?2",
                        params![id, next.0],
                    )?;
                }
                Some(_) => {
                    transaction.execute(
                        "DELETE FROM file_chats WHERE file_id = ?1 AND chat_id = ?2",
                        params![id, chat.0],
                    )?;
                }
            }
            transaction.commit()?;
            Ok(Some((holders.is_empty(), holders)))
        })
    }
}

/// Hands each file that the chat keeps and another chat holds to that other chat, and drops the
/// chat's own shares, so that the files the chat still keeps are the ones only it holds.
pub(super) fn rehome_files(db: &Connection, chat: ChatId) -> rusqlite::Result<()> {
    db.execute(
        "UPDATE files SET chat_id = (SELECT min(chat_id) FROM file_chats WHERE file_id = files.id)
         WHERE chat_id = ?1 AND EXISTS (SELECT 1 FROM file_chats WHERE file_id = files.id)",
        [chat.0],
    )?;
    db.execute(
        "DELETE FROM file_chats WHERE chat_id = (SELECT chat_id FROM files WHERE id = file_id)",
        [],
    )?;
    db.execute("DELETE FROM file_chats WHERE chat_id = ?1", [chat.0])?;
    Ok(())
}

/// The bytes of every user's files and of the earlier versions kept of them.
fn store_bytes(db: &Connection) -> rusqlite::Result<u64> {
    db.query_row(
        "SELECT (SELECT coalesce(sum(length(contents)), 0) FROM files)
              + (SELECT coalesce(sum(length(contents)), 0) FROM file_versions)",
        [],
        |row| row.get::<_, i64>(0).map(i64::unsigned_abs),
    )
}

/// The bytes of the user's files and of the earlier versions kept of them.
fn user_bytes(db: &Connection, user: UserId) -> rusqlite::Result<u64> {
    db.query_row(
        "SELECT (SELECT coalesce(sum(length(contents)), 0) FROM files WHERE user_id = ?1)
              + (SELECT coalesce(sum(length(v.contents)), 0) FROM file_versions v
                 JOIN files f ON f.id = v.file_id WHERE f.user_id = ?1)",
        [user.0],
        |row| row.get::<_, i64>(0).map(i64::unsigned_abs),
    )
}

/// The chats that hold a file, the one that keeps it first.
fn holders(db: &Connection, id: &str) -> rusqlite::Result<Vec<ChatId>> {
    let mut query = db.prepare(
        "SELECT chat_id FROM (
             SELECT chat_id, 0 AS rank FROM files WHERE id = ?1 AND chat_id IS NOT NULL
             UNION ALL SELECT chat_id, 1 FROM file_chats WHERE file_id = ?1)
         ORDER BY rank, chat_id",
    )?;
    let rows = query.query_map([id], |row| row.get(0).map(ChatId))?;
    rows.collect()
}

/// Reads the `id, about` rows of the query as files with their chats and earlier versions.
fn held_where(
    db: &Connection,
    sql: &str,
    arguments: impl rusqlite::Params,
) -> Result<Vec<Held>, StoreError> {
    let rows = db
        .prepare(sql)?
        .query_map(arguments, |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(id, text)| {
            let earlier = db
                .prepare(
                    "SELECT version FROM file_versions WHERE file_id = ?1 ORDER BY version DESC",
                )?
                .query_map([&id], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<u32>>>()?;
            Ok(Held {
                about: about(&text, true)?,
                chats: holders(db, &id)?,
                earlier,
            })
        })
        .collect()
}

fn about(text: &str, attached: bool) -> Result<About, StoreError> {
    let mut about: About = from_json("a file's details", text)?;
    about.attached = attached;
    Ok(about)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::FileKind;
    use crate::store::test_store;

    fn upload(at: u64, attached: bool) -> About {
        let mut about = About::new("a.txt".into(), FileKind::Text, b"x", Origin::Upload, at);
        about.attached = attached;
        about
    }

    #[test]
    fn any_new_file_clears_every_users_uploads_never_sent_that_are_a_day_old() {
        let (_dir, store, ada, bob) = test_store();
        let main = store.main_chat(ada).unwrap().id;
        let (old_unsent, old_sent) = (upload(1_000, false), upload(1_000, true));
        let limits = (u64::MAX, u64::MAX);
        store
            .add_file(bob, None, &old_unsent, b"x", limits)
            .unwrap();
        store
            .add_file(ada, Some(main), &old_sent, b"x", limits)
            .unwrap();
        let fresh = upload(10 * UNSENT_MS as u64, true);
        store
            .add_file(ada, Some(main), &fresh, b"x", limits)
            .unwrap();
        let has = |user: UserId, about: &About| {
            store
                .file_about(user, &about.id.to_string())
                .unwrap()
                .is_some()
        };
        assert!(!has(bob, &old_unsent) && has(ada, &old_sent) && has(ada, &fresh));
    }

    #[test]
    fn a_file_begun_before_its_chat_was_forgotten_is_not_kept() {
        let (_dir, store, ada, _) = test_store();
        let main = store.main_chat(ada).unwrap().id;
        let said = agent::NewEntry::user_text("Write the note");
        store.add_entry(main, said, 1_000).unwrap();
        store.forget_entries(main, 2_000).unwrap();
        let limits = (u64::MAX, u64::MAX);
        let begun_before = upload(1_500, true);
        let begun_after = upload(2_500, true);
        assert!(matches!(
            store.add_file(ada, Some(main), &begun_before, b"x", limits),
            Ok(Added::Forgotten)
        ));
        assert!(matches!(
            store.add_file(ada, Some(main), &begun_after, b"x", limits),
            Ok(Added::Kept)
        ));
    }
}
