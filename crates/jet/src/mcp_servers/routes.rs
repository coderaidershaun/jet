//! Lets the page list the signed-in user's MCP servers with the known providers, add one, test it,
//! turn it on or off, change its key, sign it in or out and remove it, and takes the user back from
//! a provider's sign-in page. No answer ever holds a key, token, code or client secret.

use super::{
    AddServer, KeyInput, McpServerError, McpServers,
    oauth::SignInError,
    sign_in::{PastedClient, RETURN_PATH},
};
use crate::{
    account::SignedIn,
    store::{McpProvider, McpServer, McpState},
};
use agent::apps::AppId;
use axum::{
    Json, Router,
    extract::{FromRef, Path, Query, State},
    http::{
        HeaderMap, HeaderValue, StatusCode,
        header::{CACHE_CONTROL, HOST, REFERRER_POLICY},
    },
    response::{Html, IntoResponse, Response},
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
        .route(
            "/api/mcp/servers/{id}/signin",
            post(start_sign_in).delete(sign_out),
        )
        .route(RETURN_PATH, get(finish_sign_in))
}

type Answer = Result<Json<Value>, McpServerError>;

/// The origin the user's browser used, as the sign-in guard reads it.
fn browser_origin(headers: &HeaderMap) -> String {
    let host = headers
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("localhost");
    format!("http://{host}")
}

async fn list(
    State(servers): State<McpServers>,
    signed_in: SignedIn,
    headers: HeaderMap,
) -> Answer {
    let providers: Vec<_> = McpProvider::ALL
        .iter()
        .map(|provider| provider.facts())
        .collect();
    let listed = servers.list(signed_in.user.id).await?;
    let redirect = servers.redirect_address(&browser_origin(&headers));
    Ok(Json(
        json!({"servers": listed, "providers": providers, "redirectAddress": redirect}),
    ))
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

/// What the page sends to start a sign-in: nothing, or the client the user made in the provider's
/// console.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StartSignIn {
    client: Option<PastedClient>,
}

/// Gives the provider's sign-in page for the page to open.
async fn start_sign_in(
    State(servers): State<McpServers>,
    signed_in: SignedIn,
    Path(id): Path<AppId>,
    headers: HeaderMap,
    Json(StartSignIn { client }): Json<StartSignIn>,
) -> Answer {
    let redirect = servers.redirect_address(&browser_origin(&headers));
    let address = servers
        .start_sign_in(signed_in.user.id, &id, redirect, client)
        .await?;
    Ok(Json(json!({"address": address})))
}

async fn sign_out(
    State(servers): State<McpServers>,
    signed_in: SignedIn,
    Path(id): Path<AppId>,
) -> Answer {
    Ok(Json(json!(servers.sign_out(signed_in.user.id, &id).await?)))
}

