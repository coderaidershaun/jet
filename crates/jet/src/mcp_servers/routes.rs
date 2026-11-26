//! Lets the page list the signed-in user's MCP servers with the known providers, add one, test it,
//! turn it on or off, change its key and remove it. No answer ever holds a key.

use super::{AddServer, KeyInput, McpServerError, McpServers};
use crate::{account::SignedIn, store::McpProvider};
use agent::apps::AppId;
use axum::{
    Json, Router,
    extract::{FromRef, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use serde::Deserialize;
use serde_json::{Value, json};

pub(crate) fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    McpServers: FromRef<S>,
{
    Router::new()
        .route("/api/mcp/servers", get(list).post(add))
        .route("/api/mcp/servers/{id}", axum::routing::delete(remove))
        .route("/api/mcp/servers/{id}/test", post(test))
        .route("/api/mcp/servers/{id}/enabled", put(set_enabled))
        .route("/api/mcp/servers/{id}/key", put(set_key).delete(remove_key))
}

type Answer = Result<Json<Value>, McpServerError>;

async fn list(State(servers): State<McpServers>, signed_in: SignedIn) -> Answer {
    let providers: Vec<_> = McpProvider::ALL
        .iter()
        .map(|provider| provider.facts())
        .collect();
    let listed = servers.list(signed_in.user.id).await?;
    Ok(Json(json!({"servers": listed, "providers": providers})))
}

async fn add(
    State(servers): State<McpServers>,
    signed_in: SignedIn,
    Json(input): Json<AddServer>,
) -> Answer {
    let user = &signed_in.user;
    Ok(Json(json!(
        servers.add(user.id, user.is_admin, input).await?
    )))
}

async fn test(
    State(servers): State<McpServers>,
    signed_in: SignedIn,
    Path(id): Path<AppId>,
) -> Answer {
    Ok(Json(json!(servers.test(signed_in.user.id, &id).await?)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Enabled {
    enabled: bool,
}

async fn set_enabled(
    State(servers): State<McpServers>,
    signed_in: SignedIn,
    Path(id): Path<AppId>,
    Json(Enabled { enabled }): Json<Enabled>,
) -> Answer {
    let server = servers.set_enabled(signed_in.user.id, &id, enabled).await?;
    Ok(Json(json!(server)))
}

async fn set_key(
    State(servers): State<McpServers>,
    signed_in: SignedIn,
    Path(id): Path<AppId>,
    Json(key): Json<KeyInput>,
) -> Answer {
    let server = servers.set_key(signed_in.user.id, &id, Some(key)).await?;
    Ok(Json(json!(server)))
}

async fn remove_key(
    State(servers): State<McpServers>,
    signed_in: SignedIn,
    Path(id): Path<AppId>,
) -> Answer {
    Ok(Json(json!(
        servers.set_key(signed_in.user.id, &id, None).await?
    )))
}

async fn remove(
    State(servers): State<McpServers>,
    signed_in: SignedIn,
    Path(id): Path<AppId>,
) -> Answer {
    servers.remove(signed_in.user.id, &id).await?;
    Ok(Json(json!({})))
}

impl IntoResponse for McpServerError {
    fn into_response(self) -> Response {
        let (status, kind) = match &self {
            Self::InvalidAddress(_) | Self::PlainHttp(_) => {
                (StatusCode::BAD_REQUEST, "invalidAddress")
            }
            Self::InvalidName => (StatusCode::BAD_REQUEST, "invalidName"),
            Self::InvalidKey(_) => (StatusCode::BAD_REQUEST, "invalidKey"),
            Self::AdminOnly(_) => (StatusCode::FORBIDDEN, "adminOnly"),
            Self::Duplicate(_) => (StatusCode::CONFLICT, "duplicate"),
            Self::TurnedOff => (StatusCode::CONFLICT, "turnedOff"),
            Self::NotFound => (StatusCode::NOT_FOUND, "notFound"),
            Self::Store(_) | Self::Worker(_) => (StatusCode::INTERNAL_SERVER_ERROR, "io"),
        };
        if status == StatusCode::INTERNAL_SERVER_ERROR {
            eprintln!("jet: an MCP server request failed: {self:?}");
        }
        (
            status,
            Json(json!({"kind": kind, "message": self.to_string()})),
        )
            .into_response()
    }
}
