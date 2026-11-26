//! Why a sign-in or a guarded request was refused, sent to the page as a kind and a message.

use crate::{WorkerFailed, store::StoreError};
use axum::{
    Json,
    http::{StatusCode, header::RETRY_AFTER},
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum AccountError {
    #[error("sign in to use Jet")]
    SignedOut,
    #[error("wrong email or password")]
    WrongPassword,
    #[error("too many failed sign-ins; try again in {retry_after} seconds")]
    TooManyFailures { retry_after: u64 },
    #[error("a request from another site or without its Origin header was refused")]
    CrossSite,
    #[error("failed to hash a password: {0}")]
    Hash(argon2::password_hash::Error),
    #[error("failed to read or make the signing secret {path}")]
    Secret {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("the signing secret has {length} bytes; it needs at least 32")]
    ShortSecret { length: usize },
    #[error("{variable} must be set to a password that is not empty and is not the published one")]
    PublishedSeedPassword { variable: &'static str },
    #[error("the signing secret cannot make a signing key")]
    Key(#[from] jsonwebtoken::errors::Error),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("the sign-in worker failed")]
    Worker(#[source] tokio::task::JoinError),
}

impl From<WorkerFailed> for AccountError {
    fn from(failed: WorkerFailed) -> Self {
        Self::Worker(failed.0)
    }
}

impl AccountError {
    fn kind(&self) -> &'static str {
        match self {
            Self::SignedOut => "signedOut",
            Self::WrongPassword => "wrongPassword",
            Self::TooManyFailures { .. } => "tooManyFailures",
            Self::CrossSite => "crossSite",
            Self::Hash(_)
            | Self::Secret { .. }
            | Self::ShortSecret { .. }
            | Self::PublishedSeedPassword { .. }
            | Self::Key(_)
            | Self::Store(_)
            | Self::Worker(_) => "io",
        }
    }
}

impl IntoResponse for AccountError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::SignedOut | Self::WrongPassword => StatusCode::UNAUTHORIZED,
            Self::TooManyFailures { .. } => StatusCode::TOO_MANY_REQUESTS,
            Self::CrossSite => StatusCode::FORBIDDEN,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        if status == StatusCode::INTERNAL_SERVER_ERROR {
            eprintln!("jet: sign-in failed: {self:?}");
        }
        let retry = match self {
            Self::TooManyFailures { retry_after } => Some([(RETRY_AFTER, retry_after.to_string())]),
            _ => None,
        };
        let body = json!({"kind": self.kind(), "message": self.to_string()});
        (status, retry, Json(body)).into_response()
    }
}
