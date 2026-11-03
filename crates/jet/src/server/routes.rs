//! Adapt browser requests to the conversation, and join the routes of apps, files and voice with
//! them into the one router the server runs.

use agent::{Feeling, Notes};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderValue, header::CACHE_CONTROL},
    middleware,
    response::{
        Response, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, get_service, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::convert::Infallible;
use tokio::sync::{broadcast, mpsc};
use tokio_stream::wrappers::ReceiverStream;
use tower_http::services::ServeDir;

use super::Server;
use crate::{
    apps,
    chat::{Accepted, AgentStatus, BridgeError, SendRequest, Snapshot},
    files, on_worker, settings, voice,
};

pub(super) fn router(host: Server) -> Router {
    let facade = host.facade.router();
    let ui = get_service(ServeDir::new(&host.config.ui_dir)).layer(middleware::map_response(
        |mut response: Response| async move {
            response
                .headers_mut()
                .insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
            response
        },
    ));
    Router::<Server>::new()
        .merge(apps::router())
        .merge(files::router())
        .merge(voice::router())
        .route("/api/status", get(status))
        .route("/api/snapshot", get(snapshot))
        .route("/api/events", get(events))
        .route("/api/chat/send", post(send))
        .route("/api/chat/stop", post(stop))
        .route("/api/chat/forget", post(forget))
        .route("/api/settings", get(load_settings).put(save_settings))
        .route("/api/memory", get(load_memory).put(save_memory))
        .route("/api/markdown", post(markdown))
        .route("/api/feel", post(feel))
        .fallback_service(ui)
        .with_state(host)
        .merge(facade)
}

async fn status(State(host): State<Server>) -> Result<Json<AgentStatus>, BridgeError> {
    Ok(Json(on_worker(move || host.chat.status()).await??))
}
async fn snapshot(State(host): State<Server>) -> Result<Json<Snapshot>, BridgeError> {
    Ok(Json(on_worker(move || host.chat.snapshot()).await??))
}
async fn send(
    State(host): State<Server>,
    Json(request): Json<SendRequest>,
) -> Result<Json<Accepted>, BridgeError> {
    Ok(Json(on_worker(move || host.chat.send(request)).await??))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopRequest {
    request_id: String,
}
async fn stop(
    State(host): State<Server>,
    Json(request): Json<StopRequest>,
) -> Result<Json<Value>, BridgeError> {
    host.chat.stop(&request.request_id)?;
    Ok(Json(json!({})))
}
async fn forget(State(host): State<Server>) -> Result<Json<Value>, BridgeError> {
    on_worker(move || {
        host.chat.forget()?;
        Ok(Json(json!({})))
    })
    .await?
}
async fn load_settings(
    State(host): State<Server>,
) -> Result<Json<settings::Settings>, BridgeError> {
    on_worker(move || Ok(Json(settings::read_from(&host.config.data_dir)?))).await?
}
async fn save_settings(
    State(host): State<Server>,
    Json(settings): Json<settings::Settings>,
) -> Result<Json<Value>, BridgeError> {
    on_worker(move || {
        settings::write_to(&host.config.data_dir, &settings)?;
        Ok(Json(json!({})))
    })
    .await?
}
async fn load_memory(State(host): State<Server>) -> Result<Json<Value>, BridgeError> {
    on_worker(move || {
        let notes = host.chat.conversation.notes()?;
        Ok(Json(json!({"memory":notes.memory,"user":notes.user,"recent":notes.recent,
            "limits":{"memory":agent::MEMORY_LIMIT,"user":agent::USER_LIMIT,"recent":agent::RECENT_LIMIT}})))
    }).await?
}
async fn save_memory(
    State(host): State<Server>,
    Json(notes): Json<Notes>,
) -> Result<Json<Notes>, BridgeError> {
    on_worker(move || {
        let notes = host.chat.conversation.save_notes(notes)?;
        host.chat.memory_updated(notes.clone());
        Ok(Json(notes))
    })
    .await?
}
#[derive(Deserialize)]
struct Text {
    text: String,
}
async fn markdown(Json(text): Json<Text>) -> Json<String> {
    Json(agent::render_markdown(&text.text))
}
async fn feel(
    State(host): State<Server>,
    Json(text): Json<Text>,
) -> Result<Json<Feeling>, BridgeError> {
    if host.config.disable_feelings {
        return Ok(Json(Feeling::neutral()));
    }
    on_worker(move || {
        agent::feel_message(&text.text)
            .map(Json)
            .map_err(|error| BridgeError::Io(error.to_string()))
    })
    .await?
}
#[derive(Deserialize)]
struct Resume {
    epoch: Option<String>,
    cursor: Option<u64>,
}
async fn events(
    State(host): State<Server>,
    Query(resume): Query<Resume>,
) -> Result<impl axum::response::IntoResponse, BridgeError> {
    let chat = host.chat.clone();
    let (initial, mut receiver) =
        on_worker(move || chat.subscribe(resume.epoch.as_deref(), resume.cursor)).await??;
    let (sender, stream) = mpsc::channel(32);
    tokio::spawn(async move {
        for value in initial {
            if send_event(&sender, &value).await.is_err() {
                return;
            }
        }
        loop {
            match receiver.recv().await {
                Ok(envelope) => {
                    let shutdown = envelope.event["kind"] == "shutdown";
                    if send_event(&sender, &json!({"kind":"event","data":envelope}))
                        .await
                        .is_err()
                        || shutdown
                    {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    if let Err(error) = send_event(&sender, &json!({"kind":"resync"})).await {
                        eprintln!("jet: event resync receiver closed: {error}");
                    }
                    break;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    Ok(Sse::new(ReceiverStream::new(stream)).keep_alive(KeepAlive::default()))
}

async fn send_event(
    sender: &mpsc::Sender<Result<Event, Infallible>>,
    value: &Value,
) -> Result<(), mpsc::error::SendError<Result<Event, Infallible>>> {
    sender
        .send(Ok(Event::default().data(value.to_string())))
        .await
}
