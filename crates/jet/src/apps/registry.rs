//! Lets the page list the registered apps and change them.

use super::Apps;
use crate::{chat::BridgeError, lock, on_worker};
use agent::apps::{App, RegistryCommand, RegistryResult};
use axum::{
    Json, Router,
    extract::{FromRef, State},
    routing::get,
};

pub(super) fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Apps: FromRef<S>,
{
    Router::new().route("/api/apps", get(apps).post(update_apps))
}

async fn apps(State(state): State<Apps>) -> Result<Json<Vec<App>>, BridgeError> {
    Ok(Json(
        on_worker(move || lock(&state.registry).list().to_vec()).await?,
    ))
}
async fn update_apps(
    State(state): State<Apps>,
    Json(command): Json<RegistryCommand>,
) -> Result<Json<RegistryResult>, BridgeError> {
    Ok(Json(
        on_worker(move || {
            lock(&state.registry)
                .execute(command)
                .map_err(|error| BridgeError::InvalidRequest(error.to_string()))
        })
        .await??,
    ))
}
