//! Replace client forwarding claims and remove connection-specific headers.
use super::{ProxyError, target::Target};
use axum::http::{
    HeaderMap, HeaderValue,
    header::{CONNECTION, HOST, ORIGIN, UPGRADE},
};
use url::Url;

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
    if !origins.is_empty()
        && (origins.len() != 1
            || origins[0].as_bytes() != public.origin().ascii_serialization().as_bytes())
    {
        return Err(ProxyError::Origin);
    }
    let origin_present = !origins.is_empty();
    strip(headers, upgrade);
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
fn value(value: &str) -> Result<HeaderValue, ProxyError> {
    HeaderValue::from_str(value).map_err(|_| ProxyError::Path)
}
