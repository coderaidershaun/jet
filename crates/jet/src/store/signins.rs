//! Sign-ins and their refresh tokens: start one, renew it, end it, and ask whether it is live.

use super::{Email, Store, StoreError, User, UserId, seconds};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub(crate) struct SigninId(pub(crate) String);

/// What happened to a refresh token offered for renewal.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Rotation {
    /// The token was current: it is now replaced by the new one.
    Renewed(SigninId),
    /// The token had already been replaced, so someone holds a copy: the sign-in is now ended.
    Reused,
    /// No live sign-in has this token.
    Unknown,
}

impl Store {
    /// Records a new sign-in with its first refresh token, and forgets sign-ins that ran out.
    pub(crate) fn start_signin(
        &self,
        signin: &SigninId,
        user: UserId,
        refresh: &[u8],
        now: u64,
        expires_at: u64,
    ) -> Result<(), StoreError> {
        let (now, expires_at) = (seconds(now), seconds(expires_at));
        self.with(|db| {
            let transaction = db.transaction()?;
            transaction.execute("DELETE FROM signins WHERE expires_at <= ?1", [now])?;
            transaction.execute(
                "INSERT INTO signins (id, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)",
                params![signin.0, user.0, now, expires_at],
            )?;
            transaction.execute(
                "INSERT INTO refresh_tokens (hash, signin_id) VALUES (?1, ?2)",
                params![refresh, signin.0],
            )?;
            transaction.commit()
        })
    }

    /// The user of the sign-in, when it is neither ended nor out of time.
    pub(crate) fn live_signin(
        &self,
        signin: &SigninId,
        now: u64,
    ) -> Result<Option<User>, StoreError> {
        let now = seconds(now);
        self.with(|db| {
            db.query_row(
                "SELECT users.id, users.email, users.display_name, users.is_admin
                 FROM signins JOIN users ON users.id = signins.user_id
                 WHERE signins.id = ?1 AND signins.revoked_at IS NULL AND signins.expires_at > ?2",
                params![signin.0, now],
                |row| {
                    Ok(User {
                        id: UserId(row.get(0)?),
                        email: Email::from(row.get::<_, String>(1)?.as_str()),
                        display_name: row.get(2)?,
                        is_admin: row.get(3)?,
                    })
                },
            )
            .optional()
        })
    }

    pub(crate) fn rotate_refresh(
        &self,
        old: &[u8],
        new: &[u8],
        now: u64,
    ) -> Result<Rotation, StoreError> {
        let now = seconds(now);
        self.with(|db| {
            let transaction = db.transaction()?;
            let found: Option<(String, Option<i64>, bool)> = transaction
                .query_row(
                    "SELECT signins.id, refresh_tokens.replaced_at,
                            signins.revoked_at IS NULL AND signins.expires_at > ?2
                     FROM refresh_tokens JOIN signins ON signins.id = refresh_tokens.signin_id
                     WHERE refresh_tokens.hash = ?1",
                    params![old, now],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let rotation = match found {
                Some((signin, Some(_), _)) => {
                    transaction.execute(
                        "UPDATE signins SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL",
                        params![signin, now],
                    )?;
                    Rotation::Reused
                }
                Some((signin, None, true)) => {
                    transaction.execute(
                        "UPDATE refresh_tokens SET replaced_at = ?2 WHERE hash = ?1",
                        params![old, now],
                    )?;
                    transaction.execute(
                        "INSERT INTO refresh_tokens (hash, signin_id) VALUES (?1, ?2)",
                        params![new, signin],
                    )?;
                    Rotation::Renewed(SigninId(signin))
                }
                Some((_, None, false)) | None => Rotation::Unknown,
            };
            transaction.commit()?;
            Ok(rotation)
        })
    }

    pub(crate) fn signin_of_refresh(&self, refresh: &[u8]) -> Result<Option<SigninId>, StoreError> {
        self.with(|db| {
            db.query_row(
                "SELECT signin_id FROM refresh_tokens WHERE hash = ?1",
                [refresh],
                |row| Ok(SigninId(row.get(0)?)),
            )
            .optional()
        })
    }

    pub(crate) fn end_signin(&self, signin: &SigninId, now: u64) -> Result<(), StoreError> {
        let now = seconds(now);
        self.with(|db| {
            db.execute(
                "UPDATE signins SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL",
                params![signin.0, now],
            )?;
            Ok(())
        })
    }
}
