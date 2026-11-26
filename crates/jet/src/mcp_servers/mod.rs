//! The MCP servers each user adds, such as Gmail or Jira: kept with sealed keys or an OAuth sign-in,
//! checked when they change or are used, called through the apps' tool client, and told to Jet at each turn.

mod endpoints;
mod oauth;
mod provider;
mod routes;
mod sign_in;

pub(crate) use routes::router;

use crate::{
    WorkerFailed,
    objectives::Clock,
    on_worker,
    seal::Sealer,
    store::{McpProvider, McpServer, McpState, NewMcpServer, SealedKey, Store, StoreError, UserId},
};
use agent::{
    McpServerFacts,
    apps::{AppId, Registry, reaches_server_side},
    mcp::{HttpMcpClient, McpError},
};
use endpoints::{Credential, ToolEndpoints, outcome};
use oauth::SignInError;
use sign_in::Credentials;
use std::sync::{Arc, Mutex};
use url::Url;

/// The longest name, in characters, as the database allows.
const NAME_LIMIT: usize = 60;
/// A key or header value longer than this is a pasted page, not a key.
const KEY_LIMIT: usize = 8192;
/// Headers the MCP protocol sets itself, so a key may not take their place.
const RESERVED_HEADERS: [&str; 9] = [
    "accept",
    "connection",
    "content-length",
    "content-type",
    "host",
    "last-event-id",
    "mcp-protocol-version",
    "mcp-session-id",
    "transfer-encoding",
];

#[derive(Debug, thiserror::Error)]
pub(crate) enum McpServerError {
    #[error(
        "{0:?} is not a server address; give the full address, such as https://mcp.example.com/mcp"
    )]
    InvalidAddress(String),
    #[error("{0} sends a key without encryption; use its https:// address")]
    PlainHttp(String),
    #[error(
        "only an admin can add a server at {0}, because it is on the server itself or a private network"
    )]
    AdminOnly(String),
    #[error("a server's name is one line of 1 to {NAME_LIMIT} characters")]
    InvalidName,
    #[error("{0}")]
    InvalidKey(&'static str),
    #[error("you already added a server at {0}")]
    Duplicate(String),
    #[error("no such MCP server")]
    NotFound,
    #[error("the server is turned off; turn it on to test it")]
    TurnedOff,
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("the MCP server worker failed")]
    Worker(#[from] WorkerFailed),
    #[error(transparent)]
    SignIn(#[from] SignInError),
}

/// The key the user gives for a server. It has no `Debug` print, so it cannot reach a log line.
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum KeyInput {
    /// Sent as `Authorization: Bearer <token>`.
    Bearer { token: String },
    /// Sent as `Authorization: Basic <base64 of user:password>`, as Atlassian's API tokens are.
    Basic { user: String, password: String },
    /// Sent as the header the user names.
    Header { name: String, value: String },
}

impl KeyInput {
    /// The header name and value to send, checked so that the HTTP library takes them.
    fn header(self) -> Result<(String, String), McpServerError> {
        use base64::Engine;
        let (name, value) = match self {
            KeyInput::Bearer { token } => (
                "Authorization".to_owned(),
                format!("Bearer {}", token.trim()),
            ),
            KeyInput::Basic { user, password } => {
                if user.trim().is_empty() || password.trim().is_empty() {
                    return Err(McpServerError::InvalidKey(
                        "give both the email and the API token",
                    ));
                }
                let pair = format!("{}:{}", user.trim(), password.trim());
                let encoded = base64::engine::general_purpose::STANDARD.encode(pair);
                ("Authorization".to_owned(), format!("Basic {encoded}"))
            }
            KeyInput::Header { name, value } => (name.trim().to_owned(), value.trim().to_owned()),
        };
        let name_ok = !name.is_empty()
            && name.len() <= 64
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
        if !name_ok {
            return Err(McpServerError::InvalidKey(
                "a header name is letters, digits and dashes",
            ));
        }
        if RESERVED_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
            return Err(McpServerError::InvalidKey(
                "that header is one the MCP protocol sets itself; choose another",
            ));
        }
        let secret = value
            .split_once(' ')
            .map_or(value.as_str(), |(_, rest)| rest);
        if secret.trim().is_empty() || value.len() > KEY_LIMIT {
            return Err(McpServerError::InvalidKey(
                "the key is empty or too long; paste the key itself",
            ));
        }
        if !value.bytes().all(|byte| (b' '..=b'~').contains(&byte)) {
            return Err(McpServerError::InvalidKey(
                "a key is one line of plain letters, digits and symbols",
            ));
        }
        Ok((name, value))
    }
}

/// What the page sends to add a server.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AddServer {
    pub provider: McpProvider,
    pub name: String,
    pub url: String,
    pub key: Option<KeyInput>,
}

#[derive(Clone)]
pub(crate) struct McpServers {
    store: Store,
    sealer: Sealer,
    credentials: Credentials,
    public_origin: Option<String>,
    mcp: Arc<HttpMcpClient>,
}

