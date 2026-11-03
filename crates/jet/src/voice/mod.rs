//! Lets the page ask whether Jet can speak and hear, turn a piece of a reply into speech, and turn
//! a clip of the user's speech into words. The key and the voice stay on the server.

mod budget;
mod health;
mod refusal;

use budget::{HearBudget, Moment};
use health::VoiceHealth;
use refusal::Refusal;

use crate::on_worker;
use agent::voice::{self, VoiceError};
use agent::{CUES, Cue, Mood};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, FromRef, Query, State, rejection::BytesRejection},
    http::{
        HeaderValue,
        header::{CACHE_CONTROL, CONTENT_TYPE},
    },
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{sync::Arc, time::Instant};

const DISABLED: &str = "Voice is turned off on this server";
const AUDIO_TYPE: &str = "audio/L16;rate=24000;channels=1";
/// The largest body the hear route reads. A 20 second clip is 640,000 bytes.
const HEAR_BODY_LIMIT: usize = 1 << 20;

/// What the voice routes remember between requests: whether voice is turned off, what the hear
/// route may still spend, and what Google last refused on each route.
#[derive(Clone)]
pub(crate) struct Voice {
    disabled: bool,
    hear_budget: Arc<HearBudget>,
    speech_health: Arc<VoiceHealth>,
    hear_health: Arc<VoiceHealth>,
}

impl Voice {
    pub(crate) fn new(disabled: bool) -> Self {
        Self {
            disabled,
            hear_budget: Arc::new(HearBudget::new()),
            speech_health: Arc::default(),
            hear_health: Arc::default(),
        }
    }
}

pub(crate) fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Voice: FromRef<S>,
{
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
    /// Google's last refusal on this route, while it is under ten minutes old and Google has not
    /// answered since.
    warning: Option<String>,
}

impl Availability {
    fn of(status: Result<(), VoiceError>, warning: Option<String>) -> Self {
        Self {
            available: status.is_ok(),
            reason: status.err().map(|error| error.to_string()),
            warning,
        }
    }

    fn off() -> Self {
        Self {
            available: false,
            reason: Some(DISABLED.into()),
            warning: None,
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

async fn availability(State(state): State<Voice>) -> Result<Json<VoiceStatus>, Refusal> {
    let (speaking, hear) = if state.disabled {
        (Availability::off(), Availability::off())
    } else {
        let (speaking, hear) = on_worker(|| (voice::status(), voice::hearing_status())).await?;
        let now = Instant::now();
        (
            Availability::of(speaking, state.speech_health.warning(now)),
            Availability::of(hear, state.hear_health.warning(now)),
        )
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
    State(state): State<Voice>,
    Json(request): Json<SpeechRequest>,
) -> Result<Response, Refusal> {
    if state.disabled {
        return Err(Refusal::not_configured(DISABLED));
    }
    let style = request
        .mood
        .as_deref()
        .and_then(Mood::from_word)
        .and_then(Mood::style);
    let spoken = on_worker(move || voice::speak(&request.text, style)).await?;
    state.speech_health.record(&spoken, Instant::now());
    let pcm = spoken?;
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
    State(state): State<Voice>,
    Query(query): Query<Vec<(String, String)>>,
    body: Result<Bytes, BytesRejection>,
) -> Result<Json<serde_json::Value>, Refusal> {
    if state.disabled {
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
        state
            .hear_budget
            .admit(voice::clip_seconds(&body), Moment::now(), daily_minutes)?;
    // The permit goes with the call, so a caller who hangs up does not free it while Google works.
    let heard = on_worker(move || {
        let _permit = permit;
        voice::hear(&body, &vocabulary)
    })
    .await?;
    state.hear_health.record(&heard, Instant::now());
    let text = heard?;
    Ok(Json(json!({"text": text})))
}