/// What the provider sends the user back with (RFC 6749, section 4.1.2).
#[derive(Deserialize)]
struct Returned {
    state: Option<String>,
    code: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

/// The page the provider sends the user back to. A browser whose access cookie ran out is sent
/// through the sign-in page first, which renews it and comes back here, so the state is always
/// checked against the user signed in now.
async fn finish_sign_in(
    State(servers): State<McpServers>,
    signed_in: SignedIn,
    Query(returned): Query<Returned>,
) -> Response {
    let answer = match (&returned.code, &returned.error) {
        (Some(code), None) => Ok(code.as_str()),
        (_, error) => Err(SignInError::Denied {
            error: error.clone().unwrap_or_else(|| "no code came back".into()),
            description: returned.error_description.clone(),
        }),
    };
    let finished = match &returned.state {
        Some(state) => {
            servers
                .finish_sign_in(signed_in.user.id, state, answer)
                .await
        }
        None => Err(SignInError::StateRefused.into()),
    };
    let (status, page) = match finished {
        Ok(server) => (StatusCode::OK, finished_page(&server)),
        Err(error) => {
            let status = error_status(&error).0;
            if status == StatusCode::INTERNAL_SERVER_ERROR {
                eprintln!("jet: an MCP sign-in failed: {error}");
            }
            let page = return_page(
                "The sign-in did not finish",
                &capitalise(&error.to_string()),
                false,
            );
            (status, page)
        }
    };
    let mut response = (status, Html(page)).into_response();
    let headers = response.headers_mut();
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    response
}

fn finished_page(server: &McpServer) -> String {
    let title = format!("Signed in to {}", server.name);
    let tools = match server.tools.len() {
        1 => "its 1 tool".to_owned(),
        count => format!("its {count} tools"),
    };
    match server.state {
        McpState::Connected => return_page(
            &title,
            &format!("Jet can now call {tools}. You can close this tab."),
            true,
        ),
        _ => {
            let reason = server.reason.as_deref().unwrap_or("it did not answer");
            let detail = format!(
                "Jet signed in, but the server did not connect: {}",
                capitalise(reason)
            );
            return_page(&title, &detail, false)
        }
    }
}

/// A small page in Jet's colours. It tells Jet's other tabs that a server changed, and closes
/// itself when it has nothing to show that the settings window would not.
fn return_page(title: &str, detail: &str, closes: bool) -> String {
    let close = if closes { "window.close();" } else { "" };
    format!(
        r#"<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · Jet</title>
<style>
:root {{ color-scheme: dark; }}
body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b141b; color: #e8edf1; font: 15px/21px system-ui, -apple-system, "Segoe UI", sans-serif; }}
main {{ max-width: 28rem; padding: 24px; }}
h1 {{ margin: 0 0 8px; font-size: 17px; line-height: 24px; font-weight: 600; }}
p {{ margin: 0 0 16px; color: #8d9ba7; overflow-wrap: anywhere; }}
a {{ color: #8cc4ff; }}
</style>
<main><h1>{title}</h1><p>{detail}</p><p><a href="/">Back to Jet</a></p></main>
<script>if ('BroadcastChannel' in self) new BroadcastChannel('jet-mcp').postMessage({{ connected: {connected} }}); {close}</script>
</html>
"#,
        connected = closes,
        title = escape(title),
        detail = escape(detail),
    )
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn capitalise(text: &str) -> String {
    let mut chars = text.chars();
    let first = chars.next().map(|c| c.to_uppercase().collect::<String>());
    let mut text = first.unwrap_or_default() + chars.as_str();
    if !text.ends_with('.') {
        text.push('.');
    }
    text
}

async fn remove(
    State(servers): State<McpServers>,
    signed_in: SignedIn,
    Path(id): Path<AppId>,
) -> Answer {
    servers.remove(signed_in.user.id, &id).await?;
    Ok(Json(json!({})))
}

fn error_status(error: &McpServerError) -> (StatusCode, &'static str) {
    match error {
        McpServerError::InvalidAddress(_) | McpServerError::PlainHttp(_) => {
            (StatusCode::BAD_REQUEST, "invalidAddress")
        }
        McpServerError::InvalidName => (StatusCode::BAD_REQUEST, "invalidName"),
        McpServerError::InvalidKey(_) => (StatusCode::BAD_REQUEST, "invalidKey"),
        McpServerError::AdminOnly(_) => (StatusCode::FORBIDDEN, "adminOnly"),
        McpServerError::Duplicate(_) => (StatusCode::CONFLICT, "duplicate"),
        McpServerError::TurnedOff => (StatusCode::CONFLICT, "turnedOff"),
        McpServerError::NotFound => (StatusCode::NOT_FOUND, "notFound"),
        McpServerError::SignIn(error) => match error {
            SignInError::NoRegistration(_) => (StatusCode::CONFLICT, "noRegistration"),
            SignInError::NotNeeded => (StatusCode::CONFLICT, "notNeeded"),
            SignInError::StateRefused => (StatusCode::BAD_REQUEST, "stateRefused"),
            SignInError::Denied { .. } => (StatusCode::BAD_REQUEST, "denied"),
            SignInError::NoChallenge(_)
            | SignInError::Unreachable { .. }
            | SignInError::NoMetadata(_)
            | SignInError::Metadata { .. }
            | SignInError::NoPkce(_)
            | SignInError::UnsafeAddress(_)
            | SignInError::Registration { .. }
            | SignInError::Refused { .. }
            | SignInError::ClientRefused
            | SignInError::BadAnswer(_) => (StatusCode::BAD_GATEWAY, "signInFailed"),
        },
        McpServerError::Store(_) | McpServerError::Worker(_) => {
            (StatusCode::INTERNAL_SERVER_ERROR, "io")
        }
    }
}

impl IntoResponse for McpServerError {
    fn into_response(self) -> Response {
        let (status, kind) = error_status(&self);
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
