//! Signs a user's MCP server in with OAuth: starts the sign-in, finishes it when the provider sends
//! the user back, renews the access token when it runs out, and signs out.

use super::{
    McpServerError, McpServers,
    oauth::{self, Client, OAuthHttp, Pkce, SignInError},
};
use crate::{
    objectives::Clock,
    on_worker,
    seal::Sealer,
    store::{McpServer, SealedTokens, SignInSetup, SignInStart, Store, UserId},
};
use agent::{
    apps::AppId,
    mcp::{McpError, Renewal},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use url::Url;

/// How long a started sign-in waits for the user, in seconds.
const START_SECONDS: u64 = 10 * 60;
/// An access token is renewed before use this long before it runs out, in seconds, or at half its
/// life when it lasts less than twice that.
const RENEW_EARLY_SECONDS: u64 = 30;
/// Where the provider sends the user back to, below Jet's own address.
pub(crate) const RETURN_PATH: &str = "/mcp-signin/return";

/// A client the user made in the provider's console. It has no `Debug` print, so the secret cannot
/// reach a log line.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PastedClient {
    client_id: String,
    client_secret: Option<String>,
}

/// What a sealed secret is for. Each is sealed with its own purpose, so a sealed value copied to
/// another column or row does not open.
#[derive(Clone, Copy)]
enum Purpose {
    Access,
    Refresh,
    ClientSecret,
    Verifier,
}

/// The tokens of every server's sign-in: sealed when they are kept, opened for each request, and
/// renewed one server at a time.
#[derive(Clone)]
pub(super) struct Credentials {
    store: Store,
    sealer: Sealer,
    clock: Clock,
    renewing: Arc<Mutex<HashMap<AppId, Arc<tokio::sync::Mutex<()>>>>>,
}

impl Credentials {
    pub(super) fn new(store: Store, sealer: Sealer, clock: Clock) -> Self {
        Self {
            store,
            sealer,
            clock,
            renewing: Arc::default(),
        }
    }

    fn seal(&self, user: UserId, id: &AppId, purpose: Purpose, secret: &str) -> Vec<u8> {
        self.sealer
            .seal(&owner(user, id, purpose), secret.as_bytes())
    }

    fn open(&self, user: UserId, id: &AppId, purpose: Purpose, sealed: &[u8]) -> Option<String> {
        let opened = self.sealer.unseal(&owner(user, id, purpose), sealed)?;
        String::from_utf8(opened).ok()
    }

    /// The `Authorization` header of a server's sign-in.
    pub(super) fn bearer(
        &self,
        user: UserId,
        id: &AppId,
        sealed_access: &[u8],
    ) -> Result<(String, String), McpError> {
        let access = self
            .open(user, id, Purpose::Access, sealed_access)
            .ok_or_else(|| McpError::SignInEnded {
                message: "the server's token key changed, so Jet can no longer read the sign-in; sign in again".into(),
            })?;
        Ok(("Authorization".to_owned(), format!("Bearer {access}")))
    }

    fn tokens(
        &self,
        user: UserId,
        id: &AppId,
        tokens: &oauth::Tokens,
        kept_refresh: Option<Vec<u8>>,
    ) -> SealedTokens {
        let now = (self.clock)();
        SealedTokens {
            access: self.seal(user, id, Purpose::Access, &tokens.access),
            refresh: tokens
                .refresh
                .as_deref()
                .map(|refresh| self.seal(user, id, Purpose::Refresh, refresh))
                .or(kept_refresh),
            renew_at: tokens.expires_in.map(|lasts| {
                let early = RENEW_EARLY_SECONDS.min(lasts / 2);
                seconds_since_1970(now.saturating_add(lasts - early))
            }),
        }
    }

