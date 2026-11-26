//! The routes of the plan pane: one read of everything it draws, and the one-tap controls. A tap
//! on a thing that is not the signed-in user's is answered as a thing that does not exist.

use super::Server;
use crate::account::SignedIn;
use crate::chat::BridgeError;
use crate::objectives::{ObjectiveError, Pane};
use crate::on_worker;
use crate::store::TaskId;
use axum::{
    Json, Router,
    extract::{Path, State},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Serialize;

pub(super) fn router() -> Router<Server> {
    Router::new()
        .route("/api/pane", get(read))
        .route("/api/tasks/{id}/snooze", post(snooze))
        .route("/api/tasks/{id}/cancel", post(cancel))
}

/// Runs a read or a tap on a worker and, when it is a tap that worked, tells the user's pages.
async fn run<T: Serialize + Send + 'static>(
    host: Server,
    changes: bool,
    user: crate::store::UserId,
    call: impl FnOnce(&crate::objectives::Objectives) -> Result<T, ObjectiveError> + Send + 'static,
) -> Result<Json<T>, Response> {
    let objectives = host.objectives.clone();
    let done = on_worker(move || call(&objectives))
        .await
        .map_err(|failed| BridgeError::from(failed).into_response())?
        .map_err(IntoResponse::into_response)?;
    if changes {
        host.chats.pane_changed(user);
    }
    Ok(Json(done))
}

async fn read(State(host): State<Server>, signed_in: SignedIn) -> Result<Json<Pane>, Response> {
    let (user, is_admin) = (signed_in.user.id, signed_in.user.is_admin);
    let Json(pane) = run(host, false, user, move |objectives| objectives.pane(user)).await?;
    Ok(Json(if is_admin {
        pane
    } else {
        pane.without_admin_detail()
    }))
}

async fn snooze(
    State(host): State<Server>,
    signed_in: SignedIn,
    Path(id): Path<i64>,
) -> Result<Json<impl Serialize + use<>>, Response> {
    let user = signed_in.user.id;
    run(host, true, user, move |objectives| {
        objectives.tap_snooze(user, TaskId(id))
    })
    .await
}

async fn cancel(
    State(host): State<Server>,
    signed_in: SignedIn,
    Path(id): Path<i64>,
) -> Result<Json<impl Serialize + use<>>, Response> {
    let user = signed_in.user.id;
    let (chats, objectives) = (host.chats.clone(), host.objectives.clone());
    // A task that would have brought a colleague's item up is cancelled together with the item,
    // which ends as declined.
    let posted = on_worker(move || objectives.tap_cancel_item(user, TaskId(id)))
        .await
        .map_err(|failed| BridgeError::from(failed).into_response())?
        .map_err(IntoResponse::into_response)?;
    let item_closed = !posted.is_empty();
    let cancelled = run(host, true, user, move |objectives| {
        if item_closed {
            objectives.task(user, TaskId(id))
        } else {
            objectives.tap_cancel(user, TaskId(id))
        }
    })
    .await?;
    chats.announce_posted(&posted);
    Ok(cancelled)
}
