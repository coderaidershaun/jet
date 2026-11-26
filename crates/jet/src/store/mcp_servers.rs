//! The MCP servers each user added, each with its sealed key and what Jet found the last time it
//! connected. The store keeps only sealed key bytes; it never sees a key in clear.

use super::{Store, StoreError, UserId, text_enum::text_enum, to_json};
use agent::apps::AppId;
use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

text_enum!(
    /// Who runs the server, which says what it is for. `Custom` is a server the user names.
    McpProvider {
        Gmail = "gmail",
        Google = "google",
        Outlook = "outlook",
        Slack = "slack",
        Notion = "notion",
        Jira = "jira",
        Custom = "custom",
    }
);

text_enum!(
    /// What happened the last time Jet connected to the server.
    McpState {
        Unchecked = "unchecked",
        Connected = "connected",
        NeedsKey = "needs_key",
        Failed = "failed",
    }
);

/// One tool the server listed, as the page and Jet are told of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpTool {
    pub name: String,
    pub read_only: bool,
}

/// A server as the page may see it: everything but the key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServer {
    pub id: AppId,
    pub provider: McpProvider,
    pub name: String,
    pub url: String,
    pub enabled: bool,
    /// The header the key is sent in, or `None` when the server has no key.
    pub key_header: Option<String>,
    pub state: McpState,
    /// Why the last connection failed, only when `state` is `Failed`.
    pub reason: Option<String>,
    pub tools: Vec<McpTool>,
}

/// A key sealed for its server: the header it is sent in, and the sealed value.
pub(crate) struct SealedKey {
    pub header: String,
    pub sealed: Vec<u8>,
}

pub(crate) struct NewMcpServer<'a> {
    pub id: &'a AppId,
    pub provider: McpProvider,
    pub name: &'a str,
    pub url: &'a str,
    pub key: Option<SealedKey>,
}

/// What the tool client needs to reach a server: whose it is, where, whether it is on, and its key.
pub(crate) struct StoredEndpoint {
    pub user: UserId,
    pub url: String,
    pub enabled: bool,
    pub key: Option<SealedKey>,
}

const COLUMNS: &str = "id, provider, name, url, enabled, key_header, state, reason, tools";

impl Store {
    /// Adds the server, not yet checked. False when the user already has a server at that address.
    pub(crate) fn add_mcp_server(
        &self,
        user: UserId,
        server: &NewMcpServer<'_>,
    ) -> Result<bool, StoreError> {
        let (header, sealed) = match &server.key {
            Some(key) => (Some(key.header.as_str()), Some(key.sealed.as_slice())),
            None => (None, None),
        };
        self.with(|db| {
            let inserted = db.execute(
                "INSERT INTO mcp_servers (id, user_id, provider, name, url, enabled, key_header, sealed_key, state, reason, tools)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, 'unchecked', NULL, '[]')
                 ON CONFLICT (user_id, url) DO NOTHING",
                params![server.id.to_string(), user.0, server.provider, server.name, server.url, header, sealed],
            )?;
            Ok(inserted == 1)
        })
    }

    /// The user's servers, in the order they were added.
    pub(crate) fn mcp_servers(&self, user: UserId) -> Result<Vec<McpServer>, StoreError> {
        self.with(|db| {
            let mut query = db.prepare(&format!(
                "SELECT {COLUMNS} FROM mcp_servers WHERE user_id = ?1 ORDER BY rowid"
            ))?;
            let rows = query.query_map([user.0], server)?;
            rows.collect()
        })
    }

    /// The server when it is the user's. Another user's server is `None`, as a missing one is.
    pub(crate) fn mcp_server(
        &self,
        user: UserId,
        id: &AppId,
    ) -> Result<Option<McpServer>, StoreError> {
        self.with(|db| {
            db.query_row(
                &format!("SELECT {COLUMNS} FROM mcp_servers WHERE id = ?1 AND user_id = ?2"),
                params![id.to_string(), user.0],
                server,
            )
            .optional()
        })
    }

