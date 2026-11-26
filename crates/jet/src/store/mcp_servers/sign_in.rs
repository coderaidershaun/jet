//! The OAuth sign-in of each MCP server: how its provider signs Jet in, the client and tokens Jet
//! keeps for it, sealed, and the sign-ins users have started and not finished.

use crate::store::{Store, StoreError, UserId};
use agent::apps::AppId;
use rusqlite::{OptionalExtension, params};

/// How a server's provider signs Jet in, and the client Jet signs in as.
pub(crate) struct SignInSetup {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub resource: String,
    pub scope: Option<String>,
    pub client_id: String,
    pub sealed_client_secret: Option<Vec<u8>>,
    /// Whether Jet registered the client itself, rather than the user pasting its id.
    pub registered: bool,
    pub redirect_uri: String,
    pub secret_in_body: bool,
}

/// The tokens of a sign-in, sealed.
pub(crate) struct SealedTokens {
    pub access: Vec<u8>,
    pub refresh: Option<Vec<u8>>,
    /// When to renew the access token before using it, in seconds since 1970.
    pub renew_at: Option<i64>,
}

/// A server's sign-in as it is kept, with whose server it is and where the server is.
pub(crate) struct StoredSignIn {
    pub user: UserId,
    pub url: String,
    pub setup: SignInSetup,
    pub tokens: Option<SealedTokens>,
}

/// A sign-in the user started and has not finished: which server, the sealed PKCE verifier, the
/// redirect address the provider was given, and when it runs out, in seconds since 1970.
pub(crate) struct SignInStart {
    pub server_id: AppId,
    pub sealed_verifier: Vec<u8>,
    pub redirect_uri: String,
    pub expires_at: i64,
}

