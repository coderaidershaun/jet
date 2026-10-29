//! Lets the page ask whether Jet can speak and hear, turn a piece of a reply into speech, and turn
//! a clip of the user's speech into words. The key and the voice stay on the server.

mod budget;
mod refusal;

pub(super) use budget::HearBudget;
use budget::Moment;
use refusal::Refusal;

use super::Server;
use agent::voice::{self, VoiceError};
use agent::{CUES, Cue, Mood};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Query, State, rejection::BytesRejection},
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
/// The largest body the hear route reads. A 20 second clip is 640,000 bytes.
const HEAR_BODY_LIMIT: usize = 1 << 20;

pub(super) fn router() -> Router<Server> {
    Router::new()
        .route("/api/voice", get(availability))
        .route("/api/voice/speech", post(speech))
        .route(
            "/api/voice/hear",
            post(hear).layer(DefaultBodyLimit::max(HEAR_BODY_LIMIT)),
        )
}

#[derive(Serialize)]
struct Availability {
    available: bool,
    reason: Option<String>,
}

impl Availability {
    fn of(status: Result<(), VoiceError>) -> Self {
        match status {
            Ok(()) => Self {
                available: true,
                reason: None,
            },
            Err(error) => Self {
                available: false,
                reason: Some(error.to_string()),
            },
        }
    }

    fn off() -> Self {
        Self {
            available: false,
            reason: Some(DISABLED.into()),
        }
    }
}

/// Whether Jet can speak and whether it can hear, and the vocal cues the voice performs. The
/// cues are listed even when the voice is off.
#[derive(Serialize)]
struct VoiceStatus {
    #[serde(flatten)]
    speaking: Availability,
    hear: Availability,
    cues: &'static [Cue],
}

async fn availability(State(host): State<Server>) -> Result<Json<VoiceStatus>, Refusal> {
    let (speaking, hear) = if host.config.disable_voice {
        (Availability::off(), Availability::off())
    } else {
        let (speaking, hear) = on_worker(|| (voice::status(), voice::hearing_status())).await?;
        (Availability::of(speaking), Availability::of(hear))
    };
    Ok(Json(VoiceStatus {
        speaking,
        hear,
        cues: &CUES,
    }))
}

#[derive(Deserialize)]
struct SpeechRequest {
    text: String,
    /// The mood word of the reply. A word outside `Mood` counts as none.
    mood: Option<String>,
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
    let style = request
        .mood
        .as_deref()
        .and_then(Mood::from_word)
        .and_then(Mood::style);
    let pcm = on_worker(move || voice::speak(&request.text, style)).await??;
    Ok((
        [
            (CONTENT_TYPE, HeaderValue::from_static(AUDIO_TYPE)),
            (CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        pcm,
    )
        .into_response())
}

/// The words of a clip of 16 kHz 16-bit mono PCM, as `{"text": "..."}`. Any body is read as PCM.
/// The query holds the `vocabulary` words that the clip may hold, one value each.
// SMELL: anyone who can reach this server can ask it to hear a clip, and each request spends
// Google quota. The clip length, the calls at once, the audio a minute and the audio a day are
// capped, which bounds the damage but does not stop the exposure.
async fn hear(
    State(host): State<Server>,
    Query(query): Query<Vec<(String, String)>>,
    body: Result<Bytes, BytesRejection>,
) -> Result<Json<serde_json::Value>, Refusal> {
    if host.config.disable_voice {
        return Err(Refusal::not_configured(DISABLED));
    }
    let body = body.map_err(Refusal::unread_clip)?;
    let vocabulary: Vec<String> = query
        .into_iter()
        .filter(|(name, _)| name == "vocabulary")
        .map(|(_, word)| word)
        .collect();
    let (hearing, daily_minutes) =
        on_worker(|| (voice::hearing_status(), voice::hearing_daily_minutes())).await?;
    hearing?;
    let permit =
        host.hear_budget
            .admit(voice::clip_seconds(&body), Moment::now(), daily_minutes)?;
    // The permit goes with the call, so a caller who hangs up does not free it while Google works.
    let text = on_worker(move || {
        let _permit = permit;
        voice::hear(&body, &vocabulary)
    })
    .await??;
    Ok(Json(json!({"text": text})))
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
