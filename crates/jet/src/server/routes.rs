//! Adapt browser requests to the shared conversation and registry operations.

use agent::{
    Feeling, Notes,
    apps::{App, RegistryCommand, RegistryResult},
};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{
        HeaderValue, StatusCode,
        header::{
            CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_SECURITY_POLICY, CONTENT_TYPE,
            X_CONTENT_TYPE_OPTIONS,
        },
    },
    middleware,
    response::{
        IntoResponse, Response, Sse,
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
    chat::{Accepted, AgentStatus, BridgeError, SendRequest, Snapshot, lock},
    files::{About, FileKind, MAX_FILE_BYTES},
    settings,
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
    Router::new()
        .merge(super::tools::router())
        .merge(super::voice::router())
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
        .route(
            "/api/files",
            post(upload_file).layer(DefaultBodyLimit::max(UPLOAD_BODY_LIMIT)),
        )
        .route("/api/files/{id}", get(download_file).delete(remove_file))
        .route("/api/files/{id}/view", get(view_file))
        .merge(super::proxy::router())
        .fallback_service(ui)
        .with_state(host)
        .merge(facade)
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, BridgeError> + Send + 'static,
) -> Result<Json<T>, BridgeError> {
    on_worker(work).await.map(Json)
}
async fn on_worker<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, BridgeError> + Send + 'static,
) -> Result<T, BridgeError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| BridgeError::Io(format!("request worker failed: {error}")))?
}

async fn status(State(host): State<Server>) -> Result<Json<AgentStatus>, BridgeError> {
    blocking(move || host.chat.status()).await
}
async fn snapshot(State(host): State<Server>) -> Result<Json<Snapshot>, BridgeError> {
    blocking(move || host.chat.snapshot()).await
}
async fn send(
    State(host): State<Server>,
    Json(request): Json<SendRequest>,
) -> Result<Json<Accepted>, BridgeError> {
    blocking(move || host.chat.send(request)).await
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
    blocking(move || Ok(settings::read_from(&host.config.data_dir)?)).await
}
async fn save_settings(
    State(host): State<Server>,
    Json(settings): Json<settings::Settings>,
) -> Result<Json<Value>, BridgeError> {
    blocking(move || {
        settings::write_to(&host.config.data_dir, &settings)?;
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
) -> Result<Json<Feeling>, BridgeError> {
    if host.config.disable_feelings {
        return Ok(Json(Feeling::neutral()));
    }
    blocking(move || {
        agent::feel_message(&text.text).map_err(|error| BridgeError::Io(error.to_string()))
    })
    .await
}
async fn apps(State(host): State<Server>) -> Result<Json<Vec<App>>, BridgeError> {
    blocking(move || Ok(lock(&host.registry).list().to_vec())).await
}
async fn update_apps(
    State(host): State<Server>,
    Json(command): Json<RegistryCommand>,
) -> Result<Json<RegistryResult>, BridgeError> {
    blocking(move || {
        lock(&host.registry)
            .execute(command)
            .map_err(|error| BridgeError::InvalidRequest(error.to_string()))
    })
    .await
}

/// A little over the largest file, so that the exact limit is enforced where the file is kept and
/// the page gets its message instead of a bare refusal.
const UPLOAD_BODY_LIMIT: usize = MAX_FILE_BYTES + 64 * 1024;

#[derive(Deserialize)]
struct UploadName {
    name: String,
}
/// Keeps the request body as an upload. The file is hidden from Jet until a message carries it.
// SMELL: each upload is held in memory whole until it is written, and nothing limits how many
// arrive at once, so the server's memory grows with the bytes that visitors are sending.
async fn upload_file(
    State(host): State<Server>,
    Query(query): Query<UploadName>,
    body: Bytes,
) -> Result<Json<About>, BridgeError> {
    Ok(Json(host.files.upload(&query.name, Vec::from(body)).await?))
}
/// Deletes an upload that was never sent.
async fn remove_file(
    State(host): State<Server>,
    Path(id): Path<String>,
) -> Result<StatusCode, BridgeError> {
    on_worker(move || Ok(host.files.remove(&id)?)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Even an HTML file opened on Jet's own address can run nothing and load nothing.
const FILE_POLICY: &str = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'";

#[derive(Clone, Copy, PartialEq)]
enum Disposition {
    Attachment,
    Inline,
}

async fn download_file(
    State(host): State<Server>,
    Path(id): Path<String>,
) -> Result<Response, BridgeError> {
    serve_file(host, id, Disposition::Attachment).await
}
async fn view_file(
    State(host): State<Server>,
    Path(id): Path<String>,
) -> Result<Response, BridgeError> {
    serve_file(host, id, Disposition::Inline).await
}

async fn serve_file(
    host: Server,
    id: String,
    disposition: Disposition,
) -> Result<Response, BridgeError> {
    let file = on_worker(move || Ok(host.files.open(&id)?)).await?;
    let content_type = match disposition {
        Disposition::Attachment => file.kind.download_type(),
        Disposition::Inline => file.kind.view_type(),
    };
    let headers = [
        (CONTENT_TYPE, HeaderValue::from_static(content_type)),
        (
            CONTENT_DISPOSITION,
            content_disposition(&file.name, disposition)
                .ok_or_else(|| BridgeError::Io("the file name cannot be sent".into()))?,
        ),
        (X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")),
        (CACHE_CONTROL, HeaderValue::from_static("private, no-cache")),
    ];
    // A PDF gets no policy because Chrome's PDF viewer stays blank under one. The risk is small:
    // browsers keep a PDF's scripts inside the viewer, this address has no login or cookie, and
    // `nosniff` stops any other file being treated as a PDF.
    let policy = (file.kind != FileKind::Pdf).then(|| {
        [(
            CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(FILE_POLICY),
        )]
    });
    Ok((headers, policy, file.contents).into_response())
}

/// The disposition with a plain ASCII `filename` for old browsers and the exact name in
/// `filename*`, percent-encoded.
fn content_disposition(name: &str, disposition: Disposition) -> Option<HeaderValue> {
    let kind = match disposition {
        Disposition::Attachment => "attachment",
        Disposition::Inline => "inline",
    };
    let is_plain = |c: char| c == ' ' || (c.is_ascii_graphic() && !matches!(c, '"' | '\\'));
    let plain: String = name
        .chars()
        .map(|c| if is_plain(c) { c } else { '_' })
        .collect();
    let mut encoded = String::new();
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    HeaderValue::from_str(&format!(
        "{kind}; filename=\"{plain}\"; filename*=UTF-8''{encoded}"
    ))
    .ok()
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
