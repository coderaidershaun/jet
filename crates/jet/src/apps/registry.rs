//! Lets the page list the signed-in user's apps and change them.

use super::Apps;
use crate::{account::SignedIn, chat::BridgeError, on_worker};
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

async fn apps(
    State(apps): State<Apps>,
    signed_in: SignedIn,
) -> Result<Json<Vec<App>>, BridgeError> {
    let user = signed_in.user.id;
    Ok(Json(on_worker(move || apps.list(user)).await?))
}
async fn update_apps(
    State(apps): State<Apps>,
    signed_in: SignedIn,
    Json(command): Json<RegistryCommand>,
) -> Result<Json<RegistryResult>, BridgeError> {
    let user = signed_in.user.id;
    Ok(Json(on_worker(move || apps.execute(user, command)).await??))
}
