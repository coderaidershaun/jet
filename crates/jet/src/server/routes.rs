//! Adapt browser requests to the conversation, and join the routes of accounts, apps, files,
//! voice, chats and the task list with them into the one router the server runs, behind the sign-in guard. A route
//! that acts on a chat takes its id from the `chat` query field, and acts on the main chat without
//! one.

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
use std::{convert::Infallible, sync::Arc};
use tokio::sync::{broadcast, mpsc};
use tokio_stream::wrappers::ReceiverStream;
use tower_http::services::ServeDir;

use super::{Server, chats};
use crate::{
    account::{self, SignedIn},
    apps,
    chat::{Accepted, AgentStatus, BridgeError, ChatState, ReactRequest, SendRequest, Snapshot},
    evidence, files, on_worker,
    settings::{AdminSettings, ProgramPaths, Settings},
    store::{ChatId, UserId},
    voice,
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
    let guard = middleware::from_fn_with_state(host.accounts.clone(), account::guard);
    Router::<Server>::new()
        .merge(account::router())
        .merge(apps::router())
        .merge(files::router())
        .merge(voice::router())
        .merge(evidence::router())
        .merge(super::shares::router())
        .merge(super::pane::router())
        .merge(super::task_list::router())
        .merge(super::inbox::router())
        .merge(chats::router())
        .route("/api/status", get(status))
        .route("/api/snapshot", get(snapshot))
        .route("/api/events", get(events))
        .route("/api/chat/send", post(send))
        .route("/api/chat/react", post(react))
        .route("/api/chat/stop", post(stop))
        .route("/api/chat/forget", post(forget))
        .route("/api/settings", get(load_settings).put(save_settings))
        .route("/api/memory", get(load_memory).put(save_memory))
        .route("/api/markdown", post(markdown))
        .route("/api/feel", post(feel))
        .fallback_service(ui)
        .layer(guard)
        .with_state(host)
        .merge(facade)
}

/// The chat a request is about: the `chat` query field, or the main chat when it is left out.
#[derive(Deserialize)]
pub(super) struct ChatQuery {
    chat: Option<i64>,
}

/// Runs `call` on the signed-in user's chat away from the server's own threads. A chat that is not
/// theirs gets the answer of a chat that does not exist.
async fn in_chat<T: Send + 'static>(
    host: &Server,
    user: UserId,
    query: ChatQuery,
    call: impl FnOnce(Arc<ChatState>) -> Result<T, BridgeError> + Send + 'static,
) -> Result<T, BridgeError> {
    let chats = host.chats.clone();
    on_worker(move || call(chats.chat(user, query.chat.map(ChatId))?)).await?
}