    /// Renews the access token of a server's sign-in: before use when it has run out, or when the
    /// server refused it. True when there is a new token to try. A sign-in the provider ended is
    /// forgotten, and the error says so in plain words.
    pub(super) async fn renew(&self, id: &AppId, renewal: Renewal<'_>) -> Result<bool, McpError> {
        let lock = crate::lock(&self.renewing)
            .entry(id.clone())
            .or_default()
            .clone();
        let _renewing = lock.lock().await;
        let (store, read) = (self.store.clone(), id.clone());
        let stored = on_worker(move || store.mcp_sign_in(&read))
            .await
            .map_err(|error| store_failure(&error))?
            .map_err(|error| store_failure(&error))?;
        let Some(stored) = stored else {
            return Ok(false);
        };
        let Some(tokens) = stored.tokens else {
            return Ok(false);
        };
        let header = self.bearer(stored.user, id, &tokens.access)?;
        match renewal {
            Renewal::BeforeUse => {
                let now = seconds_since_1970((self.clock)());
                let fresh = tokens.renew_at.is_none_or(|at| at > now);
                if fresh || tokens.refresh.is_none() {
                    return Ok(false);
                }
            }
            // Another call renewed the token since this one was refused.
            Renewal::Refused(refused) if !refused.headers.contains(&header) => return Ok(true),
            Renewal::Refused(_) => {}
        }
        let host = host_of(&stored.url);
        let ended = |message: String| McpError::SignInEnded { message };
        let Some(refresh) = tokens
            .refresh
            .as_ref()
            .and_then(|sealed| self.open(stored.user, id, Purpose::Refresh, sealed))
        else {
            self.forget(id).await?;
            return Err(ended(format!(
                "the sign-in to {host} ran out and {host} gave Jet no way to renew it; sign in again in Settings, under MCP"
            )));
        };
        let setup = &stored.setup;
        let secret = setup
            .sealed_client_secret
            .as_ref()
            .and_then(|sealed| self.open(stored.user, id, Purpose::ClientSecret, sealed));
        let client = Client {
            id: &setup.client_id,
            secret: secret.as_deref(),
            secret_in_body: setup.secret_in_body,
        };
        let server = Url::parse(&stored.url).map_err(|error| store_failure(&error))?;
        let http = OAuthHttp::new(&server).map_err(|error| renew_failure(&error))?;
        let renewed = http
            .refresh(&setup.token_endpoint, &client, &setup.resource, &refresh)
            .await;
        match renewed {
            Ok(renewed) => {
                let sealed = self.tokens(stored.user, id, &renewed, tokens.refresh.clone());
                let (store, saved) = (self.store.clone(), id.clone());
                let kept = on_worker(move || store.renew_mcp_tokens(&saved, &sealed))
                    .await
                    .map_err(|error| store_failure(&error))?
                    .map_err(|error| store_failure(&error))?;
                Ok(kept)
            }
            Err(error) if error.is_client_refused() => {
                let (store, forgotten) = (self.store.clone(), id.clone());
                on_worker(move || store.forget_mcp_client(&forgotten))
                    .await
                    .map_err(|error| store_failure(&error))?
                    .map_err(|error| store_failure(&error))?;
                Err(ended(format!(
                    "the sign-in server of {host} no longer accepts the client Jet signs in with; sign in again in Settings, under MCP"
                )))
            }
            Err(error) if error.is_invalid_grant() => {
                self.forget(id).await?;
                Err(ended(format!(
                    "the sign-in to {host} was ended at the provider; sign in again in Settings, under MCP"
                )))
            }
            // A token that has not run out yet still works when the renewal cannot be made now.
            Err(_) if matches!(renewal, Renewal::BeforeUse) => Ok(false),
            Err(error) => Err(renew_failure(&error)),
        }
    }

    async fn forget(&self, id: &AppId) -> Result<(), McpError> {
        let (store, id) = (self.store.clone(), id.clone());
        on_worker(move || store.forget_mcp_tokens(&id))
            .await
            .map_err(|error| store_failure(&error))?
            .map_err(|error| store_failure(&error))
    }
}

/// A time as the database keeps it.
fn seconds_since_1970(seconds: u64) -> i64 {
    i64::try_from(seconds).unwrap_or(i64::MAX)
}

fn store_failure(error: &dyn std::fmt::Display) -> McpError {
    McpError::Transport {
        message: format!("could not read the server's sign-in: {error}"),
    }
}

