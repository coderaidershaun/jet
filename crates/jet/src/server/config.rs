//! Make the listening address and data location explicit for server deployments.

use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    time::Duration,
};

use super::ServerError;

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub listen: SocketAddr,
    pub(crate) data_dir: PathBuf,
    pub(crate) public_origin: Option<String>,
    pub(crate) ui_dir: PathBuf,
    pub(crate) disable_feelings: bool,
    pub(crate) disable_voice: bool,
    /// How long an access token lasts. Tests shorten it to watch the page renew one.
    pub(crate) access_seconds: u64,
    /// The reverse proxy whose `X-Forwarded-For` is believed; loopback when not set.
    pub(crate) trusted_proxy: Option<IpAddr>,
    /// How long a chat must be quiet before its notes review runs. Tests shorten it.
    pub(crate) review_quiet: Duration,
}

impl ServerConfig {
    /// Reads server flags without consulting machine-specific app defaults.
    pub fn from_args(
        args: impl IntoIterator<Item = impl Into<String>>,
    ) -> Result<Self, ServerError> {
        let mut config = Self {
            listen: SocketAddr::from(([127, 0, 0, 1], 8787)),
            data_dir: PathBuf::from("jet-data"),
            public_origin: None,
            ui_dir: PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/ui")),
            disable_feelings: false,
            disable_voice: false,
            access_seconds: crate::account::ACCESS_SECONDS,
            trusted_proxy: None,
            review_quiet: agent::REVIEW_QUIET,
        };
        let mut args = args.into_iter().map(Into::into);
        while let Some(flag) = args.next() {
            if flag == "--disable-feelings" {
                config.disable_feelings = true;
                continue;
            }
            if flag == "--disable-voice" {
                config.disable_voice = true;
                continue;
            }
            let value = args
                .next()
                .ok_or_else(|| ServerError::Config(format!("{flag} needs a value")))?;
            match flag.as_str() {
                "--listen" => {
                    config.listen = value.parse().map_err(|_| {
                        ServerError::Config(format!("invalid listen address: {value}"))
                    })?
                }
                "--data-dir" => config.data_dir = PathBuf::from(value),
                "--ui-dir" => config.ui_dir = PathBuf::from(value),
                "--access-seconds" => {
                    config.access_seconds = value
                        .parse()
                        .ok()
                        .filter(|seconds| *seconds > 0)
                        .ok_or_else(|| {
                            ServerError::Config(format!("invalid access lifetime: {value}"))
                        })?
                }
                "--review-quiet-seconds" => {
                    config.review_quiet = value
                        .parse()
                        .ok()
                        .filter(|seconds| *seconds > 0)
                        .map(Duration::from_secs)
                        .ok_or_else(|| {
                            ServerError::Config(format!("invalid review wait: {value}"))
                        })?
                }
                "--trusted-proxy" => {
                    config.trusted_proxy = Some(value.parse().map_err(|_| {
                        ServerError::Config(format!("invalid trusted proxy address: {value}"))
                    })?)
                }
                "--public-origin" => {
                    let origin = url::Url::parse(&value).map_err(|_| {
                        ServerError::Config(format!("invalid public origin: {value}"))
                    })?;
                    if !matches!(origin.scheme(), "http" | "https")
                        || origin.host_str().is_none()
                        || origin.path() != "/"
                        || origin.query().is_some()
                        || origin.fragment().is_some()
                        || !origin.username().is_empty()
                        || origin.password().is_some()
                    {
                        return Err(ServerError::Config(
                            "public origin must be an HTTP(S) origin without a path or credentials"
                                .into(),
                        ));
                    }
                    config.public_origin = Some(origin.origin().ascii_serialization());
                }
                _ => return Err(ServerError::Config(format!("unknown option {flag}"))),
            }
        }
        if config.data_dir.as_os_str().is_empty() || !config.ui_dir.join("index.html").is_file() {
            return Err(ServerError::Config(
                "data directory must be nonempty and UI directory must contain index.html".into(),
            ));
        }
        Ok(config)
    }
}