impl McpServers {
    /// The servers, and one tool client that reaches both them and the registered apps.
    pub(crate) fn open(
        store: Store,
        sealer: Sealer,
        registry: Arc<Mutex<Registry>>,
        public_origin: Option<String>,
        clock: Clock,
    ) -> (Self, Arc<HttpMcpClient>) {
        let credentials = Credentials::new(store.clone(), sealer.clone(), clock);
        let endpoints = ToolEndpoints {
            registry,
            store: store.clone(),
            sealer: sealer.clone(),
            credentials: credentials.clone(),
        };
        let mcp = Arc::new(HttpMcpClient::new(Arc::new(endpoints)));
        let servers = Self {
            store,
            sealer,
            credentials,
            public_origin,
            mcp: mcp.clone(),
        };
        (servers, mcp)
    }

    pub(crate) async fn list(&self, user: UserId) -> Result<Vec<McpServer>, McpServerError> {
        let store = self.store.clone();
        Ok(on_worker(move || store.mcp_servers(user)).await??)
    }

    /// Whether the server is the user's. Another user's server is not, as a missing one is not.
    pub(crate) fn owned(&self, user: UserId, id: &AppId) -> Result<bool, StoreError> {
        Ok(self.store.mcp_server(user, id)?.is_some())
    }

    /// The ids of the user's servers that are turned on, for a tool search.
    pub(crate) fn enabled_ids(&self, user: UserId) -> Vec<AppId> {
        self.enabled(user)
            .into_iter()
            .map(|server| server.id)
            .collect()
    }

    /// The servers that are turned on, as Jet is told of them at the start of a turn.
    pub(crate) fn facts(&self, user: UserId) -> Vec<McpServerFacts> {
        self.enabled(user).into_iter().map(facts).collect()
    }

    /// The user's servers that are turned on. A failed read leaves Jet with none for this turn and
    /// says why in the log.
    fn enabled(&self, user: UserId) -> Vec<McpServer> {
        match self.store.mcp_servers(user) {
            Ok(servers) => servers
                .into_iter()
                .filter(|server| server.enabled)
                .collect(),
            Err(error) => {
                eprintln!(
                    "jet: could not read the MCP servers of user {}: {error}",
                    user.0
                );
                Vec::new()
            }
        }
    }

    /// Adds the server and connects to it at once, so the answer says whether it works.
    pub(crate) async fn add(
        &self,
        user: UserId,
        is_admin: bool,
        input: AddServer,
    ) -> Result<McpServer, McpServerError> {
        let url = address(&input.url, is_admin)?;
        let name = name(&input.name)?;
        let id = AppId::generate();
        let key = input.key.map(|key| self.seal(user, &id, key)).transpose()?;
        let store = self.store.clone();
        let address = url.to_string();
        let added = {
            let id = id.clone();
            on_worker(move || {
                store.add_mcp_server(
                    user,
                    &NewMcpServer {
                        id: &id,
                        provider: input.provider,
                        name: &name,
                        url: &address,
                        key,
                    },
                )
            })
            .await??
        };
        if !added {
            return Err(McpServerError::Duplicate(url.to_string()));
        }
        self.test(user, &id).await
    }

    /// Connects afresh and lists the server's tools, and keeps what it found.
    pub(crate) async fn test(&self, user: UserId, id: &AppId) -> Result<McpServer, McpServerError> {
        let server = self.get(user, id).await?;
        if !server.enabled {
            return Err(McpServerError::TurnedOff);
        }
        self.mcp.forget(id).await;
        let found = self.mcp.refresh(id).await;
        let (state, reason, tools) = outcome(found.as_ref(), Credential::of(&server));
        let store = self.store.clone();
        let saved = id.clone();
        on_worker(move || {
            store.set_mcp_state(user, &saved, state, reason.as_deref(), tools.as_deref())
        })
        .await??;
        self.get(user, id).await
    }

    /// Keeps what a turn's call or tool listing learned about the server: a key that stopped
    /// working or a server that went away shows on the page and in the next turn, and a server that
    /// answers again shows as connected. Errors that say nothing about the server change nothing.
    pub(crate) async fn note_use(&self, user: UserId, id: &AppId, used: Result<(), &McpError>) {
        let Ok(server) = self.get(user, id).await else {
            return;
        };
        let found = match used {
            Ok(()) if server.state == McpState::Connected => return,
            Ok(()) => self.mcp.catalogue(id).await,
            Err(
                error @ (McpError::Unauthorized
                | McpError::SignInEnded { .. }
                | McpError::Transport { .. }),
            ) => Err(error.clone()),
            Err(_) => return,
        };
        let (state, reason, tools) = outcome(found.as_ref(), Credential::of(&server));
        let (store, saved) = (self.store.clone(), id.clone());
        let recorded = on_worker(move || {
            store.set_mcp_state(user, &saved, state, reason.as_deref(), tools.as_deref())
        })
        .await;
        // The call itself already has its answer, so a state that cannot be saved is only logged;
        // the next test saves it again.
        let failure = match recorded {
            Ok(Ok(_)) => return,
            Ok(Err(error)) => error.to_string(),
            Err(error) => error.to_string(),
        };
        eprintln!("jet: could not record the state of MCP server {id}: {failure}");
    }

