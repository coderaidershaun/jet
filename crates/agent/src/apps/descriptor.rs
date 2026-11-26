//! Discover declared app endpoints while keeping manual choices authoritative, and fetch them
//! only from addresses the owner may reach.
use super::address::is_server_side_ip;
use super::{App, AppAddress, AppOverrides, Embedding, McpOverride, Reach, RegistryError};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use ureq::config::Config;
use ureq::http::Uri;
use ureq::unversioned::resolver::{DefaultResolver, ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::{DefaultConnector, NextTimeout};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppDescriptor {
    pub version: u64,
    pub name: String,
    pub ui: String,
    pub mcp: Option<String>,
    pub embedding: Embedding,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DiscoveryStatus {
    #[default]
    NotChecked,
    Ready,
    Missing,
    Unavailable {
        message: String,
    },
    Incompatible {
        message: String,
    },
}

/// The client that fetches descriptors of apps that may reach as far as `reach`. It checks every
/// address it connects to, so a name that points at the server after it was saved is refused.
pub(super) fn client(reach: Reach) -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(2)))
        .max_redirects(0)
        .http_status_as_error(false)
        .build();
    let resolver = ReachResolver {
        inner: DefaultResolver::default(),
        reach,
    };
    ureq::Agent::with_parts(config, DefaultConnector::default(), resolver)
}

#[derive(Debug)]
struct ReachResolver {
    inner: DefaultResolver,
    reach: Reach,
}

impl Resolver for ReachResolver {
    fn resolve(
        &self,
        uri: &Uri,
        config: &Config,
        timeout: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let addresses = self.inner.resolve(uri, config, timeout)?;
        if self.reach == Reach::PublicOnly
            && addresses
                .iter()
                .any(|address| is_server_side_ip(address.ip()))
        {
            return Err(ureq::Error::Io(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "the app's address is on the server or its private network, which only an admin's app may reach",
            )));
        }
        Ok(addresses)
    }
}

pub(super) fn discover(http: &ureq::Agent, app: &mut App) -> DiscoveryStatus {
    match fetch(http, &app.base_url) {
        Ok(descriptor) => match apply(app, descriptor) {
            Ok(discovered) => {
                *app = discovered;
                DiscoveryStatus::Ready
            }
            Err(error) => DiscoveryStatus::Incompatible {
                message: error.to_string(),
            },
        },
        Err(status) => status,
    }
}

/// The app as its descriptor declares it, with the manual overrides applied on top.
fn apply(app: &App, descriptor: AppDescriptor) -> Result<App, RegistryError> {
    let mut discovered = app.clone();
    discovered.label = descriptor.name;
    discovered.ui_url = app.base_url.resolve(&descriptor.ui)?;
    discovered.mcp_url = descriptor
        .mcp
        .as_deref()
        .map(|reference| app.base_url.resolve(reference))
        .transpose()?;
    discovered.embedding = descriptor.embedding;
    apply_overrides(&mut discovered)?;
    validate_app(&discovered)?;
    Ok(discovered)
}

fn fetch(http: &ureq::Agent, base: &AppAddress) -> Result<AppDescriptor, DiscoveryStatus> {
    let endpoint = base.resolve("jet-app.json").map_err(incompatible)?;
    let mut response = http.get(endpoint.as_str()).call().map_err(unavailable)?;
    match response.status().as_u16() {
        404 => return Err(DiscoveryStatus::Missing),
        200 => {}
        status => {
            return Err(DiscoveryStatus::Unavailable {
                message: format!("descriptor {endpoint} returned HTTP {status}; refresh to retry"),
            });
        }
    }
    let body = response
        .body_mut()
        .with_config()
        .limit(64 * 1024)
        .read_to_string()
        .map_err(unavailable)?;
    let value: serde_json::Value = serde_json::from_str(&body).map_err(incompatible)?;
    let version = value.get("version").and_then(serde_json::Value::as_u64);
    if version != Some(1) {
        return Err(DiscoveryStatus::Incompatible {
            message: format!("descriptor version {version:?} is unsupported; expected version 1"),
        });
    }
    serde_json::from_value(value).map_err(incompatible)
}

