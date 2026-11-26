//! Keep one negotiated HTTP connection per registered endpoint, to an address its owner may reach.
use super::{
    Endpoint, Endpoints, McpError, Progress, ToolCatalogue, ToolRequest, ToolResult,
    dispatch::Purpose,
};
use crate::apps::{AppId, Reach, is_server_side, is_server_side_ip};
use rmcp::{
    ClientHandler, RoleClient, ServiceExt,
    model::{ProgressNotificationParam, ProgressToken},
    service::{NotificationContext, RunningService},
};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, RwLock, mpsc};

pub(super) const DEADLINE: Duration = Duration::from_secs(15);
pub(super) const MAX_BYTES: usize = 2 * 1024 * 1024;

pub(super) type ProgressListeners = Arc<Mutex<HashMap<ProgressToken, mpsc::Sender<Progress>>>>;

/// What one connection hears from its server. The progress tokens belong to the connection, so
/// the listeners do too.
#[derive(Clone, Default)]
pub(super) struct Notifications {
    tool_list_changes: Arc<AtomicU64>,
    pub(super) listeners: ProgressListeners,
    /// A call holds this for writing from before it is sent until its listener is in place. A
    /// progress update waits on it, so none can be handled before the listener exists.
    pub(super) registering: Arc<RwLock<()>>,
}
impl Notifications {
    /// How many times the server has said its tool list changed.
    pub(super) fn tool_list_generation(&self) -> u64 {
        self.tool_list_changes.load(Ordering::SeqCst)
    }
}
impl ClientHandler for Notifications {
    async fn on_tool_list_changed(&self, _: NotificationContext<RoleClient>) {
        self.tool_list_changes.fetch_add(1, Ordering::SeqCst);
    }
    // Progress is lossy: a full queue or a call nobody listens to just drops the update.
    async fn on_progress(
        &self,
        notification: ProgressNotificationParam,
        _: NotificationContext<RoleClient>,
    ) {
        let _registered = self.registering.read().await;
        let token = notification.progress_token.clone();
        let Some(progress) = Progress::from_notification(notification) else {
            return;
        };
        if let Some(listener) = crate::lock(&self.listeners).get(&token) {
            let _ = listener.try_send(progress);
        }
    }
}
pub(super) struct Connection {
    pub endpoint: Endpoint,
    pub running: Arc<RunningService<RoleClient, Notifications>>,
    pub generation: u64,
}
#[derive(Default)]
pub(super) struct AppState {
    pub connection: Option<Connection>,
    pub catalogue: Option<ToolCatalogue>,
}

