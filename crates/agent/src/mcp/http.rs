//! Keep one negotiated HTTP connection per registered endpoint.
use super::{McpError, Progress, ToolCatalogue, ToolRequest, ToolResult, dispatch::Purpose};
use crate::apps::{AppId, Registry};
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
use tokio::sync::{Mutex as AsyncMutex, mpsc};

pub(super) const DEADLINE: Duration = Duration::from_secs(15);
pub(super) const MAX_BYTES: usize = 2 * 1024 * 1024;

pub(super) type ProgressListeners = Arc<Mutex<HashMap<ProgressToken, mpsc::Sender<Progress>>>>;

/// What one connection hears from its server. The progress tokens belong to the connection, so
/// the listeners do too.
#[derive(Clone, Default)]
pub(super) struct Notifications {
    tool_list_changes: Arc<AtomicU64>,
    pub(super) listeners: ProgressListeners,
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
        let token = notification.progress_token.clone();
        let Some(progress) = Progress::from_notification(notification) else {
            return;
        };
        if let Some(listener) = self
            .listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&token)
        {
            let _ = listener.try_send(progress);
        }
    }
}
pub(super) struct Connection {
    pub endpoint: String,
    pub running: Arc<RunningService<RoleClient, Notifications>>,
    pub generation: u64,
}
#[derive(Default)]
pub(super) struct AppState {
    pub connection: Option<Connection>,
    pub catalogue: Option<ToolCatalogue>,
}

pub struct HttpMcpClient {
    pub(super) registry: Arc<Mutex<Registry>>,
    pub(super) apps: AsyncMutex<HashMap<AppId, Arc<AsyncMutex<AppState>>>>,
    pub(super) calls: Arc<Mutex<HashMap<String, Option<tokio::sync::oneshot::Sender<()>>>>>,
}
impl HttpMcpClient {
    pub fn new(registry: Arc<Mutex<Registry>>) -> Self {
        Self {
            registry,
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
    pub(super) fn endpoint(&self, id: &AppId) -> Result<String, McpError> {
        let registry = self
            .registry
            .lock()
            .map_err(|_| failure("registry lock failed"))?;
        registry
            .get(id)
            .filter(|app| app.enabled)
            .and_then(|app| app.mcp_url.as_ref())
            .map(ToString::to_string)
            .ok_or_else(|| McpError::Unavailable { app_id: id.clone() })
    }
    pub(super) async fn state(&self, id: &AppId) -> Arc<AsyncMutex<AppState>> {
        self.apps
            .lock()
            .await
            .entry(id.clone())
            .or_default()
            .clone()
    }
    pub(super) async fn connect(endpoint: String) -> Result<Connection, McpError> {
        use rmcp::transport::{
            StreamableHttpClientTransport,
            streamable_http_client::StreamableHttpClientTransportConfig,
        };
        let client = reqwest::Client::builder()
            .connect_timeout(DEADLINE)
            .build()
            .map_err(failure)?;
        // A write with an uncertain outcome must never be sent a second time.
        let mut config = StreamableHttpClientTransportConfig::with_uri(endpoint.clone());
        config.reinit_on_expired_session = false;
        config.max_sse_event_size = MAX_BYTES;
        let transport = StreamableHttpClientTransport::with_client(client, config);
        let running = tokio::time::timeout(DEADLINE, Notifications::default().serve(transport))
            .await
            .map_err(failure)?
            .map_err(failure)?;
        Ok(Connection {
            endpoint,
            running: Arc::new(running),
            generation: 0,
        })
    }
    pub fn cancel_request(&self, request_id: &str) {
        // Keep the ID reserved until the cancelled future releases its guard.
        if let Some(sender) = self
            .calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get_mut(request_id)
            .and_then(Option::take)
        {
            let _ = sender.send(());
        }
    }
    pub async fn shutdown(&self) {
        for sender in self
            .calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .drain()
            .filter_map(|(_, sender)| sender)
        {
            let _ = sender.send(());
        }
        self.apps.lock().await.clear();
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
        error => failure(error),
    }
}
