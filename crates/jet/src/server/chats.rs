//! The routes that list, add, rename and delete the signed-in user's chats and move their read
//! marks. Every route finds the chat through the signed-in user.

use axum::{
    Json, Router,
    extract::{Path, State},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::Server;
use crate::{
    account::SignedIn,
    chat::BridgeError,
    on_worker,
    store::{ChatId, ChatSummary},
};

pub(super) fn router() -> Router<Server> {
    Router::new()
        .route("/api/chats", get(list).post(add))
        .route(
            "/api/chats/{chat}",
            axum::routing::patch(rename).delete(delete),
        )
        .route("/api/chats/{chat}/read", post(read))
}

#[derive(Deserialize)]
struct NewChat {
    title: Option<String>,
}

#[derive(Deserialize)]
struct Title {
    title: String,
}

#[derive(Deserialize)]
struct Read {
    /// The id of the newest entry the user has seen; the newest entry of the chat when left out.
    through: Option<u64>,
}

async fn list(
    State(host): State<Server>,
    signed_in: SignedIn,
) -> Result<Json<Vec<ChatSummary>>, BridgeError> {
    let user = signed_in.user.id;
    Ok(Json(on_worker(move || host.chats.list(user)).await??))
}

async fn add(
    State(host): State<Server>,
    signed_in: SignedIn,
    Json(new): Json<NewChat>,
) -> Result<Json<ChatSummary>, BridgeError> {
    let user = signed_in.user.id;
    Ok(Json(
        on_worker(move || host.chats.add(user, new.title.as_deref())).await??,
    ))
}

async fn rename(
    State(host): State<Server>,
    signed_in: SignedIn,
    Path(chat): Path<i64>,
    Json(Title { title }): Json<Title>,
) -> Result<Json<Value>, BridgeError> {
    let user = signed_in.user.id;
    on_worker(move || host.chats.rename(user, ChatId(chat), &title)).await??;
    Ok(Json(json!({})))
}

async fn delete(
    State(host): State<Server>,
    signed_in: SignedIn,
    Path(chat): Path<i64>,
) -> Result<Json<Value>, BridgeError> {
    let user = signed_in.user.id;
    on_worker(move || host.chats.delete(user, ChatId(chat))).await??;
    Ok(Json(json!({})))
}

async fn read(
    State(host): State<Server>,
    signed_in: SignedIn,
    Path(chat): Path<i64>,
    Json(Read { through }): Json<Read>,
) -> Result<Json<Value>, BridgeError> {
    let user = signed_in.user.id;
    let unread = on_worker(move || host.chats.read(user, ChatId(chat), through)).await??;
    Ok(Json(json!({"unread": unread})))
}
