//! One error answer for every voice route, so the page reads the same `{kind, message}` body
//! from each.

use crate::WorkerFailed;
use agent::voice::{self, VoiceError};
use axum::{
    Json,
    extract::rejection::BytesRejection,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use serde_json::json;

/// What the page reads to decide whether to try again: `notConfigured` and `rejected` mean Google
/// will not speak or hear for this server at all, and the rest are worth another try.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum RefusalKind {
    NotConfigured,
    TooLong,
    RateLimited,
    Rejected,
    Http,
}

/// Why the page got no audio or no words.
#[derive(Debug)]
pub(super) struct Refusal {
    pub(super) status: StatusCode,
    pub(super) kind: RefusalKind,
    pub(super) message: String,
}

impl Refusal {
    pub(super) fn rate_limited(message: &str) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            kind: RefusalKind::RateLimited,
            message: message.into(),
        }
    }

    pub(super) fn not_configured(message: &str) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            kind: RefusalKind::NotConfigured,
            message: message.into(),
        }
    }

    /// A clip whose body could not be read: past the size limit, which is far past the longest
    /// clip, or cut off on the way.
    pub(super) fn unread_clip(rejection: BytesRejection) -> Self {
        let status = rejection.status();
        if status == StatusCode::PAYLOAD_TOO_LARGE {
            return Self {
                status,
                kind: RefusalKind::TooLong,
                message: format!(
                    "That clip is longer than the {} seconds Jet hears at most",
                    voice::MAX_CLIP_SECONDS
                ),
            };
        }
        Self {
            status,
            kind: RefusalKind::Http,
            message: rejection.body_text(),
        }
    }
}

impl From<VoiceError> for Refusal {
    fn from(error: VoiceError) -> Self {
        let (status, kind) = match &error {
            VoiceError::NotConfigured { .. } | VoiceError::HearingNotConfigured { .. } => {
                (StatusCode::SERVICE_UNAVAILABLE, RefusalKind::NotConfigured)
            }
            VoiceError::TooLong { .. } | VoiceError::AudioTooLong { .. } => {
                (StatusCode::PAYLOAD_TOO_LARGE, RefusalKind::TooLong)
            }
            VoiceError::RateLimited => (StatusCode::TOO_MANY_REQUESTS, RefusalKind::RateLimited),
            VoiceError::Rejected {
                status: 401 | 403, ..
            } => (StatusCode::BAD_GATEWAY, RefusalKind::Rejected),
            VoiceError::Rejected { .. } | VoiceError::Http | VoiceError::Decode => {
                (StatusCode::BAD_GATEWAY, RefusalKind::Http)
            }
        };
        Self {
            status,
            kind,
            message: error.to_string(),
        }
    }
}

impl From<WorkerFailed> for Refusal {
    fn from(error: WorkerFailed) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            kind: RefusalKind::Http,
            message: format!("The voice worker failed: {error}"),
        }
    }
}

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"kind": self.kind, "message": self.message})),
        )
            .into_response()
    }
}
