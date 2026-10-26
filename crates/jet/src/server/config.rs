//! Make the listening address and data location explicit for server deployments.

use std::{net::SocketAddr, path::PathBuf};

use super::ServerError;

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub listen: SocketAddr,
    pub data_dir: PathBuf,
    pub public_origin: Option<String>,
    pub ui_dir: PathBuf,
    pub disable_feelings: bool,
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
        };
        let mut args = args.into_iter().map(Into::into);
        while let Some(flag) = args.next() {
            if flag == "--disable-feelings" {
                config.disable_feelings = true;
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
