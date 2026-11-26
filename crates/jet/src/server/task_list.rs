//! The routes of the task list: one read of everything it draws, an older page of the done pile,
//! and the changes to its tasks and goals, each of which tells the user's pages. Every answer is
//! JSON, a refusal included, and another user's task or goal is answered as one that is gone.

use super::Server;
use crate::account::SignedIn;
use crate::chat::BridgeError;
use crate::objectives::{
    DonePage, GoalPatch, Objectives, TaskAdd, TaskList, TaskListError, TaskPatch, Written,
};
use crate::on_worker;
use crate::store::{ObjectiveId, StepId, UserId};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use serde::Deserialize;
use serde_json::json;

pub(super) fn router() -> Router<Server> {
    Router::new()
        .route("/api/task-list", get(read))
        .route("/api/task-list/done", get(done))
        .route("/api/task-list/tasks", post(add))
        .route("/api/task-list/tasks/{id}", patch(change).delete(remove))
        .route("/api/task-list/goals/{id}", patch(change_goal))
}

impl IntoResponse for TaskListError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::TaskGone | Self::GoalGone => StatusCode::NOT_FOUND,
            Self::GoalClosed => StatusCode::CONFLICT,
            Self::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
            _ => StatusCode::BAD_REQUEST,
        };
        let body = json!({"kind": self.kind(), "message": self.to_string()});
        (status, Json(body)).into_response()
    }
}

/// A body, a query or an id in the path that axum could not read is answered as `badBody`, in
/// JSON, rather than in axum's own plain text.
fn bad_body<E>(_: E) -> Response {
    TaskListError::BadBody.into_response()
}

/// Runs a call of the task list on a worker.
async fn run<T: Send + 'static>(
    host: &Server,
    call: impl FnOnce(&Objectives) -> Result<T, TaskListError> + Send + 'static,
) -> Result<T, Response> {
    let objectives = host.objectives.clone();
    on_worker(move || call(&objectives))
        .await
        .map_err(|failed| BridgeError::from(failed).into_response())?
        .map_err(IntoResponse::into_response)
}

/// Runs a write and tells the user's pages, and those of each colleague who sees a goal it
/// touched, that the list changed.
async fn write(
    host: &Server,
    user: UserId,
    call: impl FnOnce(&Objectives) -> Result<Written, TaskListError> + Send + 'static,
) -> Result<Json<TaskList>, Response> {
    let written = run(host, call).await?;
    host.chats.pane_changed(user);
    for goal in written.goals {
        host.chats.viewers_pane_changed(goal);
    }
    Ok(Json(written.list))
}

async fn read(State(host): State<Server>, signed_in: SignedIn) -> Result<Json<TaskList>, Response> {
    let user = signed_in.user.id;
    Ok(Json(
        run(&host, move |objectives| objectives.task_list(user)).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Before {
    before: u64,
    before_id: i64,
}

async fn done(
    State(host): State<Server>,
    signed_in: SignedIn,
    query: Result<Query<Before>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<DonePage>, Response> {
    let Query(before) = query.map_err(bad_body)?;
    let user = signed_in.user.id;
    let page = run(&host, move |objectives| {
        objectives.done_page(user, (before.before, StepId(before.before_id)))
    })
    .await?;
    Ok(Json(page))
}

async fn add(
    State(host): State<Server>,
    signed_in: SignedIn,
    body: Result<Json<TaskAdd>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<TaskList>, Response> {
    let Json(add) = body.map_err(bad_body)?;
    let user = signed_in.user.id;
    write(&host, user, move |objectives| {
        objectives.add_task(user, add)
    })
    .await
}

async fn change(
    State(host): State<Server>,
    signed_in: SignedIn,
    id: Result<Path<i64>, axum::extract::rejection::PathRejection>,
    body: Result<Json<TaskPatch>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<TaskList>, Response> {
    let (Path(id), Json(patch)) = (id.map_err(bad_body)?, body.map_err(bad_body)?);
    let user = signed_in.user.id;
    write(&host, user, move |objectives| {
        objectives.change_task(user, StepId(id), patch)
    })
    .await
}

async fn remove(
    State(host): State<Server>,
    signed_in: SignedIn,
    id: Result<Path<i64>, axum::extract::rejection::PathRejection>,
) -> Result<Json<TaskList>, Response> {
    let Path(id) = id.map_err(bad_body)?;
    let user = signed_in.user.id;
    write(&host, user, move |objectives| {
        objectives.delete_task(user, StepId(id))
    })
    .await
}

async fn change_goal(
    State(host): State<Server>,
    signed_in: SignedIn,
    id: Result<Path<i64>, axum::extract::rejection::PathRejection>,
    body: Result<Json<GoalPatch>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<TaskList>, Response> {
    let (Path(id), Json(patch)) = (id.map_err(bad_body)?, body.map_err(bad_body)?);
    let user = signed_in.user.id;
    let listed = write(&host, user, move |objectives| {
        objectives.change_goal(user, ObjectiveId(id), patch)
    })
    .await?;
    // A rename can rename the goal's chat too.
    host.chats.chats_changed(user, None);
    Ok(listed)
}