fn renew_failure(error: &SignInError) -> McpError {
    McpError::Transport {
        message: format!("could not renew the sign-in: {error}"),
    }
}

fn host_of(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_else(|| url.to_owned())
}

fn owner(user: UserId, id: &AppId, purpose: Purpose) -> Vec<u8> {
    let purpose = match purpose {
        Purpose::Access => "access",
        Purpose::Refresh => "refresh",
        Purpose::ClientSecret => "client-secret",
        Purpose::Verifier => "verifier",
    };
    format!("mcp-sign-in:{purpose}:{}:{id}", user.0).into_bytes()
}

impl McpServers {
    /// The address the provider sends the user back to: under the public origin when one is set,
    /// else under the origin the user's browser used.
    pub(crate) fn redirect_address(&self, browser_origin: &str) -> String {
        let origin = self.public_origin.as_deref().unwrap_or(browser_origin);
        format!("{}{RETURN_PATH}", origin.trim_end_matches('/'))
    }

    /// Starts a sign-in: finds how the server's provider signs in, registers Jet or takes the
    /// client the user pasted, and gives the provider's sign-in page to open.
    pub(crate) async fn start_sign_in(
        &self,
        user: UserId,
        id: &AppId,
        redirect_uri: String,
        pasted: Option<PastedClient>,
    ) -> Result<String, McpServerError> {
        let server = self.get(user, id).await?;
        if !server.enabled {
            return Err(McpServerError::TurnedOff);
        }
        let url = Url::parse(&server.url)
            .map_err(|_| McpServerError::InvalidAddress(server.url.clone()))?;
        let http = OAuthHttp::new(&url)?;
        let provider = http.provider(&url).await?;
        let (store, read) = (self.store.clone(), id.clone());
        let known = on_worker(move || store.mcp_sign_in(&read)).await??;
        let credentials = &self.credentials;
        let setup = match pasted {
            Some(pasted) => {
                let client_id = pasted.client_id.trim().to_owned();
                if !(1..=512).contains(&client_id.len()) || client_id.chars().any(char::is_control)
                {
                    return Err(McpServerError::InvalidKey(
                        "paste the client id the provider's console shows",
                    ));
                }
                let secret = pasted
                    .client_secret
                    .map(|secret| secret.trim().to_owned())
                    .filter(|secret| !secret.is_empty());
                setup(
                    &provider,
                    client_id,
                    secret.map(|secret| credentials.seal(user, id, Purpose::ClientSecret, &secret)),
                    false,
                    &redirect_uri,
                )
            }
            None => match known {
                // A client the user pasted, or one Jet registered for this redirect address and token
                // endpoint, is used again.
                Some(known)
                    if !known.setup.registered
                        || (known.setup.redirect_uri == redirect_uri
                            && known.setup.token_endpoint == provider.token_endpoint.as_str()) =>
                {
                    let client = known.setup;
                    setup(
                        &provider,
                        client.client_id,
                        client.sealed_client_secret,
                        client.registered,
                        &redirect_uri,
                    )
                }
                _ => {
                    let endpoint = provider
                        .registration_endpoint
                        .as_ref()
                        .ok_or_else(|| SignInError::NoRegistration(provider.issuer.clone()))?;
                    let registered = http.register(&provider, endpoint, &redirect_uri).await?;
                    let secret = registered
                        .client_secret
                        .map(|secret| credentials.seal(user, id, Purpose::ClientSecret, &secret));
                    setup(&provider, registered.client_id, secret, true, &redirect_uri)
                }
            },
        };
        let pkce = Pkce::new();
        let state = oauth::random_token();
        let page = oauth::authorization_url(
            &setup.authorization_endpoint,
            &setup.client_id,
            &redirect_uri,
            &setup.resource,
            setup.scope.as_deref(),
            &pkce.challenge,
            &state,
        )?;
        let now = (credentials.clock)();
        let start = SignInStart {
            server_id: id.clone(),
            sealed_verifier: credentials.seal(user, id, Purpose::Verifier, &pkce.verifier),
            redirect_uri,
            expires_at: seconds_since_1970(now.saturating_add(START_SECONDS)),
        };
        let now = seconds_since_1970(now);
        let store = self.store.clone();
        on_worker(move || {
            store.begin_mcp_sign_in(user, &oauth::state_hash(&state), &setup, &start, now)
        })
        .await??;
        Ok(page.to_string())
    }

