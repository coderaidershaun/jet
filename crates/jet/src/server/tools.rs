//! Expose catalogue inspection and explicitly marked free discovery to the browser.
use super::Server;
use agent::{
    apps::AppId,
    mcp::{McpService, ToolRequest, ToolTarget},
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
        .route("/api/tools/cancel", post(cancel))
}
async fn catalogue(
    State(host): State<Server>,
    Path(id): Path<AppId>,
) -> Result<Json<Value>, Error> {
    host.mcp
        .catalogue(&id)
        .await
        .map(|value| Json(json!(value)))
        .map_err(error)
}
async fn refresh(State(host): State<Server>, Path(id): Path<AppId>) -> Result<Json<Value>, Error> {
    host.mcp
        .refresh(&id)
        .await
        .map(|value| Json(json!(value)))
        .map_err(error)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiscoveryRequest {
    request_id: String,
    tool: String,
    arguments: serde_json::Map<String, Value>,
}
async fn discover(
    State(host): State<Server>,
    Path(id): Path<AppId>,
    Json(request): Json<DiscoveryRequest>,
) -> Result<Json<Value>, Error> {
    if request.request_id.is_empty() || request.request_id.len() > 128 {
        return Err(error("requestId must contain 1 to 128 bytes"));
    }
    let result = host
        .mcp
        .discover(ToolRequest {
            request_id: format!("browser:{}", request.request_id),
            target: ToolTarget {
                app_id: id.clone(),
                tool: request.tool,
            },
            arguments: request.arguments,
        })
        .await
        .map_err(error)?;
    let catalogue = host.mcp.refresh(&id).await.map_err(error)?;
    Ok(Json(json!({"result":result,"catalogue":catalogue})))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelRequest {
    request_id: String,
}
async fn cancel(
    State(host): State<Server>,
    Json(request): Json<CancelRequest>,
) -> Result<Json<Value>, Error> {
    host.mcp
        .cancel(&format!("browser:{}", request.request_id))
        .await
        .map_err(error)?;
    Ok(Json(json!({})))
}
