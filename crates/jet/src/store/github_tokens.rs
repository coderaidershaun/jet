//! Each user's sealed GitHub token. The store only keeps the sealed bytes; it never sees the token.

use super::{Store, StoreError, UserId};
use rusqlite::{OptionalExtension, params};

impl Store {
    /// Saves, replaces or, with `None`, removes the user's sealed token.
    pub(crate) fn set_github_token(
        &self,
        user: UserId,
        sealed: Option<&[u8]>,
    ) -> Result<(), StoreError> {
        self.with(|db| {
            db.execute(
                "UPDATE users SET github_token = ?1 WHERE id = ?2",
                params![sealed, user.0],
            )
            .map(drop)
        })
    }

    pub(crate) fn github_token(&self, user: UserId) -> Result<Option<Vec<u8>>, StoreError> {
        self.with(|db| {
            db.query_row(
                "SELECT github_token FROM users WHERE id = ?1",
                [user.0],
                |row| row.get::<_, Option<Vec<u8>>>(0),
            )
            .optional()
            .map(Option::flatten)
        })
    }
}