impl Store {
    /// Starts a sign-in, in one change: keeps how the server's provider signs Jet in and the client
    /// Jet signs in as, and the start the provider's answer must match. One start at a time is open
    /// for a server, and starts that ran out are cleared.
    pub(crate) fn begin_mcp_sign_in(
        &self,
        user: UserId,
        state_hash: &str,
        setup: &SignInSetup,
        start: &SignInStart,
        now: i64,
    ) -> Result<(), StoreError> {
        self.with(|db| {
            let tx = db.transaction()?;
            save_setup(&tx, &start.server_id, setup)?;
            tx.execute(
                "DELETE FROM mcp_sign_in_starts WHERE expires_at <= ?1 OR server_id = ?2",
                params![now, start.server_id.to_string()],
            )?;
            tx.execute(
                "INSERT INTO mcp_sign_in_starts (state_hash, server_id, user_id, sealed_verifier, redirect_uri, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    state_hash,
                    start.server_id.to_string(),
                    user.0,
                    start.sealed_verifier,
                    start.redirect_uri,
                    start.expires_at
                ],
            )?;
            tx.commit()
        })
    }

    /// The server's sign-in, whoever added the server. Only for callers that already checked the
    /// owner, or that act for the tool client.
    pub(crate) fn mcp_sign_in(&self, id: &AppId) -> Result<Option<StoredSignIn>, StoreError> {
        self.with(|db| {
            db.query_row(
                "SELECT s.user_id, s.url, o.authorization_endpoint, o.token_endpoint, o.resource, o.scope,
                        o.client_id, o.sealed_client_secret, o.registered, o.redirect_uri, o.secret_in_body,
                        o.sealed_access, o.sealed_refresh, o.renew_at
                 FROM mcp_sign_ins o JOIN mcp_servers s ON s.id = o.server_id
                 WHERE o.server_id = ?1",
                [id.to_string()],
                |row| {
                    let access: Option<Vec<u8>> = row.get(11)?;
                    let refresh: Option<Vec<u8>> = row.get(12)?;
                    let renew_at: Option<i64> = row.get(13)?;
                    Ok(StoredSignIn {
                        user: UserId(row.get(0)?),
                        url: row.get(1)?,
                        setup: SignInSetup {
                            authorization_endpoint: row.get(2)?,
                            token_endpoint: row.get(3)?,
                            resource: row.get(4)?,
                            scope: row.get(5)?,
                            client_id: row.get(6)?,
                            sealed_client_secret: row.get(7)?,
                            registered: row.get(8)?,
                            redirect_uri: row.get(9)?,
                            secret_in_body: row.get(10)?,
                        },
                        tokens: access.map(|access| SealedTokens {
                            access,
                            refresh,
                            renew_at,
                        }),
                    })
                },
            )
            .optional()
        })
    }

    /// Keeps the tokens of a finished sign-in. A sign-in takes the place of a key, so the key is
    /// removed, and the server is not checked again until it is tested.
    pub(crate) fn sign_in_mcp(
        &self,
        id: &AppId,
        tokens: &SealedTokens,
    ) -> Result<bool, StoreError> {
        self.with(|db| {
            let tx = db.transaction()?;
            let changed = tx.execute(
                "UPDATE mcp_sign_ins SET sealed_access = ?2, sealed_refresh = ?3, renew_at = ?4
                 WHERE server_id = ?1",
                params![id.to_string(), tokens.access, tokens.refresh, tokens.renew_at],
            )?;
            tx.execute(
                "UPDATE mcp_servers SET key_header = NULL, sealed_key = NULL, state = 'unchecked', reason = NULL
                 WHERE id = ?1",
                [id.to_string()],
            )?;
            tx.commit()?;
            Ok(changed == 1)
        })
    }

    /// Keeps renewed tokens, unless the user signed out or saved a key meanwhile.
    pub(crate) fn renew_mcp_tokens(
        &self,
        id: &AppId,
        tokens: &SealedTokens,
    ) -> Result<bool, StoreError> {
        self.with(|db| {
            let changed = db.execute(
                "UPDATE mcp_sign_ins SET sealed_access = ?2, sealed_refresh = ?3, renew_at = ?4
                 WHERE server_id = ?1 AND sealed_access IS NOT NULL",
                params![
                    id.to_string(),
                    tokens.access,
                    tokens.refresh,
                    tokens.renew_at
                ],
            )?;
            Ok(changed == 1)
        })
    }

    /// Forgets the server's tokens and keeps its client, so the next sign-in needs no new one.
    pub(crate) fn forget_mcp_tokens(&self, id: &AppId) -> Result<(), StoreError> {
        self.with(|db| forget_tokens(db, id))
    }

    /// Signs the user's server out, in one change: forgets its tokens, keeps its client, and marks
    /// it as needing a sign-in. False when the user has no such server signed in.
    pub(crate) fn sign_out_mcp(&self, user: UserId, id: &AppId) -> Result<bool, StoreError> {
        self.with(|db| {
            let tx = db.transaction()?;
            let changed = tx.execute(
                "UPDATE mcp_servers SET state = 'needs_key', reason = NULL
                 WHERE id = ?1 AND user_id = ?2
                   AND EXISTS (SELECT 1 FROM mcp_sign_ins WHERE server_id = ?1 AND sealed_access IS NOT NULL)",
                params![id.to_string(), user.0],
            )?;
            if changed == 1 {
                forget_tokens(&tx, id)?;
            }
            tx.commit()?;
            Ok(changed == 1)
        })
    }

    /// Forgets the server's whole sign-in, client included, so the next sign-in registers Jet again
    /// or asks the user for a client.
    pub(crate) fn forget_mcp_client(&self, id: &AppId) -> Result<(), StoreError> {
        self.with(|db| {
            db.execute(
                "DELETE FROM mcp_sign_ins WHERE server_id = ?1",
                [id.to_string()],
            )?;
            Ok(())
        })
    }

    /// Takes the user's sign-in with this state, once: a second use, another user's state or one
    /// that ran out finds nothing.
    pub(crate) fn take_mcp_sign_in_start(
        &self,
        user: UserId,
        state_hash: &str,
        now: i64,
    ) -> Result<Option<SignInStart>, StoreError> {
        let taken = self.with(|db| {
            db.query_row(
                "DELETE FROM mcp_sign_in_starts WHERE state_hash = ?1 AND user_id = ?2
                 RETURNING server_id, sealed_verifier, redirect_uri, expires_at",
                params![state_hash, user.0],
                |row| {
                    let server_id: String = row.get(0)?;
                    let expires_at: i64 = row.get(3)?;
                    Ok((server_id, row.get(1)?, row.get(2)?, expires_at))
                },
            )
            .optional()
        })?;
        let Some((server_id, sealed_verifier, redirect_uri, expires_at)) = taken else {
            return Ok(None);
        };
        let Ok(server_id) = server_id.parse() else {
            return Ok(None);
        };
        Ok((expires_at > now).then_some(SignInStart {
            server_id,
            sealed_verifier,
            redirect_uri,
            expires_at,
        }))
    }
}

