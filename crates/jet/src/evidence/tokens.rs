//! Each user's GitHub token: sealed with a key of the server before it is stored, opened only for
//! that user's own calls, and never sent back to anyone. The page can only ask whether one is
//! saved, save or replace it, and remove it.

use crate::{
    WorkerFailed,
    account::SignedIn,
    on_worker,
    seal::Sealer,
    store::{Store, StoreError, UserId},
};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;
use serde_json::json;

/// GitHub's tokens are well under this; the limit keeps a pasted page out of the database.
const TOKEN_LIMIT: usize = 400;

#[derive(Debug, thiserror::Error)]
pub enum TokenError {
    #[error(
        "a GitHub token is one line of letters, digits and underscores, at most {TOKEN_LIMIT} characters"
    )]
    Invalid,
    #[error("the saved GitHub token can no longer be read, because the server's token key changed")]
    Unreadable,
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("the token worker failed")]
    Worker(#[source] tokio::task::JoinError),
}

impl From<WorkerFailed> for TokenError {
    fn from(failed: WorkerFailed) -> Self {
        Self::Worker(failed.0)
    }
}

/// A user's GitHub token in clear. It prints as `GithubToken(..)` and cannot be serialised, so it
/// cannot reach a log line or an answer by accident.
pub(crate) struct GithubToken(pub(super) String);

impl GithubToken {
    pub(super) fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for GithubToken {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("GithubToken(..)")
    }
}

#[derive(Clone)]
pub(crate) struct GithubTokens {
    store: Store,
    sealer: Sealer,
}

impl GithubTokens {
    pub(crate) fn new(store: Store, sealer: Sealer) -> Self {
        Self { store, sealer }
    }

    /// Whether the user has a token saved.
    pub(crate) fn has_token(&self, user: UserId) -> Result<bool, TokenError> {
        Ok(self.store.github_token(user)?.is_some())
    }

    /// Saves or replaces the user's token.
    pub(crate) fn save(&self, user: UserId, token: &str) -> Result<(), TokenError> {
        let token = token.trim();
        let valid = !token.is_empty()
            && token.len() <= TOKEN_LIMIT
            && token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
        if !valid {
            return Err(TokenError::Invalid);
        }
        let stored = self.sealer.seal(&owner(user), token.as_bytes());
        Ok(self.store.set_github_token(user, Some(&stored))?)
    }

    pub(crate) fn remove(&self, user: UserId) -> Result<(), TokenError> {
        Ok(self.store.set_github_token(user, None)?)
    }

    /// The user's token in clear, for a call made in that user's own turn.
    pub(super) fn token(&self, user: UserId) -> Result<Option<GithubToken>, TokenError> {
        let Some(stored) = self.store.github_token(user)? else {
            return Ok(None);
        };
        let token = self
            .sealer
            .unseal(&owner(user), &stored)
            .ok_or(TokenError::Unreadable)?;
        let token = String::from_utf8(token).map_err(|_| TokenError::Unreadable)?;
        Ok(Some(GithubToken(token)))
    }
}

/// The user id is sealed with the token, so a sealed token copied to another user's row does not
/// open.
fn owner(user: UserId) -> [u8; 8] {
    user.0.to_le_bytes()
}

/// `/api/github/token`: `GET` says whether the signed-in user has a token saved, `PUT` with
/// `{"token": "..."}` saves or replaces it, and `DELETE` removes it. Each answers `{"saved": bool}`
/// and none ever holds the token.
pub(crate) fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    GithubTokens: axum::extract::FromRef<S>,
{
    Router::new().route(
        "/api/github/token",
        get(saved).put(save_token).delete(remove_token),
    )
}

#[derive(Deserialize)]
struct Pasted {
    token: String,
}

async fn saved(
    State(tokens): State<GithubTokens>,
    signed_in: SignedIn,
) -> Result<Json<serde_json::Value>, TokenError> {
    let saved = on_worker(move || tokens.has_token(signed_in.user.id)).await??;
    Ok(Json(json!({"saved": saved})))
}

async fn save_token(
    State(tokens): State<GithubTokens>,
    signed_in: SignedIn,
    Json(pasted): Json<Pasted>,
) -> Result<Json<serde_json::Value>, TokenError> {
    on_worker(move || tokens.save(signed_in.user.id, &pasted.token)).await??;
    Ok(Json(json!({"saved": true})))
}

async fn remove_token(
    State(tokens): State<GithubTokens>,
    signed_in: SignedIn,
) -> Result<Json<serde_json::Value>, TokenError> {
    on_worker(move || tokens.remove(signed_in.user.id)).await??;
    Ok(Json(json!({"saved": false})))
}

impl IntoResponse for TokenError {
    fn into_response(self) -> Response {
        let (status, kind) = match self {
            Self::Invalid => (StatusCode::BAD_REQUEST, "invalidToken"),
            _ => (StatusCode::INTERNAL_SERVER_ERROR, "io"),
        };
        if status == StatusCode::INTERNAL_SERVER_ERROR {
            eprintln!("jet: the GitHub token request failed: {self:?}");
        }
        let body = json!({"kind": kind, "message": self.to_string()});
        (status, Json(body)).into_response()
    }
}
