//! One error answer for every voice route, so the page reads the same `{kind, message}` body
//! from each.

use agent::voice::{self, VoiceError};
use axum::{
    Json,
    extract::rejection::BytesRejection,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

/// Why the page got no audio or no words. It reads `kind`: `notConfigured` and `rejected` mean
/// Google will not speak or hear for this server at all, and the rest are worth another try.
// SMELL: `kind` is a bare string that the page matches on, written in several places. A typo
// compiles, and the page may then retry a final refusal or give up on one that is not.
#[derive(Debug)]
pub(super) struct Refusal {
    pub(super) status: StatusCode,
    pub(super) kind: &'static str,
    pub(super) message: String,
}

impl Refusal {
    pub(super) fn rate_limited(message: &str) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            kind: "rateLimited",
            message: message.into(),
        }
    }

    pub(super) fn not_configured(message: &str) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            kind: "notConfigured",
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
                kind: "tooLong",
                message: format!(
                    "That clip is longer than the {} seconds Jet hears at most",
                    voice::MAX_CLIP_SECONDS
                ),
            };
        }
        Self {
            status,
            kind: "http",
            message: rejection.body_text(),
        }
    }
}

impl From<VoiceError> for Refusal {
    fn from(error: VoiceError) -> Self {
        let (status, kind) = match &error {
            VoiceError::NotConfigured { .. } | VoiceError::HearingNotConfigured { .. } => {
                (StatusCode::SERVICE_UNAVAILABLE, "notConfigured")
            }
            VoiceError::TooLong { .. } | VoiceError::AudioTooLong { .. } => {
                (StatusCode::PAYLOAD_TOO_LARGE, "tooLong")
            }
            VoiceError::RateLimited => (StatusCode::TOO_MANY_REQUESTS, "rateLimited"),
            VoiceError::Rejected {
                status: 401 | 403, ..
            } => (StatusCode::BAD_GATEWAY, "rejected"),
            VoiceError::Rejected { .. } | VoiceError::Http | VoiceError::Decode => {
                (StatusCode::BAD_GATEWAY, "http")
            }
        };
        Self {
            status,
            kind,
            message: error.to_string(),
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
