//! Where the client finds each tool server it is asked about, the headers that its requests carry,
//! and who renews a sign-in and hears what each connection found, so apps and servers share one client.
use super::{McpError, ToolCatalogue, http::failure};
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

/// What [`Endpoints::renew`] is asked to do.
pub enum Renewal<'a> {
    /// Jet is about to use the server: renew credentials that have run out.
    BeforeUse,
    /// The server refused the credentials of this endpoint.
    Refused(&'a Endpoint),
}

pub type RenewFuture<'a> =
    std::pin::Pin<Box<dyn Future<Output = Result<bool, McpError>> + Send + 'a>>;

/// Finds the endpoint of a tool server each time the client needs it, so a server that is turned
/// off, removed or given a new key is seen at once.
pub trait Endpoints: Send + Sync {
    /// The endpoint, or [`McpError::Unavailable`] when the server is off, removed or has no tools.
    fn endpoint(&self, id: &AppId) -> Result<Endpoint, McpError>;

    /// Renews the server's credentials. True when there are new ones to try; an error says why the
    /// server cannot be used until the user signs in again.
    fn renew<'a>(&'a self, _id: &'a AppId, _renewal: Renewal<'a>) -> RenewFuture<'a> {
        Box::pin(async { Ok(false) })
    }

    /// Hears what each fresh connection or tool listing found, so a server that stopped working
    /// shows as soon as Jet sees it.
    fn observed(&self, _id: &AppId, _found: Result<&ToolCatalogue, &McpError>) {}
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
