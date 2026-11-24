//! The routes for what a user sends to a colleague's Jet: the sender's tap on a send card, and
//! the read that shows a card as it is after a reload. Another user's card is answered like a
//! card that does not exist.

use super::Server;
use crate::account::SignedIn;
use crate::chat::BridgeError;
use crate::objectives::InboxError;
use crate::on_worker;
use crate::store::{CardId, ReplyCard, ReplyCardId, SendCard};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::json;

pub(super) fn router() -> Router<Server> {
    Router::new()
        .route("/api/inbox/cards", get(cards))
        .route("/api/inbox/cards/{id}/send", post(tap))
        .route("/api/inbox/replies", get(replies))
        .route("/api/inbox/replies/{id}/send", post(tap_reply))
}

impl IntoResponse for InboxError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::NoSuchCard { .. } => StatusCode::NOT_FOUND,
            Self::CardNotOpen { .. } | Self::ItemClosed { .. } => StatusCode::CONFLICT,
            Self::NoSuchItem { .. } => StatusCode::NOT_FOUND,
            Self::SendLimit { .. } => StatusCode::TOO_MANY_REQUESTS,
            Self::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
            _ => StatusCode::BAD_REQUEST,
        };
        let body = json!({"kind": self.kind(), "message": self.to_string()});
        (status, Json(body)).into_response()
    }
}

#[derive(Deserialize)]
struct Ids {
    ids: String,
}

fn ids(query: &Ids) -> Vec<i64> {
    query
        .ids
        .split(',')
        .filter_map(|id| id.trim().parse().ok())
        .collect()
}

/// The cards of the signed-in user with the ids in `ids`, comma-separated, as they are now.
async fn cards(
    State(host): State<Server>,
    signed_in: SignedIn,
    Query(query): Query<Ids>,
) -> Result<Json<Vec<SendCard>>, Response> {
    let ids: Vec<CardId> = ids(&query).into_iter().map(CardId).collect();
    let user = signed_in.user.id;
    let found = on_worker(move || host.objectives.send_cards(user, &ids))
        .await
        .map_err(|failed| BridgeError::from(failed).into_response())?;
    Ok(Json(found.map_err(IntoResponse::into_response)?))
}

/// The sender's tap: stores the item and tells the recipient's Jet to bring it up.
async fn tap(
    State(host): State<Server>,
    signed_in: SignedIn,
    Path(id): Path<i64>,
) -> Result<Json<SendCard>, Response> {
    let user = signed_in.user.id;
    let chats = host.chats.clone();
    let sent = on_worker(move || host.objectives.tap_send(user, CardId(id)))
        .await
        .map_err(|failed| BridgeError::from(failed).into_response())?;
    let card = sent.map_err(IntoResponse::into_response)?;
    chats.pane_changed(user);
    chats.pane_changed(card.to.id);
    Ok(Json(card))
}

/// The reply cards of the signed-in user with the ids in `ids`, comma-separated, as they are now.
async fn replies(
    State(host): State<Server>,
    signed_in: SignedIn,
    Query(query): Query<Ids>,
) -> Result<Json<Vec<ReplyCard>>, Response> {
    let ids: Vec<ReplyCardId> = ids(&query).into_iter().map(ReplyCardId).collect();
    let user = signed_in.user.id;
    let found = on_worker(move || host.objectives.reply_cards(user, &ids))
        .await
        .map_err(|failed| BridgeError::from(failed).into_response())?;
    Ok(Json(found.map_err(IntoResponse::into_response)?))
}

/// The tap of the user a colleague's item was sent to: their words go back to the sender.
async fn tap_reply(
    State(host): State<Server>,
    signed_in: SignedIn,
    Path(id): Path<i64>,
) -> Result<Json<ReplyCard>, Response> {
    let user = signed_in.user.id;
    let chats = host.chats.clone();
    let sent = on_worker(move || host.objectives.tap_reply(user, ReplyCardId(id)))
        .await
        .map_err(|failed| BridgeError::from(failed).into_response())?;
    let (card, posted) = sent.map_err(IntoResponse::into_response)?;
    chats.announce_posted(&posted);
    chats.pane_changed(user);
    Ok(Json(card))
}
