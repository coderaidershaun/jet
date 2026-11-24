//! The sign-in endpoints: sign in, renew the access token, sign out, and who am I.

use super::{
    AccountError, Accounts, SIGNIN_SECONDS, SignedIn,
    cookies::{self, ACCESS, REFRESH},
    limit::client_address,
    password,
    token::{self, Grant, digest, random_hex},
};
use crate::{
    lock, on_worker,
    store::{Email, Rotation, SigninId, User, UserId},
};
use axum::{
    Json, Router,
    extract::{ConnectInfo, FromRef, State},
    http::{HeaderMap, header::SET_COOKIE},
    response::{AppendHeaders, IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::json;
use std::{net::SocketAddr, time::Instant};

pub(crate) fn router<S>() -> axum::Router<S>
where
    S: Clone + Send + Sync + 'static,
    Accounts: FromRef<S>,
{
    Router::new()
        .route("/api/auth/signin", post(sign_in))
        .route("/api/auth/refresh", post(refresh))
        .route("/api/auth/signout", post(sign_out))
        .route("/api/auth/me", get(me))
}

/// The longest email an address can have (RFC 5321), and a password far longer than anyone types.
/// Longer ones are refused before they are counted or hashed.
const MAX_EMAIL_BYTES: usize = 254;
const MAX_PASSWORD_BYTES: usize = 1024;

#[derive(Deserialize)]
struct Credentials {
    email: String,
    password: String,
}

async fn sign_in(
    State(accounts): State<Accounts>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(credentials): Json<Credentials>,
) -> Result<Response, AccountError> {
    if credentials.email.len() > MAX_EMAIL_BYTES || credentials.password.len() > MAX_PASSWORD_BYTES
    {
        return Err(AccountError::WrongPassword);
    }
    let email = Email::from(credentials.email.as_str());
    let forwarded = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok());
    let address = client_address(peer.ip(), forwarded, accounts.trusted_proxy);
    lock(&accounts.failures)
        .begin(&email, address, Instant::now())
        .map_err(|retry_after| AccountError::TooManyFailures { retry_after })?;
    let store = accounts.store.clone();
    let looked_up = email.clone();
    let user = on_worker(move || -> Result<Option<UserId>, AccountError> {
        let stored = store.password_hash(&looked_up)?;
        let hash = stored.as_ref().map(|(_, hash)| hash.as_str());
        let matched = password::matches(&credentials.password, hash);
        Ok(stored.filter(|_| matched).map(|(user, _)| user))
    })
    .await??;
    let user = user.ok_or(AccountError::WrongPassword)?;
    lock(&accounts.failures).succeeded(&email, address);
    let signin = SigninId(random_hex(16));
    let refresh = random_hex(32);
    let now = token::now();
    accounts
        .store
        .start_signin(&signin, user, &digest(&refresh), now, now + SIGNIN_SECONDS)?;
    let user = accounts.store.user(user)?.ok_or(AccountError::SignedOut)?;
    Ok(accounts.issue(user, signin, &refresh))
}

/// Swaps the refresh token for a new one and gives a new access token. A token that was already
/// swapped ends the whole sign-in, because only a copy of it can still be offered.
async fn refresh(
    State(accounts): State<Accounts>,
    headers: HeaderMap,
) -> Result<Response, AccountError> {
    let Some(old) = cookies::read(&headers, REFRESH) else {
        return Ok(accounts.signed_out());
    };
    let new = random_hex(32);
    let now = token::now();
    let rotation = accounts
        .store
        .rotate_refresh(&digest(old), &digest(&new), now)?;
    let Rotation::Renewed(signin) = rotation else {
        return Ok(accounts.signed_out());
    };
    match accounts.store.live_signin(&signin, now)? {
        Some(user) => Ok(accounts.issue(user, signin, &new)),
        None => Ok(accounts.signed_out()),
    }
}

async fn sign_out(
    State(accounts): State<Accounts>,
    headers: HeaderMap,
) -> Result<Response, AccountError> {
    let now = token::now();
    if let Some(refresh) = cookies::read(&headers, REFRESH)
        && let Some(signin) = accounts.store.signin_of_refresh(&digest(refresh))?
    {
        accounts.store.end_signin(&signin, now)?;
    }
    if let Some(access) = cookies::read(&headers, ACCESS)
        && let Some((Grant::Access { signin }, _)) = accounts.keys.verify(access)
    {
        accounts.store.end_signin(&signin, now)?;
    }
    let cleared = accounts
        .cookies
        .cleared()
        .map(|cookie| (SET_COOKIE, cookie));
    Ok((AppendHeaders(cleared), Json(json!({}))).into_response())
}

async fn me(signed_in: SignedIn) -> Response {
    Json(json!({"user": signed_in.user, "accessExpiresAt": signed_in.expires_at})).into_response()
}

impl Accounts {
    fn issue(&self, user: User, signin: SigninId, refresh: &str) -> Response {
        let expires_at = token::now() + self.access_seconds;
        let access = self.keys.sign(Grant::Access { signin }, expires_at);
        let cookies = [
            (
                SET_COOKIE,
                self.cookies.access(&access, self.access_seconds),
            ),
            (SET_COOKIE, self.cookies.refresh(refresh, SIGNIN_SECONDS)),
        ];
        let body = Json(json!({"user": user, "accessExpiresAt": expires_at}));
        (AppendHeaders(cookies), body).into_response()
    }

    fn signed_out(&self) -> Response {
        let cleared = self.cookies.cleared().map(|cookie| (SET_COOKIE, cookie));
        (AppendHeaders(cleared), AccountError::SignedOut).into_response()
    }
}
