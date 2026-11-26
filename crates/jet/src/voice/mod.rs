//! Lets the page ask whether Jet can speak and hear, turn a piece of a reply into speech with Gemini
//! or Phonon, and turn a clip of the user's speech into words with Gemini or Phonon-2. The key and
//! the voice stay on the server.

mod budget;
mod health;
mod refusal;

use budget::{HearBudget, Moment};
use health::VoiceHealth;
use refusal::Refusal;

use crate::on_worker;
use crate::settings::{HearingEngine, SpeakingEngine};
use agent::voice::{self, Phonon, Phonon2, PhononMode, VoiceError};
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
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

const DISABLED: &str = "Voice is turned off on this server";
const BROWSER_HEARS: &str = "The browser's own hearing runs in the page, not on the server";
const BROWSER_SPEAKS: &str = "The browser's own voice runs in the page, not on the server";
const BUSY: &str = "Jet's own voice is busy with other calls; try again soon";
/// How long a call waits for its turn at a model on this server.
const TURN_WAIT: Duration = Duration::from_secs(30);
const AUDIO_TYPE: &str = "audio/L16;rate=24000;channels=1";
/// The largest body the hear route reads. A 20 second clip is 640,000 bytes.
const HEAR_BODY_LIMIT: usize = 1 << 20;

/// What the voice routes remember between requests: whether voice is turned off, what the hear
/// route may still spend, what Google last refused on each route, the open Phonon-2 session and
/// the loaded Phonon model.
#[derive(Clone)]
pub(crate) struct Voice {
    disabled: bool,
    hear_budget: Arc<HearBudget>,
    speech_health: Arc<VoiceHealth>,
    hear_health: Arc<VoiceHealth>,
    phonon2: OneAtATime<Phonon2>,
    phonon: OneAtATime<Phonon>,
}

/// A model that runs on this server. One call at a time works it, and the others wait here, not on
/// a worker thread, so a burst of calls cannot use up the workers that the rest of Jet needs. A
/// call that waits longer than `TURN_WAIT` is refused, so the waiting calls cannot pile up.
struct OneAtATime<T> {
    model: Arc<T>,
    turn: Arc<Semaphore>,
}

// Derived, it would ask the model itself to be Clone.
impl<T> Clone for OneAtATime<T> {
    fn clone(&self) -> Self {
        Self {
            model: Arc::clone(&self.model),
            turn: Arc::clone(&self.turn),
        }
    }
}

impl<T: Default + Send + Sync + 'static> OneAtATime<T> {
    fn new() -> Self {
        Self {
            model: Arc::default(),
            turn: Arc::new(Semaphore::new(1)),
        }
    }

    async fn run<R: Send + 'static>(
        &self,
        call: impl FnOnce(&T) -> R + Send + 'static,
    ) -> Result<R, Refusal> {
        let permit = tokio::time::timeout(TURN_WAIT, Arc::clone(&self.turn).acquire_owned())
            .await
            .map_err(|_| Refusal::rate_limited(BUSY))?
            .expect("the semaphore is never closed");
        let model = Arc::clone(&self.model);
        let result = on_worker(move || {
            let _permit = permit;
            call(&model)
        })
        .await?;
        Ok(result)
    }
}

