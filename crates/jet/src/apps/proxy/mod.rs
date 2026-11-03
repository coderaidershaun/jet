//! Forward registered app traffic without buffering bodies or observing embedded page state.
mod connect;
mod headers;
mod target;

use super::Apps;
use crate::lock;
use agent::apps::{App, AppId, DiscoveryStatus};
use axum::{
    Json, Router,
    body::Body,
    extract::{FromRef, Path, State},
    http::{Request, StatusCode, Uri, header::LOCATION},
    response::{IntoResponse, Response},
    routing::{any, get},
};
use connect::Connector;
use hyper_util::{
    client::legacy::Client,
    rt::{TokioExecutor, TokioIo},
};
use serde_json::{Value, json};
use std::{net::SocketAddr, time::Duration};
use target::{Target, reject_recursion};
use url::Url;

#[derive(Clone)]
pub(crate) struct Proxy {
    client: Client<Connector, Body>,
    public: Url,
    listen: SocketAddr,
}

/// Why the proxy cannot be set up for the address the server listens on.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub(crate) struct SetupError(String);

impl Proxy {
    pub(crate) fn new(public_origin: Option<&str>, listen: SocketAddr) -> Result<Self, SetupError> {
        let origin = match public_origin {
            Some(origin) => origin.to_owned(),
            None if listen.ip().is_loopback() && listen.port() != 0 => {
                format!("http://{listen}")
            }
            None => {
                return Err(SetupError(
                    "app proxy requires --public-origin for wildcard or remote listeners".into(),
                ));
            }
        };
        let public = Url::parse(&origin).map_err(|error| SetupError(error.to_string()))?;
        let connector = Connector::new()
            .map_err(|error| SetupError(format!("app TLS configuration failed: {error}")))?;
        let client = Client::builder(TokioExecutor::new()).build(connector);
        Ok(Self {
            client,
            public,
            listen,
        })
    }
}

#[derive(Debug, thiserror::Error)]
enum ProxyError {
    #[error("app is no longer registered")]
    Missing,
    #[error("unsafe app path or address")]
    Path,
    #[error("browser Origin must match Jet's configured public origin")]
    Origin,
    #[error("app destination points back to Jet")]
    Recursive,
    #[error("app redirected outside its registered base; open it externally")]
    Redirect,
    #[error("app is offline: {0}")]
    Offline(String),
    #[error("app sent an unexpected protocol upgrade")]
    Upgrade,
}
impl IntoResponse for ProxyError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::Missing => StatusCode::NOT_FOUND,
            Self::Origin => StatusCode::FORBIDDEN,
            Self::Path | Self::Recursive => StatusCode::BAD_REQUEST,
            _ => StatusCode::BAD_GATEWAY,
        };
        (status, Json(json!({"error":self.to_string()}))).into_response()
    }
}

pub(super) fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Apps: FromRef<S>,
{
    Router::new()
        .route("/apps/{id}", any(slash))
        .route("/apps/{id}/", any(forward))
        .route("/apps/{id}/{*tail}", any(forward))
        .route("/api/apps/{id}/ui-status", get(ui_status))
}
fn app(apps: &Apps, id: &str) -> Result<App, ProxyError> {
    let id: AppId = id.parse().map_err(|_| ProxyError::Missing)?;
    lock(&apps.registry)
        .get(&id)
        .cloned()
        .ok_or(ProxyError::Missing)
}
async fn slash(
    State(apps): State<Apps>,
    Path(id): Path<String>,
    uri: Uri,
) -> Result<Response, ProxyError> {
    app(&apps, &id)?;
    let mut location = format!("{}/", uri.path());
    if let Some(query) = uri.query() {
        location.push('?');
        location.push_str(query);
    }
    Ok((StatusCode::PERMANENT_REDIRECT, [(LOCATION, location)]).into_response())
}
async fn forward(
    State(apps): State<Apps>,
    uri: Uri,
    mut request: Request<Body>,
) -> Result<Response, ProxyError> {
    let id = uri
        .path()
        .strip_prefix("/apps/")
        .and_then(|path| path.split('/').next())
        .ok_or(ProxyError::Missing)?;
    let app = app(&apps, id)?;
    let target = Target::new(&app, &uri)?;
    reject_recursion(&target.url, &apps.proxy.public, apps.proxy.listen).await?;
    let upgrade = headers::websocket(request.headers());
    headers::request(request.headers_mut(), &target, &apps.proxy.public)?;
    let downstream = upgrade.then(|| hyper::upgrade::on(&mut request));
    *request.uri_mut() = target
        .url
        .as_str()
        .parse::<Uri>()
        .map_err(|_| ProxyError::Path)?;
    let mut response = apps
        .proxy
        .client
        .request(request)
        .await
        .map_err(|error| ProxyError::Offline(error.to_string()))?;
    let switched = response.status() == StatusCode::SWITCHING_PROTOCOLS;
    if switched {
        if !upgrade || !headers::websocket(response.headers()) {
            return Err(ProxyError::Upgrade);
        }
        let upstream = hyper::upgrade::on(&mut response);
        if let Some(downstream) = downstream {
            tokio::spawn(async move {
                match tokio::try_join!(downstream, upstream) {
                    Ok((downstream, upstream)) => {
                        let mut downstream = TokioIo::new(downstream);
                        let mut upstream = TokioIo::new(upstream);
                        if let Err(error) =
                            tokio::io::copy_bidirectional(&mut downstream, &mut upstream).await
                        {
                            eprintln!("jet: app socket closed: {error}");
                        }
                    }
                    Err(error) => eprintln!("jet: app upgrade failed: {error}"),
                }
            });
        }
    }
    headers::strip(response.headers_mut(), switched);
    if let Some(location) = response.headers().get(LOCATION) {
        let location = target.redirect(location.to_str().map_err(|_| ProxyError::Redirect)?)?;
        response.headers_mut().insert(
            LOCATION,
            location.parse().map_err(|_| ProxyError::Redirect)?,
        );
    }
    Ok(response.map(Body::new))
}
async fn ui_status(
    State(apps): State<Apps>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ProxyError> {
    let app = app(&apps, &id)?;
    let discovery = lock(&apps.registry).discovery_status(&app.id);
    if let DiscoveryStatus::Incompatible { message } = discovery {
        return Ok(Json(json!({"status":"incompatible","message":message})));
    }
    let target = Target::ui(&app)?;
    let attempt = async {
        reject_recursion(&target.url, &apps.proxy.public, apps.proxy.listen).await?;
        let mut request = Request::builder()
            .method("HEAD")
            .uri(target.url.as_str())
            .body(Body::empty())
            .map_err(|_| ProxyError::Path)?;
        headers::request(request.headers_mut(), &target, &apps.proxy.public)?;
        let response = apps
            .proxy
            .client
            .request(request)
            .await
            .map_err(|error| ProxyError::Offline(error.to_string()))?;
        Ok::<_, ProxyError>(response.status().as_u16())
    };
    let result = match tokio::time::timeout(Duration::from_secs(2), attempt).await {
        Ok(Ok(status)) => {
            json!({"status":"reachable","httpStatus":status,"message":"App server reachable. If the frame is blank, open the app externally."})
        }
        Ok(Err(error)) => json!({"status":"offline","message":error.to_string()}),
        Err(_) => {
            json!({"status":"offline","message":"App endpoint did not respond within two seconds."})
        }
    };
    Ok(Json(result))
}