/// Keeps how the server's provider signs Jet in and the client Jet signs in as. Tokens made for
/// another client cannot be renewed by this one, so a new client forgets them.
fn save_setup(db: &rusqlite::Connection, id: &AppId, setup: &SignInSetup) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO mcp_sign_ins (server_id, authorization_endpoint, token_endpoint, resource, scope,
             client_id, sealed_client_secret, registered, redirect_uri, secret_in_body)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (server_id) DO UPDATE SET
             authorization_endpoint = excluded.authorization_endpoint,
             token_endpoint = excluded.token_endpoint,
             resource = excluded.resource,
             scope = excluded.scope,
             sealed_access = CASE WHEN excluded.client_id IS client_id THEN sealed_access ELSE NULL END,
             sealed_refresh = CASE WHEN excluded.client_id IS client_id THEN sealed_refresh ELSE NULL END,
             renew_at = CASE WHEN excluded.client_id IS client_id THEN renew_at ELSE NULL END,
             client_id = excluded.client_id,
             sealed_client_secret = excluded.sealed_client_secret,
             registered = excluded.registered,
             redirect_uri = excluded.redirect_uri,
             secret_in_body = excluded.secret_in_body",
        params![
            id.to_string(),
            setup.authorization_endpoint,
            setup.token_endpoint,
            setup.resource,
            setup.scope,
            setup.client_id,
            setup.sealed_client_secret,
            setup.registered,
            setup.redirect_uri,
            setup.secret_in_body,
        ],
    )?;
    Ok(())
}

pub(super) fn forget_tokens(db: &rusqlite::Connection, id: &AppId) -> Result<(), rusqlite::Error> {
    db.execute(
        "UPDATE mcp_sign_ins SET sealed_access = NULL, sealed_refresh = NULL, renew_at = NULL
         WHERE server_id = ?1",
        [id.to_string()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::store::{MIGRATIONS, apply};
    use rusqlite::{Connection, params};

    #[test]
    fn the_sign_in_migration_keeps_every_server_and_lets_a_sign_in_carry_its_reason() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        for (index, sql) in MIGRATIONS.iter().take(15).enumerate() {
            apply(&mut db, sql, index + 1).unwrap();
        }
        db.execute(
            "INSERT INTO users (email, display_name, password_hash) VALUES ('ada@example.com', 'Ada', 'x')",
            [],
        )
        .unwrap();
        for (id, url, state, reason) in [
            (
                "a1",
                "https://one.example/mcp",
                "failed",
                Some("could not connect"),
            ),
            ("a2", "https://two.example/mcp", "connected", None),
            ("a3", "https://three.example/mcp", "needs_key", None),
        ] {
            db.execute(
                "INSERT INTO mcp_servers (id, user_id, provider, name, url, enabled, key_header, sealed_key, state, reason, tools)
                 VALUES (?1, 1, 'custom', 'S', ?2, 1, NULL, NULL, ?3, ?4, '[]')",
                params![id, url, state, reason],
            )
            .unwrap();
        }
        db.execute("DELETE FROM mcp_servers WHERE id = 'a2'", [])
            .unwrap();
        let rows = |db: &Connection| -> Vec<(String, String, Option<String>)> {
            db.prepare("SELECT id, state, reason FROM mcp_servers ORDER BY rowid")
                .unwrap()
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };
        let before = rows(&db);

        apply(&mut db, MIGRATIONS[15], 16).unwrap();

        assert_eq!(rows(&db), before, "every server is kept, in its order");
        let checked: i64 = db
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(checked, 0);
        db.execute(
            "UPDATE mcp_servers SET reason = 'the sign-in ended' WHERE id = 'a3'",
            [],
        )
        .unwrap();
        let connected_with_reason = db.execute(
            "UPDATE mcp_servers SET state = 'connected' WHERE id = 'a3'",
            [],
        );
        assert!(
            connected_with_reason.is_err(),
            "only a server that is not connected has a reason"
        );
        db.execute(
            "INSERT INTO mcp_sign_ins (server_id, authorization_endpoint, token_endpoint, resource, client_id, registered, redirect_uri, secret_in_body)
             VALUES ('a3', 'https://a/authorize', 'https://a/token', 'https://three.example/mcp', 'c', 1, 'https://jet/mcp-signin/return', 0)",
            [],
        )
        .unwrap();
        db.execute("DELETE FROM mcp_servers WHERE id = 'a3'", [])
            .unwrap();
        let left: i64 = db
            .query_row("SELECT count(*) FROM mcp_sign_ins", [], |row| row.get(0))
            .unwrap();
        assert_eq!(left, 0, "removing a server forgets its sign-in");
    }
}
