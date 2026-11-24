//! Each user's GitHub token: sealed with a key of the server before it is stored, opened only for
//! that user's own calls, and never sent back to anyone. The page can only ask whether one is
//! saved, save or replace it, and remove it.

use crate::{
    WorkerFailed,
    account::SignedIn,
    on_worker,
    store::{Store, StoreError, UserId},
};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use ring::aead::{Aad, CHACHA20_POLY1305, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{io::Write, path::Path, sync::Arc};

const KEY_FILE: &str = "github-token-key";
const KEY_VARIABLE: &str = "JET_GITHUB_TOKEN_KEY";
const KEY_BYTES: usize = 32;
/// GitHub's tokens are well under this; the limit keeps a pasted page out of the database.
const TOKEN_LIMIT: usize = 400;

#[derive(Debug, thiserror::Error)]
pub enum TokenError {
    #[error("failed to read or make the GitHub token key {path}")]
    Key {
        path: std::path::PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("the GitHub token key has {length} bytes; it needs at least 32")]
    ShortKey { length: usize },
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
    key: Arc<LessSafeKey>,
}

impl GithubTokens {
    /// Reads the key from the environment, else from the data directory, making it there with
    /// owner-only access on first start.
    pub(crate) fn open(store: Store, data_dir: &Path) -> Result<Self, TokenError> {
        let secret = match std::env::var(KEY_VARIABLE) {
            Ok(secret) => secret,
            Err(_) => read_or_make_key(&data_dir.join(KEY_FILE))?,
        };
        if secret.len() < KEY_BYTES {
            return Err(TokenError::ShortKey {
                length: secret.len(),
            });
        }
        let key = UnboundKey::new(&CHACHA20_POLY1305, &Sha256::digest(secret.as_bytes()))
            .expect("a SHA-256 digest is exactly a ChaCha20-Poly1305 key long");
        Ok(Self {
            store,
            key: Arc::new(LessSafeKey::new(key)),
        })
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
        let mut nonce = [0; NONCE_LEN];
        getrandom::fill(&mut nonce).expect("the system random source is available");
        let mut sealed = token.as_bytes().to_vec();
        self.key
            .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), aad(user), &mut sealed)
            .expect("ChaCha20-Poly1305 seals any message this short");
        let stored = [nonce.as_slice(), &sealed].concat();
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
        let (nonce, sealed) = stored
            .split_at_checked(NONCE_LEN)
            .ok_or(TokenError::Unreadable)?;
        let nonce = Nonce::try_assume_unique_for_key(nonce).map_err(|_| TokenError::Unreadable)?;
        let mut sealed = sealed.to_vec();
        let token = self
            .key
            .open_in_place(nonce, aad(user), &mut sealed)
            .map_err(|_| TokenError::Unreadable)?;
        let token = String::from_utf8(token.to_vec()).map_err(|_| TokenError::Unreadable)?;
        Ok(Some(GithubToken(token)))
    }
}

/// The user id is sealed with the token, so a sealed token copied to another user's row does not
/// open.
fn aad(user: UserId) -> Aad<[u8; 8]> {
    Aad::from(user.0.to_le_bytes())
}

fn read_or_make_key(path: &Path) -> Result<String, TokenError> {
    let failed = |source| TokenError::Key {
        path: path.to_owned(),
        source,
    };
    match std::fs::read_to_string(path) {
        Ok(secret) => return Ok(secret.trim().to_owned()),
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(failed(error)),
        Err(_) => {}
    }
    let mut bytes = [0; KEY_BYTES];
    getrandom::fill(&mut bytes).expect("the system random source is available");
    let secret: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path).map_err(failed)?;
    file.write_all(secret.as_bytes()).map_err(failed)?;
    Ok(secret)
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