    /// Finishes the sign-in the provider sent the user back from: the state must be one this user
    /// started, not yet used and not run out. Then the code is traded for tokens and the server is
    /// tested with them.
    pub(crate) async fn finish_sign_in(
        &self,
        user: UserId,
        state: &str,
        answer: Result<&str, SignInError>,
    ) -> Result<McpServer, McpServerError> {
        let now = seconds_since_1970((self.credentials.clock)());
        let (store, hash) = (self.store.clone(), oauth::state_hash(state));
        let start = on_worker(move || store.take_mcp_sign_in_start(user, &hash, now))
            .await??
            .ok_or(SignInError::StateRefused)?;
        let id = start.server_id;
        let server = self.get(user, &id).await?;
        let code = answer?;
        let (store, read) = (self.store.clone(), id.clone());
        let stored = on_worker(move || store.mcp_sign_in(&read))
            .await??
            .filter(|stored| stored.user == user)
            .ok_or(SignInError::StateRefused)?;
        let credentials = &self.credentials;
        let verifier = credentials
            .open(user, &id, Purpose::Verifier, &start.sealed_verifier)
            .ok_or(SignInError::StateRefused)?;
        let setup = &stored.setup;
        let secret = setup
            .sealed_client_secret
            .as_ref()
            .and_then(|sealed| credentials.open(user, &id, Purpose::ClientSecret, sealed));
        let client = Client {
            id: &setup.client_id,
            secret: secret.as_deref(),
            secret_in_body: setup.secret_in_body,
        };
        let url = Url::parse(&server.url)
            .map_err(|_| McpServerError::InvalidAddress(server.url.clone()))?;
        let exchanged = OAuthHttp::new(&url)?
            .exchange(
                &setup.token_endpoint,
                &client,
                &setup.resource,
                code,
                &verifier,
                &start.redirect_uri,
            )
            .await;
        let tokens = match exchanged {
            Ok(tokens) => tokens,
            // A client the provider does not accept is forgotten, so the next sign-in asks again.
            Err(error) if error.is_client_refused() => {
                let (store, forgotten) = (self.store.clone(), id.clone());
                on_worker(move || store.forget_mcp_client(&forgotten)).await??;
                return Err(SignInError::ClientRefused.into());
            }
            Err(error) => return Err(error.into()),
        };
        let sealed = credentials.tokens(user, &id, &tokens, None);
        let (store, saved) = (self.store.clone(), id.clone());
        on_worker(move || store.sign_in_mcp(&saved, &sealed)).await??;
        self.mcp.forget(&id).await;
        self.test(user, &id).await
    }

    /// Forgets the server's tokens. Its client is kept, so signing in again needs no new one.
    pub(crate) async fn sign_out(
        &self,
        user: UserId,
        id: &AppId,
    ) -> Result<McpServer, McpServerError> {
        let (store, saved) = (self.store.clone(), id.clone());
        if on_worker(move || store.sign_out_mcp(user, &saved)).await?? {
            self.mcp.forget(id).await;
        }
        self.get(user, id).await
    }
}

fn setup(
    provider: &oauth::Provider,
    client_id: String,
    sealed_client_secret: Option<Vec<u8>>,
    registered: bool,
    redirect_uri: &str,
) -> SignInSetup {
    SignInSetup {
        authorization_endpoint: provider.authorization_endpoint.to_string(),
        token_endpoint: provider.token_endpoint.to_string(),
        resource: provider.resource.clone(),
        scope: provider.scope.clone(),
        client_id,
        sealed_client_secret,
        registered,
        redirect_uri: redirect_uri.to_owned(),
        secret_in_body: provider.secret_in_body,
    }
}