pub struct HttpMcpClient {
    pub(super) endpoints: Arc<dyn Endpoints>,
    pub(super) apps: AsyncMutex<HashMap<AppId, Arc<AsyncMutex<AppState>>>>,
    pub(super) calls: Arc<Mutex<HashMap<String, Option<tokio::sync::oneshot::Sender<()>>>>>,
}
impl HttpMcpClient {
    pub fn new(endpoints: Arc<dyn Endpoints>) -> Self {
        Self {
            endpoints,
            apps: AsyncMutex::new(HashMap::new()),
            calls: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    pub async fn catalogue(&self, app_id: &AppId) -> Result<ToolCatalogue, McpError> {
        self.load(app_id, false).await
    }
    pub async fn refresh(&self, app_id: &AppId) -> Result<ToolCatalogue, McpError> {
        self.load(app_id, true).await
    }
    /// Rechecks that the app is still enabled when the call is sent, and never sends an
    /// uncertain call a second time.
    pub fn call(
        &self,
        request: ToolRequest,
    ) -> impl Future<Output = Result<ToolResult, McpError>> + Send {
        self.prepare(request, Purpose::Call, None)
    }
    /// Like [`call`](Self::call), and every progress update the tool sends while it runs goes to
    /// `progress`. An update is dropped when the channel is full.
    pub fn call_with_progress(
        &self,
        request: ToolRequest,
        progress: mpsc::Sender<Progress>,
    ) -> impl Future<Output = Result<ToolResult, McpError>> + Send {
        self.prepare(request, Purpose::Call, Some(progress))
    }
    /// Dispatch only tools whose current metadata promises free discovery.
    pub fn discover(
        &self,
        request: ToolRequest,
    ) -> impl Future<Output = Result<ToolResult, McpError>> + Send {
        self.prepare(request, Purpose::Discovery, None)
    }
    /// Dispatch only tools whose current metadata marks them as a job and promises they only
    /// read.
    pub fn status(
        &self,
        request: ToolRequest,
    ) -> impl Future<Output = Result<ToolResult, McpError>> + Send {
        self.prepare(request, Purpose::Status, None)
    }
    pub(super) fn endpoint(&self, id: &AppId) -> Result<Endpoint, McpError> {
        self.endpoints.endpoint(id)
    }
    /// Drops the connection and the tools kept for the server, so the next use connects afresh.
    /// A call already sent keeps its own connection until it ends.
    pub async fn forget(&self, id: &AppId) {
        self.apps.lock().await.remove(id);
    }
    pub(super) async fn state(&self, id: &AppId) -> Arc<AsyncMutex<AppState>> {
        self.apps
            .lock()
            .await
            .entry(id.clone())
            .or_default()
            .clone()
    }
    pub(super) async fn connect(endpoint: Endpoint) -> Result<Connection, McpError> {
        use rmcp::transport::{
            StreamableHttpClientTransport,
            streamable_http_client::StreamableHttpClientTransportConfig,
        };
        // A redirect could take Jet to a service on the server itself that the app's owner may not
        // reach, so none is followed.
        let mut client = reqwest::Client::builder()
            .connect_timeout(DEADLINE)
            .redirect(reqwest::redirect::Policy::none())
            .default_headers(headers(&endpoint)?);
        if endpoint.reach == Reach::PublicOnly {
            let url = url::Url::parse(&endpoint.url).map_err(failure)?;
            if is_server_side(&url) {
                return Err(failure(server_side()));
            }
            client = client.dns_resolver(Arc::new(PublicOnly));
        }
        let client = client.build().map_err(failure)?;
        // A write with an uncertain outcome must never be sent a second time.
        let mut config = StreamableHttpClientTransportConfig::with_uri(endpoint.url.clone());
        config.reinit_on_expired_session = false;
        config.max_sse_event_size = MAX_BYTES;
        let transport = StreamableHttpClientTransport::with_client(client, config);
        let running = tokio::time::timeout(DEADLINE, Notifications::default().serve(transport))
            .await
            .map_err(failure)?
            .map_err(refusal)?;
        Ok(Connection {
            endpoint,
            running: Arc::new(running),
            generation: 0,
        })
    }
    pub fn cancel_request(&self, request_id: &str) {
        // Keep the ID reserved until the cancelled future releases its guard.
        if let Some(sender) = crate::lock(&self.calls)
            .get_mut(request_id)
            .and_then(Option::take)
        {
            let _ = sender.send(());
        }
    }
    pub async fn shutdown(&self) {
        for sender in crate::lock(&self.calls)
            .drain()
            .filter_map(|(_, sender)| sender)
        {
            let _ = sender.send(());
        }
        self.apps.lock().await.clear();
    }
}
/// Looks up the names a server of an owner who may only reach public addresses is at, and refuses
/// one that now points at the server itself or its private network.
struct PublicOnly;
impl reqwest::dns::Resolve for PublicOnly {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        Box::pin(async move {
            let addresses: Vec<std::net::SocketAddr> =
                tokio::net::lookup_host((name.as_str(), 0)).await?.collect();
            if addresses
                .iter()
                .any(|address| is_server_side_ip(address.ip()))
            {
                return Err(server_side().into());
            }
            let addresses: reqwest::dns::Addrs = Box::new(addresses.into_iter());
            Ok(addresses)
        })
    }
}
fn server_side() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        "the tool server's address is on the server or its private network, which only an admin's server may reach",
    )
}
/// The endpoint's headers, each value marked sensitive so the HTTP library never prints it.
fn headers(endpoint: &Endpoint) -> Result<reqwest::header::HeaderMap, McpError> {
    use reqwest::header::{HeaderName, HeaderValue};
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in &endpoint.headers {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| failure(format!("{name:?} is not a valid header name")))?;
        let mut value = HeaderValue::from_str(value)
            .map_err(|_| failure(format!("the value of header {name} is not valid")))?;
        value.set_sensitive(true);
        headers.insert(name, value);
    }
    Ok(headers)
}

/// Why the server would not start a session: [`McpError::Unauthorized`] when it asked for
/// credentials (HTTP 401) or refused the ones sent (HTTP 403), else the deepest cause in words.
fn refusal(error: rmcp::service::ClientInitializeError) -> McpError {
    use rmcp::service::ClientInitializeError;
    // The transport's own error is a field that the error does not name as its source.
    match &error {
        ClientInitializeError::TransportError { error, .. } => classify(&*error.error),
        other => classify(other),
    }
}

/// [`McpError::Unauthorized`] when the error, or one that caused it, is the server asking for
/// credentials or refusing them, else the deepest cause in words.
fn classify(mut cause: &(dyn std::error::Error + 'static)) -> McpError {
    use rmcp::transport::streamable_http_client::StreamableHttpError;
    loop {
        if let Some(
            StreamableHttpError::AuthRequired(_) | StreamableHttpError::InsufficientScope(_),
        ) = cause.downcast_ref::<StreamableHttpError<reqwest::Error>>()
        {
            return McpError::Unauthorized;
        }
        match cause.source() {
            Some(source) => cause = source,
            None => return failure(cause),
        }
    }
}
pub(super) fn failure(error: impl std::fmt::Display) -> McpError {
    McpError::Transport {
        message: error.to_string(),
    }
}
pub(super) fn protocol(error: rmcp::ServiceError) -> McpError {
    match error {
        rmcp::ServiceError::McpError(error) => McpError::Protocol {
            code: error.code.0,
            message: error.message.into_owned(),
            data: error.data,
        },
        rmcp::ServiceError::TransportSend(error) => classify(&*error.error),
        error => failure(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::dns::Resolve;

    #[tokio::test]
    async fn a_name_that_points_at_the_server_is_refused_when_it_is_looked_up() {
        let name = "localhost".parse().unwrap();
        let refused = PublicOnly.resolve(name).await.err().unwrap();
        assert!(refused.to_string().contains("private network"), "{refused}");
    }
}
