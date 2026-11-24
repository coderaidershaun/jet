//! Bind the stable provider tool surface to one initiating browser turn, acting for the user who
//! sent its message: their apps, their files and their credentials only.
mod handler;
mod handoff;
mod marks;
mod objectives;
mod tools;

use crate::account::Keys;
use crate::apps::Apps;
use crate::chat::{ChatState, Chats, TurnContext, TurnOwner, TurnTools};
use crate::evidence::Evidence;
use crate::files::Files;
use crate::lock;
use crate::objectives::Objectives;
use agent::{McpConnection, TurnIdentity, mcp::HttpMcpClient};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{Query, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::post,
};
use rmcp::transport::streamable_http_server::{
    StreamableHttpService, session::local::LocalSessionManager,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, Weak},
};

pub(crate) const HEADER: &str = agent::TURN_HEADER;
#[derive(Clone)]
struct Binding {
    turn: TurnContext,
    calls: HashSet<String>,
    /// The provider may search and read the web in this turn.
    reads_web: bool,
    /// The signed-in user who sent the message, and the chat the turn runs in. Every tool acts
    /// for that user only.
    owner: TurnOwner,
    /// `github_activity` ran in this turn, so it has read text written by strangers.
    has_read_github: bool,
}
pub(crate) struct Facade {
    apps: Apps,
    mcp: Arc<HttpMcpClient>,
    files: Files,
    pub(crate) chats: Mutex<Weak<Chats>>,
    url: Mutex<String>,
    public_origin: Option<String>,
    keys: Keys,
    evidence: Evidence,
    objectives: Objectives,
    bindings: Mutex<HashMap<String, Binding>>,
    sessions: Mutex<HashMap<String, String>>,
}
impl Facade {
    pub fn new(
        apps: Apps,
        files: Files,
        url: String,
        public_origin: Option<String>,
        keys: Keys,
        evidence: Evidence,
        objectives: Objectives,
    ) -> Arc<Self> {
        Arc::new(Self {
            mcp: apps.mcp().clone(),
            apps,
            files,
            chats: Mutex::new(Weak::new()),
            url: Mutex::new(url),
            public_origin,
            keys,
            evidence,
            objectives,
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
    fn binding(&self, token: &str) -> Option<Binding> {
        lock(&self.bindings).get(token).cloned()
    }
    /// The runtime of the chat the turn runs in, while the server is open.
    fn chat_of(&self, binding: &Binding) -> Option<Arc<ChatState>> {
        lock(&self.chats).upgrade()?.open_chat(binding.owner.chat)
    }
    pub fn router(self: &Arc<Self>) -> Router {
        let state = self.clone();
        let service = StreamableHttpService::new(
            move || Ok(handler::Handler(state.clone())),
            Arc::new(LocalSessionManager::default()),
            Default::default(),
        );
        Router::new()
            .route("/web-hook", post(web_hook))
            .nest_service("/mcp", service)
            .layer(middleware::from_fn_with_state(self.clone(), authorize))
    }
}
impl TurnTools for Facade {
    fn bind(&self, identity: &TurnIdentity, reads_web: bool, owner: TurnOwner) -> McpConnection {
        let token = uuid::Uuid::new_v4().to_string();
        lock(&self.bindings).insert(
            token.clone(),
            Binding {
                turn: TurnContext::from(identity),
                calls: HashSet::new(),
                reads_web,
                owner,
                has_read_github: false,
            },
        );
        McpConnection {
            url: lock(&self.url).clone(),
            token,
        }
    }
    fn revoke(&self, owner: TurnOwner, request_id: &str) {
        let mut bindings = lock(&self.bindings);
        let tokens: Vec<_> = bindings
            .iter()
            .filter(|(_, binding)| binding.owner == owner && binding.turn.request_id == request_id)
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
    fn shutdown(&self) {
        let requests: Vec<_> = lock(&self.bindings)
            .values()
            .map(|binding| (binding.owner, binding.turn.request_id.clone()))
            .collect();
        for (owner, request) in requests {
            self.revoke(owner, &request);
        }
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

/// Claude Code asks here before each page read, with the hosts of the turn in the `hosts` query.
/// Any other address, and any request that cannot be read, is refused, and the reason tells Jet to
/// ask for the link.
async fn web_hook(Query(query): Query<HashMap<String, String>>, body: Bytes) -> Json<Value> {
    let hosts = query.get("hosts").map_or("", String::as_str);
    let host = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|input| url::Url::parse(input["tool_input"]["url"].as_str()?).ok())
        .and_then(|url| url.host_str().map(str::to_owned));
    if host.is_some_and(|host| hosts.split(',').any(|allowed| allowed == host)) {
        // No decision: Claude Code's own allow rule for the host still has to pass.
        return Json(json!({}));
    }
    Json(json!({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": "Jet reads pages only on sites whose link the user wrote in this chat or that an objective of this chat names. The user can paste the link to this page here, so ask them to.",
    }}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_refused_page_says_the_user_can_paste_the_link() {
        let hook =
            serde_json::to_vec(&json!({"tool_input": {"url": "https://other.example/page"}}))
                .unwrap();
        let query = HashMap::from([("hosts".to_owned(), "docs.rs,github.com".to_owned())]);
        let Json(refused) = web_hook(Query(query.clone()), hook.clone().into()).await;
        let reason = refused["hookSpecificOutput"]["permissionDecisionReason"]
            .as_str()
            .unwrap();
        assert!(reason.contains("The user can paste the link"), "{reason}");
        assert!(reason.contains("objective"), "{reason}");

        let allowed =
            serde_json::to_vec(&json!({"tool_input": {"url": "https://Docs.rs/serde"}})).unwrap();
        assert_eq!(web_hook(Query(query), allowed.into()).await.0, json!({}));
    }
}
