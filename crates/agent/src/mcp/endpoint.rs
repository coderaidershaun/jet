//! Where the client finds each tool server it is asked about, and the headers that its requests
//! carry, so that registered apps and servers that need a key share one client.
use super::{McpError, http::failure};
use crate::apps::{AppId, Registry};
use std::sync::Mutex;

/// The address of one tool server and the headers sent with each request to it. A header value
/// can hold a key, so the `Debug` print names the headers and hides their values.
#[derive(Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub url: String,
    pub headers: Vec<(String, String)>,
}

impl std::fmt::Debug for Endpoint {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let names: Vec<&str> = self.headers.iter().map(|(name, _)| name.as_str()).collect();
        formatter
            .debug_struct("Endpoint")
            .field("url", &self.url)
            .field("headers", &names)
            .finish()
    }
}

/// Finds the endpoint of a tool server each time the client needs it, so a server that is turned
/// off, removed or given a new key is seen at once.
pub trait Endpoints: Send + Sync {
    /// The endpoint, or [`McpError::Unavailable`] when the server is off, removed or has no tools.
    fn endpoint(&self, id: &AppId) -> Result<Endpoint, McpError>;
}

/// A registered app is reached at its tool address with no extra header.
impl Endpoints for Mutex<Registry> {
    fn endpoint(&self, id: &AppId) -> Result<Endpoint, McpError> {
        let registry = self.lock().map_err(|_| failure("registry lock failed"))?;
        registry
            .get(id)
            .filter(|app| app.enabled)
            .and_then(|app| app.mcp_url.as_ref())
            .map(|url| Endpoint {
                url: url.to_string(),
                headers: Vec::new(),
            })
            .ok_or_else(|| McpError::Unavailable { app_id: id.clone() })
    }
}