    /// Turns the server on, which tests it, or off, which closes its connection.
    pub(crate) async fn set_enabled(
        &self,
        user: UserId,
        id: &AppId,
        enabled: bool,
    ) -> Result<McpServer, McpServerError> {
        let (store, saved) = (self.store.clone(), id.clone());
        if !on_worker(move || store.set_mcp_enabled(user, &saved, enabled)).await?? {
            return Err(McpServerError::NotFound);
        }
        self.mcp.forget(id).await;
        match enabled {
            true => self.test(user, id).await,
            false => self.get(user, id).await,
        }
    }

    /// Saves, replaces or, with `None`, removes the server's key, then tests it when it is on.
    pub(crate) async fn set_key(
        &self,
        user: UserId,
        id: &AppId,
        key: Option<KeyInput>,
    ) -> Result<McpServer, McpServerError> {
        let sealed = key.map(|key| self.seal(user, id, key)).transpose()?;
        let (store, saved) = (self.store.clone(), id.clone());
        if !on_worker(move || store.set_mcp_key(user, &saved, sealed.as_ref())).await?? {
            return Err(McpServerError::NotFound);
        }
        self.mcp.forget(id).await;
        let server = self.get(user, id).await?;
        match server.enabled {
            true => self.test(user, id).await,
            false => Ok(server),
        }
    }

    pub(crate) async fn remove(&self, user: UserId, id: &AppId) -> Result<(), McpServerError> {
        let (store, saved) = (self.store.clone(), id.clone());
        if !on_worker(move || store.remove_mcp_server(user, &saved)).await?? {
            return Err(McpServerError::NotFound);
        }
        self.mcp.forget(id).await;
        Ok(())
    }

    async fn get(&self, user: UserId, id: &AppId) -> Result<McpServer, McpServerError> {
        let (store, id) = (self.store.clone(), id.clone());
        on_worker(move || store.mcp_server(user, &id))
            .await??
            .ok_or(McpServerError::NotFound)
    }

    fn seal(&self, user: UserId, id: &AppId, key: KeyInput) -> Result<SealedKey, McpServerError> {
        let (header, value) = key.header()?;
        Ok(SealedKey {
            header,
            sealed: self.sealer.seal(&owner(user, id), value.as_bytes()),
        })
    }
}

/// The user and the server are sealed with the key, so a sealed key copied to another row does
/// not open.
fn owner(user: UserId, id: &AppId) -> Vec<u8> {
    format!("mcp-server:{}:{id}", user.0).into_bytes()
}

/// The server as Jet is told of it. Only the user's own words and Jet's go in: the tool names are
/// kept only when they are plain names, so a server cannot write into Jet's instructions.
fn facts(server: McpServer) -> McpServerFacts {
    let host = Url::parse(&server.url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_default();
    let problem = match server.state {
        McpState::Connected => None,
        McpState::NeedsKey => Some(
            "the user must sign in to it first, with its Sign in button in Settings, under MCP, or give it a key there."
                .to_owned(),
        ),
        McpState::Failed => Some(
            "the last connection failed; the user can see why and test it again in Settings, under MCP."
                .to_owned(),
        ),
        McpState::Unchecked => Some(
            "Jet has not connected to it yet; the user can test it in Settings, under MCP."
                .to_owned(),
        ),
    };
    let is_plain = |name: &str| {
        (1..=64).contains(&name.len())
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-./".contains(&byte))
    };
    McpServerFacts {
        id: server.id.to_string(),
        purpose: server.provider.purpose(&host),
        name: server.name,
        tools: server
            .tools
            .into_iter()
            .map(|tool| tool.name)
            .filter(|name| is_plain(name))
            .collect(),
        problem,
    }
}

/// The address, checked: a full http or https address with no user name, password or fragment.
/// Only an admin may give one on the server itself or a private network, and a public one must be
/// https, because the key travels with every request.
fn address(input: &str, is_admin: bool) -> Result<Url, McpServerError> {
    let invalid = || McpServerError::InvalidAddress(input.trim().to_owned());
    let url = Url::parse(input.trim()).map_err(|_| invalid())?;
    let is_web = matches!(url.scheme(), "http" | "https");
    if !is_web
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    let server_side = reaches_server_side(&url);
    if server_side && !is_admin {
        return Err(McpServerError::AdminOnly(url.to_string()));
    }
    if url.scheme() == "http" && !server_side {
        return Err(McpServerError::PlainHttp(url.to_string()));
    }
    Ok(url)
}

fn name(input: &str) -> Result<String, McpServerError> {
    let name = input.trim();
    let count = name.chars().count();
    if count == 0 || count > NAME_LIMIT || name.chars().any(char::is_control) {
        return Err(McpServerError::InvalidName);
    }
    Ok(name.to_owned())
}
