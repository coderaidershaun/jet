//! Adapt browser requests to the shared conversation and registry operations.

use agent::{Notes, apps::RegistryCommand};
use axum::{
    Json, Router,
    extract::{Query, State},
    response::{
        Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::convert::Infallible;
use tokio::sync::{broadcast, mpsc};
use tokio_stream::wrappers::ReceiverStream;
use tower_http::services::ServeDir;

use super::Server;
use crate::{
    chat::{BridgeError, SendRequest, lock},
    settings,
};

pub(super) fn router(host: Server) -> Router {
    let facade = host.facade.router();
    Router::new()
        .merge(super::tools::router())
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
        .route("/api/apps", get(apps).post(update_apps))
        .merge(crate::proxy::router())
        .fallback_service(ServeDir::new(&host.config.ui_dir))
        .with_state(host)
        .merge(facade)
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, BridgeError> + Send + 'static,
) -> Result<Json<T>, BridgeError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| BridgeError::Io(format!("request worker failed: {error}")))?
        .map(Json)
}

async fn status(State(host): State<Server>) -> Result<Json<Value>, BridgeError> {
    blocking(move || Ok(json!(host.chat.status()?))).await
}
async fn snapshot(State(host): State<Server>) -> Result<Json<Value>, BridgeError> {
    blocking(move || Ok(json!(host.chat.snapshot()?))).await
}
async fn send(
    State(host): State<Server>,
    Json(request): Json<SendRequest>,
) -> Result<Json<Value>, BridgeError> {
    blocking(move || Ok(json!(host.chat.send(request)?))).await
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
    blocking(move || {
        host.chat.forget()?;
        Ok(json!({}))
    })
    .await
}
async fn load_settings(
    State(host): State<Server>,
) -> Result<Json<settings::Settings>, BridgeError> {
    blocking(move || {
        Ok(settings::read_from(
            &host.config.data_dir.join(settings::FILE_NAME),
        )?)
    })
    .await
}
async fn save_settings(
    State(host): State<Server>,
    Json(settings): Json<settings::Settings>,
) -> Result<Json<Value>, BridgeError> {
    blocking(move || {
        settings::write_to(&host.config.data_dir.join(settings::FILE_NAME), &settings)?;
        Ok(json!({}))
    })
    .await
}
async fn load_memory(State(host): State<Server>) -> Result<Json<Value>, BridgeError> {
    blocking(move || {
        let notes = host.chat.conversation.notes()?;
        Ok(json!({"memory":notes.memory,"user":notes.user,"recent":notes.recent,
            "limits":{"memory":agent::MEMORY_LIMIT,"user":agent::USER_LIMIT,"recent":agent::RECENT_LIMIT}}))
    }).await
}
async fn save_memory(
    State(host): State<Server>,
    Json(notes): Json<Notes>,
) -> Result<Json<Notes>, BridgeError> {
    blocking(move || {
        let notes = host.chat.conversation.save_notes(notes)?;
        host.chat.memory_updated(notes.clone());
        Ok(notes)
    })
    .await
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
) -> Result<Json<Value>, BridgeError> {
    if host.config.disable_feelings {
        return Ok(Json(json!({"mood":"neutral","scores":{}})));
    }
    blocking(move || {
        agent::feel_message(&text.text)
            .map(|feeling| json!(feeling))
            .map_err(|error| BridgeError::Io(error.to_string()))
    })
    .await
}
async fn apps(State(host): State<Server>) -> Result<Json<Value>, BridgeError> {
    blocking(move || Ok(json!(lock(&host.registry).list()))).await
}
async fn update_apps(
    State(host): State<Server>,
    Json(command): Json<RegistryCommand>,
) -> Result<Json<Value>, BridgeError> {
    blocking(move || {
        lock(&host.registry)
            .execute(command)
            .map(|result| json!(result))
            .map_err(|error| BridgeError::InvalidRequest(error.to_string()))
    })
    .await
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
        tokio::task::spawn_blocking(move || chat.subscribe(resume.epoch.as_deref(), resume.cursor))
            .await
            .map_err(|error| BridgeError::Io(error.to_string()))??;
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
