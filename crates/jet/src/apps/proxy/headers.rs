//! Replace client forwarding claims, remove connection-specific headers, and keep app pages
//! apart from Jet's own page and sign-in.
use super::{ProxyError, target::Target};
use axum::{
    body::Body,
    http::{
        HeaderMap, HeaderValue, Response, StatusCode,
        header::{
            ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS,
            ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_EXPOSE_HEADERS, ACCESS_CONTROL_MAX_AGE,
            ACCESS_CONTROL_REQUEST_HEADERS, ACCESS_CONTROL_REQUEST_METHOD, CONNECTION,
            CONTENT_SECURITY_POLICY, COOKIE, HOST, ORIGIN, SET_COOKIE, UPGRADE,
        },
    },
};
use url::Url;

/// Every app response runs in a sandbox without `allow-same-origin`, so the page has an opaque
/// origin: it cannot read Jet's page, and the browser sends Jet's cookies with none of its requests.
const SANDBOX: &str = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals";

pub(super) fn websocket(headers: &HeaderMap) -> bool {
    headers
        .get(UPGRADE)
        .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"websocket"))
        && headers
            .get_all(CONNECTION)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(','))
            .any(|value| value.trim().eq_ignore_ascii_case("upgrade"))
}

pub(super) fn strip(headers: &mut HeaderMap, upgrade: bool) {
    let named: Vec<String> = headers
        .get_all(CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| {
            value
                .split(',')
                .map(|name| name.trim().to_ascii_lowercase())
        })
        .collect();
    for name in named {
        if !(upgrade && name == "upgrade") {
            headers.remove(name);
        }
    }
    for name in [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ] {
        if !(upgrade && matches!(name, "connection" | "upgrade")) {
            headers.remove(name);
        }
    }
    if upgrade {
        headers.insert(CONNECTION, HeaderValue::from_static("upgrade"));
        headers.insert(UPGRADE, HeaderValue::from_static("websocket"));
    }
}

pub(super) fn request(
    headers: &mut HeaderMap,
    target: &Target,
    public: &Url,
) -> Result<(), ProxyError> {
    let upgrade = websocket(headers);
    let upstream = &target.url;
    let origins: Vec<_> = headers.get_all(ORIGIN).iter().collect();
    let own = public.origin().ascii_serialization();
    if !origins.is_empty()
        && (origins.len() != 1 || (origins[0].as_bytes() != own.as_bytes() && origins[0] != "null"))
    {
        return Err(ProxyError::Origin);
    }
    let origin_present = !origins.is_empty();
    strip(headers, upgrade);
    headers.remove(COOKIE);
    let forwarded: Vec<_> = headers
        .keys()
        .filter(|key| key.as_str() == "forwarded" || key.as_str().starts_with("x-forwarded-"))
        .cloned()
        .collect();
    for key in forwarded {
        headers.remove(key);
    }
    if origin_present {
        headers.insert(ORIGIN, value(&upstream.origin().ascii_serialization())?);
    }
    headers.insert(
        HOST,
        value(&upstream[url::Position::BeforeHost..url::Position::AfterPort])?,
    );
    headers.insert(
        "x-forwarded-host",
        value(&public[url::Position::BeforeHost..url::Position::AfterPort])?,
    );
    headers.insert("x-forwarded-proto", value(public.scheme())?);
    headers.insert("x-forwarded-prefix", value(&target.mount)?);
    Ok(())
}
/// Sandboxes an app response, and lets the app page read its own responses: with an opaque origin
/// its relative requests are cross-origin. An app may not set cookies on Jet's address.
pub(super) fn isolate(headers: &mut HeaderMap) {
    headers.remove(SET_COOKIE);
    headers.append(CONTENT_SECURITY_POLICY, HeaderValue::from_static(SANDBOX));
    headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    headers.insert(ACCESS_CONTROL_EXPOSE_HEADERS, HeaderValue::from_static("*"));
}

/// The answer to the browser's CORS check before an app page sends a request with a body or its
/// own headers. Apps are not asked, since they never had to answer one before the sandbox.
pub(super) fn preflight(request: &HeaderMap) -> Option<Response<Body>> {
    let method = request.get(ACCESS_CONTROL_REQUEST_METHOD)?.clone();
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    let headers = response.headers_mut();
    headers.insert(ACCESS_CONTROL_ALLOW_METHODS, method);
    if let Some(asked) = request.get(ACCESS_CONTROL_REQUEST_HEADERS) {
        headers.insert(ACCESS_CONTROL_ALLOW_HEADERS, asked.clone());
    }
    headers.insert(ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
    isolate(headers);
    Some(response)
}

fn value(value: &str) -> Result<HeaderValue, ProxyError> {
    HeaderValue::from_str(value).map_err(|_| ProxyError::Path)
}
