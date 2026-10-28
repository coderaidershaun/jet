//! Bind the stable provider tool surface to one initiating browser turn.
mod handler;
mod handoff;
mod tools;

use crate::chat::{ChatState, lock};
use crate::files::Files;
use agent::{McpConnection, TurnIdentity, apps::Registry, mcp::HttpMcpClient};
use axum::{
    Router,
    extract::{Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use rmcp::transport::streamable_http_server::{
    StreamableHttpService, session::local::LocalSessionManager,
};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, Weak},
};

pub(crate) const HEADER: &str = agent::TURN_HEADER;
#[derive(Clone)]
pub(crate) struct Binding {
    pub turn_id: String,
    pub request_id: String,
    pub client_id: String,
    calls: HashSet<String>,
}
pub(crate) struct Facade {
    pub registry: Arc<Mutex<Registry>>,
    pub mcp: Arc<HttpMcpClient>,
    files: Files,
    pub chat: Mutex<Weak<ChatState>>,
    url: Mutex<String>,
    public_origin: Option<String>,
    bindings: Mutex<HashMap<String, Binding>>,
    sessions: Mutex<HashMap<String, String>>,
}
impl Facade {
    pub fn new(
        registry: Arc<Mutex<Registry>>,
        mcp: Arc<HttpMcpClient>,
        files: Files,
        url: String,
        public_origin: Option<String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            registry,
            mcp,
            files,
            chat: Mutex::new(Weak::new()),
            url: Mutex::new(url),
            public_origin,
            bindings: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
        })
    }
    pub fn set_url(&self, url: String) {
        *lock(&self.url) = url;
    }
    /// The origin that serves Jet's files to other programs: the public origin when one is set,
    /// else the origin of the address the server is really listening on.
    fn origin(&self) -> Result<String, url::ParseError> {
        if let Some(origin) = &self.public_origin {
            return Ok(origin.clone());
        }
        Ok(url::Url::parse(&lock(&self.url))?
            .origin()
            .ascii_serialization())
    }
    pub fn bind(&self, identity: &TurnIdentity) -> McpConnection {
        let token = uuid::Uuid::new_v4().to_string();
        lock(&self.bindings).insert(
            token.clone(),
            Binding {
                turn_id: identity.turn_id.clone(),
                request_id: identity.request_id.clone(),
                client_id: identity.client_id.clone(),
                calls: HashSet::new(),
            },
        );
        McpConnection {
            url: lock(&self.url).clone(),
            token,
        }
    }
    pub fn binding(&self, token: &str) -> Option<Binding> {
        lock(&self.bindings).get(token).cloned()
    }
    pub fn revoke(&self, request: &str) {
        let mut bindings = lock(&self.bindings);
        let tokens: Vec<_> = bindings
            .iter()
            .filter(|(_, binding)| binding.request_id == request)
            .map(|(token, _)| token.clone())
            .collect();
        for token in tokens {
            if let Some(binding) = bindings.remove(&token) {
                for id in binding.calls {
                    self.mcp.cancel_request(&id);
                }
            }
            lock(&self.sessions).retain(|_, bound| bound != &token);
        }
    }
    pub fn shutdown(&self) {
        let requests: Vec<_> = lock(&self.bindings)
            .values()
            .map(|binding| binding.request_id.clone())
            .collect();
        for request in requests {
            self.revoke(&request);
        }
    }
    pub fn router(self: &Arc<Self>) -> Router {
        let state = self.clone();
        let service = StreamableHttpService::new(
            move || Ok(handler::Handler(state.clone())),
            Arc::new(LocalSessionManager::default()),
            Default::default(),
        );
        Router::new()
            .nest_service("/mcp", service)
            .layer(middleware::from_fn_with_state(self.clone(), authorize))
    }
}
async fn authorize(State(facade): State<Arc<Facade>>, request: Request, next: Next) -> Response {
    let Some(token) = request
        .headers()
        .get(HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if facade.binding(&token).is_none() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if let Some(session) = request
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        && lock(&facade.sessions).get(session) != Some(&token)
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let response = next.run(request).await;
    if let Some(session) = response
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
    {
        let bindings = lock(&facade.bindings);
        if bindings.contains_key(&token) {
            lock(&facade.sessions).insert(session.to_owned(), token);
        }
    }
    response
}
