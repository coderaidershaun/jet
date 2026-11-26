//! The apps Jet hosts as the browser sees them, each reachable only by the user who added it, and
//! the MCP servers users add, which share the apps' tool client.

mod proxy;
mod registry;
mod tools;

use agent::{
    apps::{App, AppId, AppOwner, Reach, Registry, RegistryCommand, RegistryError, RegistryResult},
    mcp::HttpMcpClient,
};
use axum::{Router, extract::FromRef};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use crate::chat::{BridgeError, Chats};
use crate::lock;
use crate::mcp_servers::McpServers;
use crate::store::{Store, UserId};
pub(crate) use proxy::Proxy;

/// What the app routes and the tool facade share: the registry, the client that calls the tools of
/// the apps and of the users' MCP servers, those servers, and the proxy.
#[derive(Clone)]
pub(crate) struct Apps {
    registry: Arc<Mutex<Registry>>,
    mcp: Arc<HttpMcpClient>,
    servers: McpServers,
    proxy: Proxy,
    store: Store,
    /// Told about each change, so the owner's open chats show it.
    chats: Arc<OnceLock<Weak<Chats>>>,
}

impl Apps {
    pub(crate) fn new(
        registry: Arc<Mutex<Registry>>,
        mcp: Arc<HttpMcpClient>,
        servers: McpServers,
        proxy: Proxy,
        store: Store,
    ) -> Self {
        Self {
            registry,
            mcp,
            servers,
            proxy,
            store,
            chats: Arc::new(OnceLock::new()),
        }
    }

    pub(crate) fn tell_chats(&self, chats: Weak<Chats>) {
        // Set once while the server opens; a second call would change nothing.
        let _ = self.chats.set(chats);
    }

    pub(crate) fn mcp(&self) -> &Arc<HttpMcpClient> {
        &self.mcp
    }

    pub(crate) fn servers(&self) -> &McpServers {
        &self.servers
    }

    /// The user's apps, in the order they were added.
    pub(crate) fn list(&self, user: UserId) -> Vec<App> {
        lock(&self.registry).list(owner(user))
    }

    /// The app when it belongs to the user. Another user's app is `None`, as a missing one is.
    pub(crate) fn owned(&self, user: UserId, id: &AppId) -> Option<App> {
        lock(&self.registry).owned(owner(user), id).cloned()
    }

    /// Runs the user's registry command and tells the user's chats what changed. Only an admin may
    /// save an app at a port, a loopback or a private address. It waits on the network, so it runs
    /// away from the server's own threads.
    pub(crate) fn execute(
        &self,
        user: UserId,
        command: RegistryCommand,
    ) -> Result<RegistryResult, BridgeError> {
        let is_admin = self.store.user(user)?.is_some_and(|user| user.is_admin);
        let reach = if is_admin {
            Reach::Anywhere
        } else {
            Reach::PublicOnly
        };
        let result = lock(&self.registry)
            .execute(owner(user), reach, command)
            .map_err(|error| match error {
                RegistryError::ServerSide(_) => BridgeError::AdminOnly(error.to_string()),
                RegistryError::NotFound(_) => BridgeError::NotFound(error.to_string()),
                other => BridgeError::InvalidRequest(other.to_string()),
            })?;
        if let (Some(event), Some(chats)) =
            (&result.change, self.chats.get().and_then(Weak::upgrade))
        {
            chats.registry_changed(user, event);
        }
        Ok(result)
    }

    /// Closes the connections to the apps' tools.
    pub(crate) async fn shutdown(&self) {
        self.mcp.shutdown().await;
    }
}

fn owner(user: UserId) -> AppOwner {
    AppOwner(user.0)
}

pub(crate) fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Apps: FromRef<S>,
{
    Router::new()
        .merge(registry::router())
        .merge(tools::router())
        .merge(proxy::router())
}
