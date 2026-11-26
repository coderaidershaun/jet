//! The OAuth authorization server of the MCP stand-in: its metadata, client registration, a
//! sign-in page that approves at once, and the token endpoint, with the checks the MCP specification asks for.
use axum::response::IntoResponse;
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
};

/// A client the sign-in server knows: its secret, if it has one, and the redirect addresses it may use.
struct Client {
    secret: Option<String>,
    redirects: Vec<String>,
}

/// What a code was given for.
struct Grant {
    client: String,
    redirect: String,
    challenge: String,
    resource: String,
}

/// The fixture's own OAuth authorization server. It refuses an authorization or token request with
/// no `resource`, refuses a code without the PKCE verifier of its challenge, and can stop letting
/// clients register, expire every access token and revoke every refresh token.
pub struct OAuth {
    /// Whether the metadata offers dynamic client registration.
    pub registration: AtomicBool,
    clients: Mutex<HashMap<String, Client>>,
    codes: Mutex<HashMap<String, Grant>>,
    access: Mutex<Vec<String>>,
    refresh: Mutex<Vec<String>>,
    /// How many times a refresh token was traded for a new access token.
    pub refreshes: AtomicUsize,
    /// How long, in seconds, it says each new access token lasts.
    pub expires_in: AtomicU64,
    /// Every code, token, verifier and client secret it gave out or was sent.
    secrets: Mutex<Vec<String>>,
    /// Why it refused each request it refused.
    pub refusals: Mutex<Vec<String>>,
    counter: AtomicUsize,
}
impl Default for OAuth {
    fn default() -> Self {
        Self {
            registration: AtomicBool::new(true),
            clients: Mutex::default(),
            codes: Mutex::default(),
            access: Mutex::default(),
            refresh: Mutex::default(),
            refreshes: AtomicUsize::default(),
            expires_in: AtomicU64::new(3600),
            secrets: Mutex::default(),
            refusals: Mutex::default(),
            counter: AtomicUsize::default(),
        }
    }
}
type Answer = axum::response::Response;
impl OAuth {
    pub fn is_live(&self, token: &str) -> bool {
        self.access.lock().unwrap().iter().any(|live| live == token)
    }
    /// Every access token given so far stops working, as when each one runs out.
    pub fn expire_access(&self) {
        self.access.lock().unwrap().clear();
    }
    /// Every refresh token given so far stops working, as when the user revokes Jet.
    pub fn revoke_refresh(&self) {
        self.refresh.lock().unwrap().clear();
    }
    /// A client made by hand in the provider's console, with the redirect address it may use.
    pub fn add_client(&self, id: &str, secret: Option<&str>, redirect: &str) {
        self.clients.lock().unwrap().insert(
            id.to_owned(),
            Client {
                secret: secret.map(str::to_owned),
                redirects: vec![redirect.to_owned()],
            },
        );
        self.secrets
            .lock()
            .unwrap()
            .extend(secret.map(str::to_owned));
    }
    pub fn secrets(&self) -> Vec<String> {
        self.secrets.lock().unwrap().clone()
    }
    fn mint(&self, kind: &str) -> String {
        let made = format!(
            "{kind}-{}-{:x}",
            self.counter.fetch_add(1, Ordering::SeqCst),
            rand_suffix()
        );
        self.secrets.lock().unwrap().push(made.clone());
        made
    }
    fn refuse(&self, status: u16, error: &str, why: &str) -> Answer {
        self.refusals.lock().unwrap().push(why.to_owned());
        let status = axum::http::StatusCode::from_u16(status).unwrap();
        (
            status,
            axum::Json(json!({"error":error,"error_description":why})),
        )
            .into_response()
    }
    pub fn router(self: &Arc<Self>, base: &str) -> axum::Router {
        use axum::routing::{get, post};
        let resource = format!("{base}mcp");
        let issuer = format!("{base}auth");
        let metadata = {
            let (oauth, issuer) = (self.clone(), issuer.clone());
            move || {
                let mut document = json!({"issuer":issuer,"authorization_endpoint":format!("{issuer}/authorize"),"token_endpoint":format!("{issuer}/token"),"code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none","client_secret_basic"]});
                if oauth.registration.load(Ordering::SeqCst) {
                    document["registration_endpoint"] = json!(format!("{issuer}/register"));
                }
                async move { axum::Json(document) }
            }
        };
        let protected = {
            let (resource, issuer) = (resource.clone(), issuer.clone());
            move || async move {
                axum::Json(
                    json!({"resource":resource,"authorization_servers":[issuer],"scopes_supported":["tools.read"]}),
                )
            }
        };
        let (register, authorize, token) = (self.clone(), self.clone(), self.clone());
        axum::Router::new()
            .route("/.well-known/oauth-protected-resource/mcp", get(protected))
            .route("/.well-known/oauth-authorization-server/auth", get(metadata))
            .route("/auth/register", post(move |axum::Json(body): axum::Json<Value>| async move { register.register(&body) }))
            .route("/auth/authorize", get(move |query: axum::extract::RawQuery| async move { authorize.authorize(&query.0.unwrap_or_default(), &resource) }))
            .route("/auth/token", post(move |headers: axum::http::HeaderMap, body: String| async move { token.token(&headers, &body) }))
    }
    fn register(&self, body: &Value) -> Answer {
        if !self.registration.load(Ordering::SeqCst) {
            return self.refuse(400, "invalid_client_metadata", "registration is turned off");
        }
        let redirects: Vec<String> = body["redirect_uris"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|uri| uri.as_str().map(str::to_owned))
            .collect();
        if redirects.is_empty() || body["token_endpoint_auth_method"] != "none" {
            return self.refuse(
                400,
                "invalid_client_metadata",
                "a public client with a redirect address",
            );
        }
        let id = format!("client-{}", self.counter.fetch_add(1, Ordering::SeqCst));
        self.clients.lock().unwrap().insert(
            id.clone(),
            Client {
                secret: None,
                redirects,
            },
        );
        (
            axum::http::StatusCode::CREATED,
            axum::Json(json!({"client_id":id})),
        )
            .into_response()
    }
    /// The user's sign-in, approved at once: back to the redirect address with a code and the state.
    fn authorize(&self, query: &str, resource: &str) -> Answer {
        let pairs: HashMap<String, String> = url::form_urlencoded::parse(query.as_bytes())
            .into_owned()
            .collect();
        let get = |key: &str| pairs.get(key).cloned().unwrap_or_default();
        let known = self
            .clients
            .lock()
            .unwrap()
            .get(&get("client_id"))
            .is_some_and(|client| client.redirects.contains(&get("redirect_uri")));
        if !known {
            return self.refuse(400, "invalid_request", "unknown client or redirect address");
        }
        if get("resource") != resource {
            return self.refuse(
                400,
                "invalid_target",
                "the authorization request has no resource, or another one",
            );
        }
        if get("code_challenge_method") != "S256"
            || get("code_challenge").is_empty()
            || get("response_type") != "code"
            || get("state").is_empty()
        {
            return self.refuse(
                400,
                "invalid_request",
                "the authorization request has no S256 challenge or state",
            );
        }
        let code = self.mint("code");
        self.codes.lock().unwrap().insert(
            code.clone(),
            Grant {
                client: get("client_id"),
                redirect: get("redirect_uri"),
                challenge: get("code_challenge"),
                resource: get("resource"),
            },
        );
        let mut back = url::Url::parse(&get("redirect_uri")).unwrap();
        back.query_pairs_mut()
            .append_pair("code", &code)
            .append_pair("state", &get("state"));
        (
            axum::http::StatusCode::FOUND,
            [("location", back.to_string())],
        )
            .into_response()
    }
    fn token(&self, headers: &axum::http::HeaderMap, body: &str) -> Answer {
        let pairs: HashMap<String, String> = url::form_urlencoded::parse(body.as_bytes())
            .into_owned()
            .collect();
        let get = |key: &str| pairs.get(key).cloned().unwrap_or_default();
        let client_id = get("client_id");
        let secret = self
            .clients
            .lock()
            .unwrap()
            .get(&client_id)
            .map(|client| client.secret.clone());
        let Some(secret) = secret else {
            return self.refuse(401, "invalid_client", "unknown client");
        };
        if let Some(secret) = secret {
            let basic =
                base64::engine::general_purpose::STANDARD.encode(format!("{client_id}:{secret}"));
            let sent = headers
                .get("authorization")
                .and_then(|value| value.to_str().ok());
            if sent != Some(format!("Basic {basic}").as_str()) {
                return self.refuse(
                    401,
                    "invalid_client",
                    "the client secret is missing or wrong",
                );
            }
        }
        if get("resource").is_empty() {
            return self.refuse(400, "invalid_target", "the token request has no resource");
        }
        match get("grant_type").as_str() {
            "authorization_code" => {
                let Some(grant) = self.codes.lock().unwrap().remove(&get("code")) else {
                    return self.refuse(400, "invalid_grant", "unknown or used code");
                };
                let verifier = get("code_verifier");
                if verifier.is_empty() {
                    return self.refuse(
                        400,
                        "invalid_request",
                        "the token request has no code_verifier",
                    );
                }
                self.secrets.lock().unwrap().push(verifier.clone());
                let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(Sha256::digest(verifier.as_bytes()));
                if challenge != grant.challenge
                    || grant.client != client_id
                    || grant.redirect != get("redirect_uri")
                    || grant.resource != get("resource")
                {
                    return self.refuse(400, "invalid_grant", "the verifier, client, redirect address or resource does not match the code");
                }
            }
            "refresh_token" => {
                let sent = get("refresh_token");
                let mut live = self.refresh.lock().unwrap();
                let Some(at) = live.iter().position(|token| *token == sent) else {
                    return self.refuse(400, "invalid_grant", "unknown or revoked refresh token");
                };
                live.remove(at);
                self.refreshes.fetch_add(1, Ordering::SeqCst);
            }
            _ => return self.refuse(400, "unsupported_grant_type", "unknown grant type"),
        }
        let (access, refresh) = (self.mint("access"), self.mint("refresh"));
        self.access.lock().unwrap().push(access.clone());
        self.refresh.lock().unwrap().push(refresh.clone());
        axum::Json(json!({"access_token":access,"token_type":"Bearer","expires_in":self.expires_in.load(Ordering::SeqCst),"refresh_token":refresh,"scope":"tools.read"})).into_response()
    }
}
/// A few random hex digits, so a test that leaks a token cannot be fooled by a token another test made.
fn rand_suffix() -> u64 {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).unwrap();
    u64::from_le_bytes(bytes)
}