fn unavailable(error: impl std::fmt::Display) -> DiscoveryStatus {
    DiscoveryStatus::Unavailable {
        message: format!("could not fetch app descriptor: {error}; refresh to retry"),
    }
}
fn incompatible(error: impl std::fmt::Display) -> DiscoveryStatus {
    DiscoveryStatus::Incompatible {
        message: format!("invalid app descriptor: {error}"),
    }
}

pub(super) fn validate_overrides(
    base: &AppAddress,
    overrides: &AppOverrides,
) -> Result<(), RegistryError> {
    if overrides
        .label
        .as_deref()
        .is_some_and(|label| label.trim().is_empty())
    {
        return Err(RegistryError::EmptyLabel);
    }
    if let Some(ui) = &overrides.ui {
        base.resolve(ui)?;
    }
    if let McpOverride::Url(mcp) = &overrides.mcp {
        base.resolve(mcp)?;
    }
    Ok(())
}

pub(super) fn replace_overrides(
    app: &mut App,
    overrides: AppOverrides,
) -> Result<(), RegistryError> {
    if app.overrides.label.is_some() && overrides.label.is_none() {
        app.label = app.base_url.as_str().into();
    }
    if app.overrides.ui.is_some() && overrides.ui.is_none() {
        app.ui_url = app.base_url.resolve("./")?;
    }
    if app.overrides.embedding.is_some() && overrides.embedding.is_none() {
        app.embedding = Embedding::External;
    }
    if app.overrides.mcp != McpOverride::Discover && overrides.mcp == McpOverride::Discover {
        app.mcp_url = None;
    }
    app.overrides = overrides;
    Ok(())
}

pub(super) fn apply_overrides(app: &mut App) -> Result<(), RegistryError> {
    validate_overrides(&app.base_url, &app.overrides)?;
    if let Some(label) = &app.overrides.label {
        app.label = label.clone();
    }
    if let Some(ui) = &app.overrides.ui {
        app.ui_url = app.base_url.resolve(ui)?;
    }
    match &app.overrides.mcp {
        McpOverride::Discover => {}
        McpOverride::Disabled => app.mcp_url = None,
        McpOverride::Url(url) => app.mcp_url = Some(app.base_url.resolve(url)?),
    }
    if let Some(embedding) = app.overrides.embedding {
        app.embedding = embedding;
    }
    Ok(())
}

pub(super) fn validate_app(app: &App) -> Result<(), RegistryError> {
    if app.label.trim().is_empty() {
        return Err(RegistryError::EmptyLabel);
    }
    app.base_url.resolve(app.ui_url.as_str())?;
    if let Some(mcp) = &app.mcp_url {
        app.base_url.resolve(mcp.as_str())?;
    }
    validate_overrides(&app.base_url, &app.overrides)?;
    if app.embedding == Embedding::RelativePaths {
        let base = app.base_url.resolve("./")?;
        if app.ui_url.origin() != base.origin() || !app.ui_url.path().starts_with(base.path()) {
            return Err(RegistryError::InvalidAddress(app.ui_url.to_string()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn only_an_admins_app_is_discovered_at_a_name_on_the_server() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 1024];
            let _ = stream.read(&mut request).unwrap();
            stream
                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
        });
        let base = AppAddress::parse(&format!("http://localhost:{port}/")).unwrap();

        assert_eq!(
            fetch(&client(Reach::Anywhere), &base),
            Err(DiscoveryStatus::Missing)
        );
        server.join().unwrap();
        let Err(DiscoveryStatus::Unavailable { message }) =
            fetch(&client(Reach::PublicOnly), &base)
        else {
            panic!("a public-only app at localhost must not be fetched");
        };
        assert!(message.contains("private network"), "{message}");
    }
}
