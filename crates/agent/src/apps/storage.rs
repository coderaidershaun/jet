//! Replace registry files atomically and leave old process settings intact.
use super::{App, AppId};
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("invalid app address {0:?}; enter a port or an HTTP(S) URL without credentials")]
    InvalidAddress(String),
    #[error("app label must not be empty")]
    EmptyLabel,
    #[error("app {0} is not registered")]
    NotFound(AppId),
    #[error("address is already registered as app {0}")]
    DuplicateAddress(AppId),
    #[error(
        "{path} contains process-command integrations; register running apps by HTTP(S) address instead; keep this file as a backup"
    )]
    LegacyCommands { path: PathBuf },
    #[error("registry {path} uses unsupported version {version}; expected version 1")]
    UnsupportedVersion { path: PathBuf, version: u64 },
    #[error("could not read or write registry {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid registry {path}: {source}")]
    Json {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("invalid registry {path}: {reason}")]
    InvalidRegistry { path: PathBuf, reason: String },
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedRegistry {
    version: u64,
    apps: Vec<App>,
}

pub(super) fn load(path: &Path) -> Result<Vec<App>, RegistryError> {
    let Some(value) = read_json(path)? else {
        return Ok(Vec::new());
    };
    reject_commands(path, &value)?;
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    if version != 1 {
        return Err(RegistryError::UnsupportedVersion {
            path: path.into(),
            version,
        });
    }
    let saved: SavedRegistry =
        serde_json::from_value(value).map_err(|source| RegistryError::Json {
            path: path.into(),
            source,
        })?;
    for (index, app) in saved.apps.iter().enumerate() {
        if saved.apps[..index]
            .iter()
            .any(|previous| previous.id == app.id || previous.base_url == app.base_url)
        {
            return Err(RegistryError::InvalidRegistry {
                path: path.into(),
                reason: "duplicate identity or base address".into(),
            });
        }
        super::descriptor::validate_app(app)?;
    }
    Ok(saved.apps)
}

pub(super) fn check_legacy_settings(path: &Path) -> Result<(), RegistryError> {
    if let Some(value) = read_json(path)?
        && let Some(mcp) = value.get("mcp")
    {
        reject_commands(path, mcp)?;
    }
    Ok(())
}

fn reject_commands(path: &Path, value: &serde_json::Value) -> Result<(), RegistryError> {
    fn has_command(value: &serde_json::Value) -> bool {
        match value {
            serde_json::Value::Object(fields) => {
                fields
                    .get("command")
                    .is_some_and(|command| command.as_str() != Some(""))
                    || (fields.contains_key("command")
                        && (fields.get("enabled").and_then(serde_json::Value::as_bool)
                            == Some(true)
                            || fields.get("cwd").is_some_and(|cwd| !cwd.is_null())))
                    || fields.values().any(has_command)
            }
            serde_json::Value::Array(items) => items.iter().any(has_command),
            _ => false,
        }
    }
    if has_command(value) {
        return Err(RegistryError::LegacyCommands { path: path.into() });
    }
    Ok(())
}

fn read_json(path: &Path) -> Result<Option<serde_json::Value>, RegistryError> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(RegistryError::Io {
                path: path.into(),
                source,
            });
        }
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|source| RegistryError::Json {
            path: path.into(),
            source,
        })
}

pub(super) fn save(path: &Path, apps: &[App]) -> Result<(), RegistryError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let io = |source| RegistryError::Io {
        path: path.into(),
        source,
    };
    std::fs::create_dir_all(parent).map_err(io)?;
    let bytes = serde_json::to_vec_pretty(&SavedRegistry {
        version: 1,
        apps: apps.to_vec(),
    })
    .map_err(|source| RegistryError::Json {
        path: path.into(),
        source,
    })?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(io)?;
    temporary.write_all(&bytes).map_err(io)?;
    temporary.as_file().sync_all().map_err(io)?;
    temporary.persist(path).map_err(|error| io(error.error))?;
    Ok(())
}
