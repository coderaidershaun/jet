//! Users, teams, team members and each user's manager.

use super::{Store, StoreError};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub(crate) struct UserId(pub(crate) i64);

/// An email address in the one form it is stored and looked up in, so that letter case never
/// makes two accounts.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
pub(crate) struct Email(String);

impl From<&str> for Email {
    fn from(text: &str) -> Self {
        Self(text.trim().to_lowercase())
    }
}

impl Email {
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct User {
    pub(crate) id: UserId,
    pub(crate) email: Email,
    pub(crate) display_name: String,
    pub(crate) is_admin: bool,
}

pub(crate) struct NewUser<'a> {
    pub(crate) email: &'a Email,
    pub(crate) display_name: &'a str,
    pub(crate) password_hash: &'a str,
    pub(crate) is_admin: bool,
}

impl Store {
    pub(crate) fn user_count(&self) -> Result<u64, StoreError> {
        let count: i64 =
            self.with(|db| db.query_row("SELECT count(*) FROM users", [], |row| row.get(0)))?;
        Ok(count.unsigned_abs())
    }

    pub(crate) fn user_id(&self, email: &Email) -> Result<Option<UserId>, StoreError> {
        self.with(|db| {
            db.query_row(
                "SELECT id FROM users WHERE email = ?1",
                [email.as_str()],
                |row| Ok(UserId(row.get(0)?)),
            )
            .optional()
        })
    }

    pub(crate) fn user(&self, id: UserId) -> Result<Option<User>, StoreError> {
        self.with(|db| {
            db.query_row(
                "SELECT email, display_name, is_admin FROM users WHERE id = ?1",
                [id.0],
                |row| {
                    Ok(User {
                        id,
                        email: Email(row.get(0)?),
                        display_name: row.get(1)?,
                        is_admin: row.get(2)?,
                    })
                },
            )
            .optional()
        })
    }

    /// The stored hash of the user's password. It never leaves the sign-in check.
    pub(crate) fn password_hash(
        &self,
        email: &Email,
    ) -> Result<Option<(UserId, String)>, StoreError> {
        self.with(|db| {
            db.query_row(
                "SELECT id, password_hash FROM users WHERE email = ?1",
                [email.as_str()],
                |row| Ok((UserId(row.get(0)?), row.get(1)?)),
            )
            .optional()
        })
    }

    /// Adds the user with an empty main chat; nothing else is saved for them until they change it.
    pub(crate) fn add_user(&self, user: &NewUser) -> Result<UserId, StoreError> {
        self.with(|db| {
            let transaction = db.transaction()?;
            transaction.execute(
                "INSERT INTO users (email, display_name, password_hash, is_admin) VALUES (?1, ?2, ?3, ?4)",
                params![user.email.as_str(), user.display_name, user.password_hash, user.is_admin],
            )?;
            let id = transaction.last_insert_rowid();
            transaction.execute(
                "INSERT INTO chats (user_id, kind, created_at) VALUES (?1, 'main', unixepoch())",
                [id],
            )?;
            transaction.commit()?;
            Ok(UserId(id))
        })
    }

    /// Puts the user in the team, making the team if it is new. Doing it twice changes nothing.
    pub(crate) fn add_team_member(&self, team: &str, user: UserId) -> Result<(), StoreError> {
        self.with(|db| {
            db.execute("INSERT OR IGNORE INTO teams (name) VALUES (?1)", [team])?;
            db.execute(
                "INSERT OR IGNORE INTO team_members (team_id, user_id) SELECT id, ?2 FROM teams WHERE name = ?1",
                params![team, user.0],
            )?;
            Ok(())
        })
    }

    pub(crate) fn set_manager(&self, user: UserId, manager: UserId) -> Result<(), StoreError> {
        self.with(|db| {
            db.execute(
                "UPDATE users SET manager_id = ?2 WHERE id = ?1",
                params![user.0, manager.0],
            )?;
            Ok(())
        })
    }
}
