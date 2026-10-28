//! Expose catalogue inspection, explicitly marked free discovery and the read-only status of
//! marked jobs to the browser.
use super::Server;
use crate::chat::MAX_ID_BYTES;
use agent::{
    apps::AppId,
    mcp::{ToolCatalogue, ToolRequest, ToolTarget},
};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};

type Error = (StatusCode, Json<Value>);
fn error(error: impl serde::Serialize) -> Error {
    (StatusCode::BAD_GATEWAY, Json(json!({"error":error})))
}
pub(super) fn router() -> Router<Server> {
    Router::new()
        .route("/api/apps/{id}/tools", get(catalogue).post(refresh))
        .route("/api/apps/{id}/discovery", post(discover))
        .route("/api/apps/{id}/status", post(status))
        .route("/api/tools/cancel", post(cancel))
}
async fn catalogue(
    State(host): State<Server>,
    Path(id): Path<AppId>,
) -> Result<Json<ToolCatalogue>, Error> {
    host.mcp.catalogue(&id).await.map(Json).map_err(error)
}
async fn refresh(
    State(host): State<Server>,
    Path(id): Path<AppId>,
) -> Result<Json<ToolCatalogue>, Error> {
    host.mcp.refresh(&id).await.map(Json).map_err(error)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserToolRequest {
    request_id: String,
    tool: String,
    arguments: serde_json::Map<String, Value>,
}
impl BrowserToolRequest {
    /// The request, named `browser:{requestId}` so that `/api/tools/cancel` can stop it.
    fn into_request(self, app_id: AppId) -> Result<ToolRequest, Error> {
        if self.request_id.is_empty() || self.request_id.len() > MAX_ID_BYTES {
            return Err(error(format!(
                "requestId must contain 1 to {MAX_ID_BYTES} bytes"
            )));
        }
        Ok(ToolRequest {
            request_id: format!("browser:{}", self.request_id),
            target: ToolTarget {
                app_id,
                tool: self.tool,
            },
            arguments: self.arguments,
        })
    }
}
async fn discover(
    State(host): State<Server>,
    Path(id): Path<AppId>,
    Json(request): Json<BrowserToolRequest>,
) -> Result<Json<Value>, Error> {
    let result = host
        .mcp
        .discover(request.into_request(id.clone())?)
        .await
        .map_err(error)?;
    let catalogue = host.mcp.refresh(&id).await.map_err(error)?;
    Ok(Json(json!({"result":result,"catalogue":catalogue})))
}
/// Reads the status of a job. Only a tool that carries the job marker and promises to only read
/// is called, and what it returns is data for the page to check.
async fn status(
    State(host): State<Server>,
    Path(id): Path<AppId>,
    Json(request): Json<BrowserToolRequest>,
) -> Result<Json<Value>, Error> {
    let result = host
        .mcp
        .status(request.into_request(id)?)
        .await
        .map_err(error)?;
    Ok(Json(json!({"result":result})))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelRequest {
    request_id: String,
}
async fn cancel(State(host): State<Server>, Json(request): Json<CancelRequest>) -> Json<Value> {
    host.mcp
        .cancel_request(&format!("browser:{}", request.request_id));
    Json(json!({}))
}
