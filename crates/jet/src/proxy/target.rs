//! Keep mounted paths inside the registered app and reject routes back into Jet.
use super::ProxyError;
use agent::apps::App;
use axum::http::Uri;
use std::{net::SocketAddr, time::Duration};
use url::Url;

pub(super) struct Target {
    pub(super) url: Url,
    base: Url,
    pub(super) mount: String,
}
impl Target {
    pub(super) fn new(app: &App, uri: &Uri) -> Result<Self, ProxyError> {
        let mount = format!("/apps/{}", app.id);
        let suffix = uri
            .path()
            .strip_prefix(&format!("{mount}/"))
            .ok_or(ProxyError::Path)?;
        validate_path(suffix)?;
        let base = Url::parse(app.base_url.as_str()).map_err(|_| ProxyError::Path)?;
        let mut url =
            Url::parse(&format!("{}{suffix}", base.as_str())).map_err(|_| ProxyError::Path)?;
        url.set_query(uri.query());
        Ok(Self { url, base, mount })
    }
    pub(super) fn ui(app: &App) -> Result<Self, ProxyError> {
        let base = Url::parse(app.base_url.as_str()).map_err(|_| ProxyError::Path)?;
        Ok(Self {
            url: app.ui_url.clone(),
            base,
            mount: format!("/apps/{}", app.id),
        })
    }
    pub(super) fn redirect(&self, location: &str) -> Result<String, ProxyError> {
        let url = self.url.join(location).map_err(|_| ProxyError::Redirect)?;
        if url.origin() != self.base.origin()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(ProxyError::Redirect);
        }
        let suffix = url
            .path()
            .strip_prefix(self.base.path())
            .ok_or(ProxyError::Redirect)?;
        validate_path(suffix).map_err(|_| ProxyError::Redirect)?;
        let mut path = format!("{}/{suffix}", self.mount);
        if let Some(query) = url.query() {
            path.push('?');
            path.push_str(query);
        }
        if let Some(fragment) = url.fragment() {
            path.push('#');
            path.push_str(fragment);
        }
        Ok(path)
    }
}

pub(super) async fn reject_recursion(
    url: &Url,
    public: &Url,
    listen: SocketAddr,
) -> Result<(), ProxyError> {
    if url.origin() == public.origin() {
        return Err(ProxyError::Recursive);
    }
    let port = url.port_or_known_default().ok_or(ProxyError::Path)?;
    if port != listen.port() {
        return Ok(());
    }
    let host = url
        .host_str()
        .ok_or(ProxyError::Path)?
        .trim_matches(['[', ']']);
    let addresses = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::net::lookup_host((host, port)),
    )
    .await
    .map_err(|_| ProxyError::Offline("address lookup timed out".into()))?
    .map_err(|error| ProxyError::Offline(error.to_string()))?;
    for address in addresses {
        let ip = address.ip();
        if ip.is_loopback()
            || ip.is_unspecified()
            || ip == listen.ip()
            || std::net::TcpListener::bind(SocketAddr::new(ip, 0)).is_ok()
        {
            return Err(ProxyError::Recursive);
        }
    }
    Ok(())
}

fn validate_path(path: &str) -> Result<(), ProxyError> {
    if path.starts_with('/') || path.contains('\\') || path.contains(':') {
        return Err(ProxyError::Path);
    }
    for segment in path.split('/') {
        let mut current = segment.as_bytes().to_vec();
        for pass in 0..8 {
            if current == b"."
                || current == b".."
                || current
                    .iter()
                    .any(|byte| matches!(byte, b'/' | b'\\') || byte.is_ascii_control())
            {
                return Err(ProxyError::Path);
            }
            let mut decoded = Vec::with_capacity(current.len());
            let mut index = 0;
            while index < current.len() {
                let pair = current.get(index + 1..index + 3).and_then(|bytes| {
                    Some(
                        ((bytes[0] as char).to_digit(16)? * 16 + (bytes[1] as char).to_digit(16)?)
                            as u8,
                    )
                });
                if current[index] == b'%' {
                    if let Some(byte) = pair {
                        decoded.push(byte);
                        index += 3;
                        continue;
                    }
                    if pass == 0 {
                        return Err(ProxyError::Path);
                    }
                }
                decoded.push(current[index]);
                index += 1;
            }
            if decoded == current {
                break;
            }
            if pass == 7 {
                return Err(ProxyError::Path);
            }
            current = decoded;
        }
    }
    Ok(())
}
