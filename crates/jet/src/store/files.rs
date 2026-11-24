//! The files of each user, whole: their details and their bytes.

use super::{Store, StoreError, UserId, from_json, to_json};
use crate::files::About;
use rusqlite::{OptionalExtension, params};

/// What `add_file` did.
pub(crate) enum Added {
    Kept,
    /// Keeping the file would take every user's files together past this many bytes.
    Full,
}

impl Store {
    /// Keeps the file, unless all the files together would then be over `limit` bytes.
    pub(crate) fn add_file(
        &self,
        user: UserId,
        about: &About,
        contents: &[u8],
        limit: u64,
    ) -> Result<Added, StoreError> {
        let text = to_json(about)?;
        self.try_with(|db| {
            let transaction = db.transaction()?;
            let stored: i64 = transaction.query_row(
                "SELECT coalesce(sum(length(contents)), 0) FROM files",
                [],
                |row| row.get(0),
            )?;
            if stored.unsigned_abs() + contents.len() as u64 > limit {
                return Ok(Added::Full);
            }
            transaction.execute(
                "INSERT INTO files (id, user_id, at, attached, about, contents) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    about.id.to_string(),
                    user.0,
                    i64::try_from(about.at).unwrap_or(i64::MAX),
                    about.attached,
                    text,
                    contents
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

    /// The user's files that Jet can see, newest first, at most `limit` of them.
    pub(crate) fn attached_files(
        &self,
        user: UserId,
        limit: usize,
    ) -> Result<Vec<About>, StoreError> {
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let rows = self.with(|db| {
            let mut query = db.prepare(
                "SELECT about FROM files WHERE user_id = ?1 AND attached = 1 ORDER BY at DESC LIMIT ?2",
            )?;
            let rows = query.query_map(params![user.0, limit], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<String>>>()
        })?;
        rows.iter().map(|text| about(text, true)).collect()
    }

    /// Marks the user's files as sent with a message, all of them or, when one is missing, none.
    /// Gives the id of the first missing file.
    pub(crate) fn attach_files(
        &self,
        user: UserId,
        ids: &[&str],
    ) -> Result<Option<String>, StoreError> {
        self.try_with(|db| {
            let transaction = db.transaction()?;
            for id in ids {
                let marked = transaction.execute(
                    "UPDATE files SET attached = 1
                     WHERE id = ?1 AND user_id = ?2 AND json_extract(about, '$.origin') = 'upload'",
                    params![id, user.0],
                )?;
                if marked == 0 {
                    return Ok(Some((*id).to_owned()));
                }
            }
            transaction.commit()?;
            Ok(None)
        })
    }

    /// Deletes the user's upload that was never sent, and says whether there was one.
    pub(crate) fn remove_unsent_file(&self, user: UserId, id: &str) -> Result<bool, StoreError> {
        self.with(|db| {
            db.execute(
                "DELETE FROM files WHERE id = ?1 AND user_id = ?2 AND attached = 0",
                params![id, user.0],
            )
            .map(|removed| removed > 0)
        })
    }

    pub(crate) fn remove_files(&self, user: UserId) -> Result<(), StoreError> {
        self.with(|db| {
            db.execute("DELETE FROM files WHERE user_id = ?1", [user.0])
                .map(drop)
        })
    }
}

fn about(text: &str, attached: bool) -> Result<About, StoreError> {
    let mut about: About = from_json("a file's details", text)?;
    about.attached = attached;
    Ok(about)
}
