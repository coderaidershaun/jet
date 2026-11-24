//! The routes for share cards: the owner's tap that applies one, the read that shows a card as it
//! is after a reload, and what the objective's own pane calls to change who an objective is
//! shared with.

use super::Server;
use crate::account::SignedIn;
use crate::chat::BridgeError;
use crate::objectives::{Directory, ObjectiveError};
use crate::on_worker;
use crate::store::{ObjectiveId, ProposalId, ShareCard, Sharing, UserId};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use serde::Deserialize;
use serde_json::{Value, json};

pub(super) fn router() -> Router<Server> {
    Router::new()
        .route("/api/shares/proposals", get(cards))
        .route("/api/shares/proposals/{id}/apply", post(tap))
        .route("/api/objectives/{id}/shares", get(sharing))
        .route("/api/objectives/{id}/directory", get(directory))
        .route("/api/objectives/{id}/share-proposals", post(propose))
        .route("/api/objectives/{id}/notes/{note}", put(flip_note))
}

impl IntoResponse for ObjectiveError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::NoSuchObjective { .. }
            | Self::NoSuchStep { .. }
            | Self::NoSuchTask { .. }
            | Self::NoSuchNote { .. }
            | Self::NoSuchProposal { .. } => StatusCode::NOT_FOUND,
            Self::ProposalNotOpen { .. } => StatusCode::CONFLICT,
            Self::NotAdmin => StatusCode::FORBIDDEN,
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

/// The cards of the signed-in user with the ids in `ids`, comma-separated, as they are now.
async fn cards(
    State(host): State<Server>,
    signed_in: SignedIn,
    Query(query): Query<Ids>,
) -> Result<Json<Vec<ShareCard>>, Response> {
    let ids: Vec<ProposalId> = query
        .ids
        .split(',')
        .filter_map(|id| id.trim().parse().ok().map(ProposalId))
        .collect();
    let user = signed_in.user.id;
    let found = on_worker(move || host.objectives.share_cards(user, &ids))
        .await
        .map_err(|failed| BridgeError::from(failed).into_response())?;
    Ok(Json(found.map_err(IntoResponse::into_response)?))
}

#[derive(Deserialize)]
struct Ticked {
    #[serde(default)]
    people: Vec<i64>,
    #[serde(default)]
    teams: Vec<i64>,
}

impl Ticked {
    fn people(&self) -> Vec<UserId> {
        self.people.iter().copied().map(UserId).collect()
    }
}

/// The owner's tap: applies exactly the ticked people and teams of the card.
async fn tap(
    State(host): State<Server>,
    signed_in: SignedIn,
    Path(id): Path<i64>,
    Json(ticked): Json<Ticked>,
) -> Result<Json<ShareCard>, Response> {
    let user = signed_in.user.id;
    let applied = on_worker(move || {
        host.objectives
            .apply_share(user, ProposalId(id), &ticked.people(), &ticked.teams)
    })
    .await
    .map_err(|failed| BridgeError::from(failed).into_response())?;
    let card = applied.map_err(IntoResponse::into_response)?;
    host.chats.pane_changed(user);
    host.chats.viewers_pane_changed(card.objective_id);
    Ok(Json(card))
}

async fn sharing(
    State(host): State<Server>,
    signed_in: SignedIn,
    Path(id): Path<i64>,
) -> Result<Json<Sharing>, Response> {
    let user = signed_in.user.id;
    let found = on_worker(move || host.objectives.sharing(user, ObjectiveId(id)))
        .await
        .map_err(|failed| BridgeError::from(failed).into_response())?;
    Ok(Json(found.map_err(IntoResponse::into_response)?))
}

async fn directory(
    State(host): State<Server>,
    signed_in: SignedIn,
    Path(id): Path<i64>,
) -> Result<Json<Directory>, Response> {
    let user = signed_in.user.id;
    let found = on_worker(move || host.objectives.directory(user, ObjectiveId(id)))
        .await
        .map_err(|failed| BridgeError::from(failed).into_response())?;
    Ok(Json(found.map_err(IntoResponse::into_response)?))
}

/// A card made from the objective's pane. It shares nothing until it is tapped, like Jet's own.
async fn propose(
    State(host): State<Server>,
    signed_in: SignedIn,
    Path(id): Path<i64>,
    Json(set): Json<Ticked>,
) -> Result<Json<ShareCard>, Response> {
    let user = signed_in.user.id;
    let made = on_worker(move || {
        host.objectives
            .propose_share_from_pane(user, ObjectiveId(id), &set.people(), &set.teams)
    })
    .await
    .map_err(|failed| BridgeError::from(failed).into_response())?;
    Ok(Json(made.map_err(IntoResponse::into_response)?))
}

#[derive(Deserialize)]
struct Privacy {
    private: bool,
}

async fn flip_note(
    State(host): State<Server>,
    signed_in: SignedIn,
    Path((id, note)): Path<(i64, i64)>,
    Json(privacy): Json<Privacy>,
) -> Result<Json<Value>, Response> {
    let user = signed_in.user.id;
    let chats = host.chats.clone();
    let flipped = on_worker(move || {
        let objectives = &host.objectives;
        objectives.set_note_private(user, ObjectiveId(id), note, privacy.private)?;
        objectives.note_flipped(user, ObjectiveId(id), note, privacy.private)
    })
    .await
    .map_err(|failed| BridgeError::from(failed).into_response())?;
    flipped.map_err(IntoResponse::into_response)?;
    chats.pane_changed(user);
    chats.viewers_pane_changed(ObjectiveId(id));
    Ok(Json(json!({"id": note, "private": privacy.private})))
}
