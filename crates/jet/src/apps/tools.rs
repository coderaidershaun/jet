//! Expose catalogue inspection, explicitly marked free discovery and the read-only status of
//! marked jobs to the browser.
use super::Apps;
use crate::{account::SignedIn, chat::MAX_ID_BYTES};
use agent::{
    apps::AppId,
    mcp_client::{ToolCatalogue, ToolRequest, ToolTarget},
};
use axum::{
    Json, Router,
    extract::{FromRef, Path, State},
    http::StatusCode,
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};

type Error = (StatusCode, Json<Value>);
fn error(error: impl serde::Serialize) -> Error {
    (StatusCode::BAD_GATEWAY, Json(json!({"error":error})))
}
/// Refuses an app that is not the signed-in user's, as if it did not exist.
fn check_owned(apps: &Apps, signed_in: &SignedIn, id: &AppId) -> Result<(), Error> {
    match apps.owned(signed_in.user.id, id) {
        Some(_) => Ok(()),
        None => Err((
            StatusCode::NOT_FOUND,
            Json(json!({"error": format!("app {id} is not registered")})),
        )),
    }
}
pub(super) fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Apps: FromRef<S>,
{
    Router::new()
        .route("/api/apps/{id}/tools", get(catalogue).post(refresh))
        .route("/api/apps/{id}/discovery", post(discover))
        .route("/api/apps/{id}/status", post(status))
        .route("/api/tools/cancel", post(cancel))
}
async fn catalogue(
    State(apps): State<Apps>,
    signed_in: SignedIn,
    Path(id): Path<AppId>,
) -> Result<Json<ToolCatalogue>, Error> {
    check_owned(&apps, &signed_in, &id)?;
    apps.mcp.catalogue(&id).await.map(Json).map_err(error)
}
async fn refresh(
    State(apps): State<Apps>,
    signed_in: SignedIn,
    Path(id): Path<AppId>,
) -> Result<Json<ToolCatalogue>, Error> {
    check_owned(&apps, &signed_in, &id)?;
    apps.mcp.refresh(&id).await.map(Json).map_err(error)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserToolRequest {
    request_id: String,
    tool: String,
    arguments: serde_json::Map<String, Value>,
}
impl BrowserToolRequest {
    /// The request, named by the user and the request id so that `/api/tools/cancel` can stop it,
    /// and only for that user.
    fn into_request(self, signed_in: &SignedIn, app_id: AppId) -> Result<ToolRequest, Error> {
        if self.request_id.is_empty() || self.request_id.len() > MAX_ID_BYTES {
            return Err(error(format!(
                "requestId must contain 1 to {MAX_ID_BYTES} bytes"
            )));
        }
        Ok(ToolRequest {
            request_id: browser_request(signed_in, &self.request_id),
            target: ToolTarget {
                app_id,
                tool: self.tool,
            },
            arguments: self.arguments,
        })
    }
}
async fn discover(
    State(apps): State<Apps>,
    signed_in: SignedIn,
    Path(id): Path<AppId>,
    Json(request): Json<BrowserToolRequest>,
) -> Result<Json<Value>, Error> {
    check_owned(&apps, &signed_in, &id)?;
    let result = apps
        .mcp
        .discover(request.into_request(&signed_in, id.clone())?)
        .await
        .map_err(error)?;
    let catalogue = apps.mcp.refresh(&id).await.map_err(error)?;
    Ok(Json(json!({"result":result,"catalogue":catalogue})))
}
/// Reads the status of a job. Only a tool that carries the job marker and promises to only read
/// is called, and what it returns is data for the page to check.
async fn status(
    State(apps): State<Apps>,
    signed_in: SignedIn,
    Path(id): Path<AppId>,
    Json(request): Json<BrowserToolRequest>,
) -> Result<Json<Value>, Error> {
    check_owned(&apps, &signed_in, &id)?;
    let result = apps
        .mcp
        .status(request.into_request(&signed_in, id)?)
        .await
        .map_err(error)?;
    Ok(Json(json!({"result":result})))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelRequest {
    request_id: String,
}
async fn cancel(
    State(apps): State<Apps>,
    signed_in: SignedIn,
    Json(request): Json<CancelRequest>,
) -> Json<Value> {
    apps.mcp
        .cancel_request(&browser_request(&signed_in, &request.request_id));
    Json(json!({}))
}
fn browser_request(signed_in: &SignedIn, request_id: &str) -> String {
    format!("browser:{}:{request_id}", signed_in.user.id.0)
}