/// What the chat page reads: the status of a chat of the signed-in user. The places of the provider programs
/// are left out for anyone who is not an admin.
async fn status(
    State(host): State<Server>,
    signed_in: SignedIn,
    Query(query): Query<ChatQuery>,
) -> Result<Json<AgentStatus>, BridgeError> {
    let user = signed_in.user;
    let status = in_chat(&host, user.id, query, |chat| chat.status()).await?;
    Ok(Json(match user.is_admin {
        true => status,
        false => status.without_program_paths(),
    }))
}
async fn snapshot(
    State(host): State<Server>,
    signed_in: SignedIn,
    Query(query): Query<ChatQuery>,
) -> Result<Json<Snapshot>, BridgeError> {
    let snapshot = in_chat(&host, signed_in.user.id, query, |chat| chat.snapshot()).await?;
    Ok(Json(snapshot))
}
async fn send(
    State(host): State<Server>,
    signed_in: SignedIn,
    Query(query): Query<ChatQuery>,
    Json(request): Json<SendRequest>,
) -> Result<Json<Accepted>, BridgeError> {
    let accepted = in_chat(&host, signed_in.user.id, query, |chat| chat.send(request)).await?;
    Ok(Json(accepted))
}
async fn react(
    State(host): State<Server>,
    signed_in: SignedIn,
    Query(query): Query<ChatQuery>,
    Json(request): Json<ReactRequest>,
) -> Result<Json<Value>, BridgeError> {
    let entry = in_chat(&host, signed_in.user.id, query, |chat| chat.react(request)).await?;
    Ok(Json(json!({"entry": entry})))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopRequest {
    request_id: String,
}
async fn stop(
    State(host): State<Server>,
    signed_in: SignedIn,
    Query(query): Query<ChatQuery>,
    Json(request): Json<StopRequest>,
) -> Result<Json<Value>, BridgeError> {
    in_chat(&host, signed_in.user.id, query, move |chat| {
        chat.stop(&request.request_id)
    })
    .await?;
    Ok(Json(json!({})))
}
async fn forget(
    State(host): State<Server>,
    signed_in: SignedIn,
    Query(query): Query<ChatQuery>,
) -> Result<Json<Value>, BridgeError> {
    in_chat(&host, signed_in.user.id, query, |chat| chat.forget()).await?;
    Ok(Json(json!({})))
}
/// The user's settings; an admin's carry the server's program paths beside them.
async fn load_settings(
    State(host): State<Server>,
    signed_in: SignedIn,
) -> Result<Json<Value>, BridgeError> {
    let user = signed_in.user;
    on_worker(move || {
        let settings = host.store.settings(user.id)?;
        Ok(Json(match user.is_admin {
            true => json!(AdminSettings {
                settings,
                paths: host.store.program_paths()?,
            }),
            false => json!(settings),
        }))
    })
    .await?
}
/// Saves the user's settings. The program paths in an admin's body are saved for the server;
/// in anyone else's they are ignored.
async fn save_settings(
    State(host): State<Server>,
    signed_in: SignedIn,
    Json(body): Json<Value>,
) -> Result<Json<Value>, BridgeError> {
    let user = signed_in.user;
    let settings: Settings = serde_json::from_value(body.clone())
        .map_err(|error| BridgeError::InvalidRequest(format!("invalid settings: {error}")))?;
    let paths = (user.is_admin && ProgramPaths::named_in(&body))
        .then(|| serde_json::from_value::<ProgramPaths>(body))
        .transpose()
        .map_err(|error| BridgeError::InvalidRequest(format!("invalid program path: {error}")))?;
    on_worker(move || {
        host.store.set_settings(user.id, &settings)?;
        if let Some(paths) = paths {
            host.store.set_program_paths(&paths)?;
        }
        Ok(Json(json!({})))
    })
    .await?
}
async fn load_memory(
    State(host): State<Server>,
    signed_in: SignedIn,
) -> Result<Json<Value>, BridgeError> {
    let user = signed_in.user.id;
    on_worker(move || {
        let notes = host.chats.main(user)?.conversation.notes()?;
        Ok(Json(json!({"memory":notes.memory,"user":notes.user,"recent":notes.recent,
            "limits":{"memory":agent::MEMORY_LIMIT,"user":agent::USER_LIMIT,"recent":agent::RECENT_LIMIT}})))
    }).await?
}
async fn save_memory(
    State(host): State<Server>,
    signed_in: SignedIn,
    Json(notes): Json<Notes>,
) -> Result<Json<Notes>, BridgeError> {
    let user = signed_in.user.id;
    on_worker(move || {
        let notes = host.chats.main(user)?.conversation.save_notes(notes)?;
        host.chats.notes_changed(user, &notes);
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
/// Where a page that reconnects left off, and the chat it shows, whose snapshot it gets when
/// it cannot resume.
#[derive(Deserialize)]
struct Resume {
    epoch: Option<String>,
    cursor: Option<u64>,
    chat: Option<i64>,
}
/// How often an open event stream checks that its sign-in has not ended.
const SIGNIN_CHECK: std::time::Duration = std::time::Duration::from_secs(15);

async fn events(
    State(host): State<Server>,
    signed_in: SignedIn,
    Query(resume): Query<Resume>,
) -> Result<impl axum::response::IntoResponse, BridgeError> {
    let (chats, user) = (host.chats.clone(), signed_in.user.id);
    let accounts = host.accounts.clone();
    let (initial, mut receiver) = on_worker(move || {
        chats
            .chat(user, resume.chat.map(ChatId))?
            .subscribe(resume.epoch.as_deref(), resume.cursor)
    })
    .await??;
    let (sender, stream) = mpsc::channel(32);
    tokio::spawn(async move {
        for value in initial {
            if send_event(&sender, &value).await.is_err() {
                return;
            }
        }
        let mut checks = tokio::time::interval(SIGNIN_CHECK);
        loop {
            let received = tokio::select! {
                received = receiver.recv() => received,
                _ = checks.tick() => {
                    if accounts.is_live(&signed_in) { continue } else { break }
                }
            };
            match received {
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
