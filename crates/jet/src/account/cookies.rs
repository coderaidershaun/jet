//! The two sign-in cookies: how they are set, cleared and read.

use axum::http::{HeaderMap, HeaderValue, header::COOKIE};

pub(super) const ACCESS: &str = "jet_access";
pub(super) const REFRESH: &str = "jet_refresh";
/// The refresh cookie goes only to the sign-in endpoints, never to pages, apps or other routes.
const REFRESH_PATH: &str = "/api/auth";

/// Whether cookies are marked `Secure`: only when Jet is served over HTTPS, so that sign-in still
/// works over plain HTTP on 127.0.0.1.
#[derive(Debug, Clone, Copy)]
pub(super) struct Cookies {
    pub(super) secure: bool,
}

impl Cookies {
    pub(super) fn access(self, token: &str, seconds: u64) -> HeaderValue {
        self.cookie(ACCESS, token, "/", seconds, "Lax")
    }
    pub(super) fn refresh(self, token: &str, seconds: u64) -> HeaderValue {
        self.cookie(REFRESH, token, REFRESH_PATH, seconds, "Strict")
    }
    pub(super) fn cleared(self) -> [HeaderValue; 2] {
        [self.access("", 0), self.refresh("", 0)]
    }
    fn cookie(
        self,
        name: &str,
        value: &str,
        path: &str,
        seconds: u64,
        same_site: &str,
    ) -> HeaderValue {
        let secure = if self.secure { "; Secure" } else { "" };
        HeaderValue::from_str(&format!(
            "{name}={value}; Path={path}; Max-Age={seconds}; HttpOnly; SameSite={same_site}{secure}"
        ))
        .expect("tokens are hex or base64url, which are valid in a header")
    }
}

pub(super) fn read<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value)
}
