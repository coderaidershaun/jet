//! Keep one negotiated HTTP connection per registered endpoint.
use super::{McpError, McpFuture, McpService, ToolCatalogue, ToolRequest, ToolResult};
use crate::apps::{AppId, Registry};
use rmcp::{
    ClientHandler, RoleClient, ServiceExt,
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
use tokio::sync::Mutex as AsyncMutex;

pub(super) const DEADLINE: Duration = Duration::from_secs(15);
pub(super) const MAX_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Default)]
pub(super) struct Notifications(pub Arc<AtomicU64>);
impl ClientHandler for Notifications {
    async fn on_tool_list_changed(&self, _: NotificationContext<RoleClient>) {
        self.0.fetch_add(1, Ordering::SeqCst);
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
        for (_, sender) in self
            .calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .drain()
        {
            if let Some(sender) = sender {
                let _ = sender.send(());
            }
        }
        self.apps.lock().await.clear();
    }
}
impl McpService for HttpMcpClient {
    fn catalogue<'a>(&'a self, app_id: &'a AppId) -> McpFuture<'a, ToolCatalogue> {
        Box::pin(self.load(app_id, false))
    }
    fn refresh<'a>(&'a self, app_id: &'a AppId) -> McpFuture<'a, ToolCatalogue> {
        Box::pin(self.load(app_id, true))
    }
    fn call(&self, request: ToolRequest) -> McpFuture<'_, ToolResult> {
        self.prepare(request, super::dispatch::Purpose::Call)
    }
    fn discover(&self, request: ToolRequest) -> McpFuture<'_, ToolResult> {
        self.prepare(request, super::dispatch::Purpose::Discovery)
    }
    fn cancel<'a>(&'a self, request_id: &'a str) -> McpFuture<'a, ()> {
        self.cancel_request(request_id);
        Box::pin(async { Ok(()) })
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
