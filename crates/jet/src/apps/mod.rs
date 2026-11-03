//! The apps Jet hosts, as the browser sees them: the list and its changes, each app's tools, and
//! the proxy that serves an app's own page from Jet's address.

mod proxy;
mod registry;
mod tools;

use agent::{apps::Registry, mcp::HttpMcpClient};
use axum::{Router, extract::FromRef};
use std::sync::{Arc, Mutex};

pub(crate) use proxy::Proxy;

/// What the app routes share: the registry, the client that calls the apps' tools, and the proxy.
#[derive(Clone)]
pub(crate) struct Apps {
    registry: Arc<Mutex<Registry>>,
    mcp: Arc<HttpMcpClient>,
    proxy: Proxy,
}

impl Apps {
    pub(crate) fn new(
        registry: Arc<Mutex<Registry>>,
        mcp: Arc<HttpMcpClient>,
        proxy: Proxy,
    ) -> Self {
        Self {
            registry,
            mcp,
            proxy,
        }
    }

    /// Closes the connections to the apps' tools.
    pub(crate) async fn shutdown(&self) {
        self.mcp.shutdown().await;
    }
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