    /// Turns the user's server on or off. False when the user has no such server.
    pub(crate) fn set_mcp_enabled(
        &self,
        user: UserId,
        id: &AppId,
        enabled: bool,
    ) -> Result<bool, StoreError> {
        self.with(|db| {
            let changed = db.execute(
                "UPDATE mcp_servers SET enabled = ?3 WHERE id = ?1 AND user_id = ?2",
                params![id.to_string(), user.0, enabled],
            )?;
            Ok(changed == 1)
        })
    }

    /// Saves, replaces or, with `None`, removes the server's key. What Jet found with the old key
    /// no longer holds, so the server is not checked again until it is tested.
    pub(crate) fn set_mcp_key(
        &self,
        user: UserId,
        id: &AppId,
        key: Option<&SealedKey>,
    ) -> Result<bool, StoreError> {
        let (header, sealed) = match key {
            Some(key) => (Some(key.header.as_str()), Some(key.sealed.as_slice())),
            None => (None, None),
        };
        self.with(|db| {
            let changed = db.execute(
                "UPDATE mcp_servers SET key_header = ?3, sealed_key = ?4, state = 'unchecked', reason = NULL, tools = '[]'
                 WHERE id = ?1 AND user_id = ?2",
                params![id.to_string(), user.0, header, sealed],
            )?;
            Ok(changed == 1)
        })
    }

    /// Records what Jet found when it connected. A failed state carries its reason; the others
    /// carry none. The tools are kept from the last connection that listed them.
    pub(crate) fn set_mcp_state(
        &self,
        user: UserId,
        id: &AppId,
        state: McpState,
        reason: Option<&str>,
        tools: Option<&[McpTool]>,
    ) -> Result<bool, StoreError> {
        let tools = tools.map(|tools| to_json(&tools)).transpose()?;
        self.with(|db| {
            let changed = db.execute(
                "UPDATE mcp_servers SET state = ?3, reason = ?4, tools = coalesce(?5, tools)
                 WHERE id = ?1 AND user_id = ?2",
                params![id.to_string(), user.0, state, reason, tools],
            )?;
            Ok(changed == 1)
        })
    }

    /// False when the user has no such server.
    pub(crate) fn remove_mcp_server(&self, user: UserId, id: &AppId) -> Result<bool, StoreError> {
        self.with(|db| {
            let removed = db.execute(
                "DELETE FROM mcp_servers WHERE id = ?1 AND user_id = ?2",
                params![id.to_string(), user.0],
            )?;
            Ok(removed == 1)
        })
    }

    /// The server with this id, whoever added it. Only for the tool client, whose callers have
    /// already checked the owner.
    pub(crate) fn mcp_endpoint(&self, id: &AppId) -> Result<Option<StoredEndpoint>, StoreError> {
        self.with(|db| {
            db.query_row(
                "SELECT user_id, url, enabled, key_header, sealed_key FROM mcp_servers WHERE id = ?1",
                [id.to_string()],
                |row| {
                    let header: Option<String> = row.get(3)?;
                    let sealed: Option<Vec<u8>> = row.get(4)?;
                    Ok(StoredEndpoint {
                        user: UserId(row.get(0)?),
                        url: row.get(1)?,
                        enabled: row.get(2)?,
                        key: header
                            .zip(sealed)
                            .map(|(header, sealed)| SealedKey { header, sealed }),
                    })
                },
            )
            .optional()
        })
    }
}

fn server(row: &Row<'_>) -> rusqlite::Result<McpServer> {
    let invalid = |column, error: Box<dyn std::error::Error + Send + Sync>| {
        rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, error)
    };
    let id: String = row.get(0)?;
    let tools: String = row.get(8)?;
    Ok(McpServer {
        id: id.parse().map_err(|error| invalid(0, Box::new(error)))?,
        provider: row.get(1)?,
        name: row.get(2)?,
        url: row.get(3)?,
        enabled: row.get(4)?,
        key_header: row.get(5)?,
        state: row.get(6)?,
        reason: row.get(7)?,
        tools: serde_json::from_str(&tools).map_err(|error| invalid(8, Box::new(error)))?,
    })
}
