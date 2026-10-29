//! Lets the page ask whether Jet can speak, and turn a piece of a reply into speech. The key and
//! the voice stay on the server.

use super::Server;
use agent::voice::{self, VoiceError};
use axum::{
    Json, Router,
    extract::State,
    http::{
        HeaderValue, StatusCode,
        header::{CACHE_CONTROL, CONTENT_TYPE},
    },
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::json;

const DISABLED: &str = "Voice is turned off on this server";
const AUDIO_TYPE: &str = "audio/L16;rate=24000;channels=1";

pub(super) fn router() -> Router<Server> {
    Router::new()
        .route("/api/voice", get(availability))
        .route("/api/voice/speech", post(speech))
}

#[derive(Serialize)]
struct Availability {
    available: bool,
    reason: Option<String>,
}

async fn availability(State(host): State<Server>) -> Result<Json<Availability>, Refusal> {
    if host.config.disable_voice {
        return Ok(Json(Availability {
            available: false,
            reason: Some(DISABLED.into()),
        }));
    }
    let status = on_worker(voice::status).await?;
    Ok(Json(match status {
        Ok(()) => Availability {
            available: true,
            reason: None,
        },
        Err(error) => Availability {
            available: false,
            reason: Some(error.to_string()),
        },
    }))
}

#[derive(Deserialize)]
struct SpeechRequest {
    text: String,
}

/// The raw PCM of the spoken words of a piece of Markdown. The body is empty when the piece has
/// nothing to say aloud.
// SMELL: anyone who can reach this server can ask for speech, and each request spends Google
// quota. The only limits are the cap on the length of a piece and the quota itself.
async fn speech(
    State(host): State<Server>,
    Json(request): Json<SpeechRequest>,
) -> Result<Response, Refusal> {
    if host.config.disable_voice {
        return Err(Refusal::not_configured(DISABLED));
    }
    let pcm = on_worker(move || voice::speak(&request.text)).await??;
    Ok((
        [
            (CONTENT_TYPE, HeaderValue::from_static(AUDIO_TYPE)),
            (CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        pcm,
    )
        .into_response())
}

/// Runs a call that waits on the network or reads files, away from the server's own threads.
async fn on_worker<T: Send + 'static>(
    call: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Refusal> {
    tokio::task::spawn_blocking(call)
        .await
        .map_err(|error| Refusal {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            kind: "http",
            message: format!("The voice worker failed: {error}"),
        })
}

/// Why the page got no audio. It reads `kind`: `notConfigured` and `rejected` mean Google will
/// not speak for this server at all, and the rest are worth another try.
struct Refusal {
    status: StatusCode,
    kind: &'static str,
    message: String,
}

impl Refusal {
    fn not_configured(message: &str) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            kind: "notConfigured",
            message: message.into(),
        }
    }
}

impl From<VoiceError> for Refusal {
    fn from(error: VoiceError) -> Self {
        let (status, kind) = match &error {
            VoiceError::NotConfigured { .. } => (StatusCode::SERVICE_UNAVAILABLE, "notConfigured"),
            VoiceError::TooLong { .. } => (StatusCode::PAYLOAD_TOO_LARGE, "tooLong"),
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