impl Voice {
    pub(crate) fn new(disabled: bool) -> Self {
        Self {
            disabled,
            hear_budget: Arc::new(HearBudget::new()),
            speech_health: Arc::default(),
            hear_health: Arc::default(),
            phonon2: OneAtATime::new(),
            phonon: OneAtATime::new(),
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

/// The engines on the server that can speak. The browser's own voice is the page's to judge.
#[derive(Serialize)]
struct Speaking {
    gemini: Availability,
    phonon: Availability,
}

/// The engines on the server that can hear. The browser's own engine is the page's to judge.
#[derive(Serialize)]
struct Hearing {
    gemini: Availability,
    phonon2: Availability,
}

/// Whether each engine can speak and hear, and the vocal cues the voice performs. The cues are
/// listed even when the voice is off.
#[derive(Serialize)]
struct VoiceStatus {
    speak: Speaking,
    hear: Hearing,
    cues: &'static [Cue],
}

async fn availability(State(state): State<Voice>) -> Result<Json<VoiceStatus>, Refusal> {
    let (speak, hear) = if state.disabled {
        let speak = Speaking {
            gemini: Availability::off(),
            phonon: Availability::off(),
        };
        let hear = Hearing {
            gemini: Availability::off(),
            phonon2: Availability::off(),
        };
        (speak, hear)
    } else {
        let (phonon, phonon2) = (state.phonon.model.clone(), state.phonon2.model.clone());
        let [speaking, phonon, gemini, phonon2] = on_worker(move || {
            [
                voice::status(),
                phonon.status(),
                voice::hearing_status(),
                phonon2.status(),
            ]
        })
        .await?;
        let now = Instant::now();
        let speak = Speaking {
            gemini: Availability::of(speaking, state.speech_health.warning(now)),
            phonon: Availability::of(phonon, None),
        };
        let hear = Hearing {
            gemini: Availability::of(gemini, state.hear_health.warning(now)),
            phonon2: Availability::of(phonon2, None),
        };
        (speak, hear)
    };
    Ok(Json(VoiceStatus {
        speak,
        hear,
        cues: &CUES,
    }))
}

/// Which engine speaks a piece, from the query: Gemini unless it names another.
#[derive(Deserialize, Default)]
#[serde(default)]
struct SpeakChoice {
    engine: SpeakingEngine,
}

#[derive(Deserialize)]
struct SpeechRequest {
    text: String,
    /// The mood word of the reply. A word outside `Mood` counts as none.
    mood: Option<String>,
}

/// The raw PCM of the spoken words of a piece of Markdown, said by the query's `engine`. The body
/// is empty when the piece has nothing to say aloud. Phonon runs here, so it spends no Google quota.
/// Only a signed-in user reaches this route. What it spends of Google's quota is bounded by the
/// cap on the length of a piece and by the quota itself.
async fn speech(
    State(state): State<Voice>,
    Query(choice): Query<SpeakChoice>,
    Json(request): Json<SpeechRequest>,
) -> Result<Response, Refusal> {
    if state.disabled {
        return Err(Refusal::not_configured(DISABLED));
    }
    match choice.engine {
        SpeakingEngine::Gemini => {}
        SpeakingEngine::Phonon => {
            let pcm = state
                .phonon
                .run(move |phonon| phonon.speak(&request.text))
                .await??;
            return Ok(audio(pcm));
        }
        SpeakingEngine::Browser => return Err(Refusal::not_configured(BROWSER_SPEAKS)),
    }
    let style = request
        .mood
        .as_deref()
        .and_then(Mood::from_word)
        .and_then(Mood::style);
    let spoken = on_worker(move || voice::speak(&request.text, style)).await?;
    state.speech_health.record(&spoken, Instant::now());
    Ok(audio(spoken?))
}

fn audio(pcm: Vec<u8>) -> Response {
    (
        [
            (CONTENT_TYPE, HeaderValue::from_static(AUDIO_TYPE)),
            (CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        pcm,
    )
        .into_response()
}

/// Which engine hears a clip, from the query: Gemini unless it names another.
#[derive(Deserialize, Default)]
#[serde(default)]
struct HearChoice {
    engine: HearingEngine,
    mode: PhononMode,
}

/// The words of a clip of 16 kHz 16-bit mono PCM, as `{"text": "..."}`. Any body is read as PCM.
/// The query holds the `vocabulary` words that the clip may hold, one value each, and the
/// `engine` and Phonon-2 `mode` that hear it. Phonon-2 runs here, so it spends no Google quota.
/// Only a signed-in user reaches this route. What it spends of Google's quota is bounded by the
/// hear budget of the server: the clip length, the calls at once, the audio a minute and a day.
/// The budget is shared by every user on purpose: it guards the server's one Google quota, and
/// every account is made by the server's owner, since nobody can sign up.
async fn hear(
    State(state): State<Voice>,
    Query(query): Query<Vec<(String, String)>>,
    Query(choice): Query<HearChoice>,
    body: Result<Bytes, BytesRejection>,
) -> Result<Json<serde_json::Value>, Refusal> {
    if state.disabled {
        return Err(Refusal::not_configured(DISABLED));
    }
    let body = body.map_err(Refusal::unread_clip)?;
    match choice.engine {
        HearingEngine::Gemini => {}
        HearingEngine::Phonon2 => {
            let text = state
                .phonon2
                .run(move |phonon2| phonon2.hear(&body, choice.mode))
                .await??;
            return Ok(Json(json!({"text": text})));
        }
        HearingEngine::Browser => return Err(Refusal::not_configured(BROWSER_HEARS)),
    }
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

#[cfg(all(test, not(feature = "phonon2"), not(feature = "phonon-tts")))]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};

    /// The message of the refusal that the route answers with 503.
    async fn refusal(path: &str, body: &str) -> String {
        let mut router = router::<Voice>().with_state(Voice::new(false));
        let request = Request::post(path)
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_owned()))
            .unwrap();
        let response = tower::Service::call(&mut router, request).await.unwrap();
        assert_eq!(response.status(), 503, "{path}");
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let refusal: serde_json::Value = serde_json::from_slice(&body).unwrap();
        refusal["message"].as_str().unwrap().to_owned()
    }

    #[tokio::test(start_paused = true)]
    async fn a_call_that_waits_too_long_for_its_turn_is_refused() {
        let model = OneAtATime::<()>::new();
        let _busy = Arc::clone(&model.turn).acquire_owned().await.unwrap();
        let asked = tokio::time::Instant::now();
        let refusal = model.run(|_| ()).await.unwrap_err();
        assert_eq!(asked.elapsed(), TURN_WAIT);
        assert_eq!(refusal.kind, refusal::RefusalKind::RateLimited);
        assert_eq!(refusal.message, BUSY);
    }

    #[tokio::test]
    async fn each_engine_on_the_server_is_asked_for_by_name() {
        assert_eq!(
            refusal("/api/voice/hear?engine=phonon2", "").await,
            VoiceError::Phonon2NotBuilt.to_string()
        );
        assert_eq!(
            refusal("/api/voice/speech?engine=phonon", r#"{"text":"Hi."}"#).await,
            VoiceError::PhononNotBuilt.to_string()
        );
    }
}
