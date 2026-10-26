//! Which provider answers the chat, Claude Code or Codex: where its program is, the stand-in that
//! fails each reply when it is missing, and the status the page checks.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use agent::{ClaudeCli, CodexCli, ContextStatus, Lines, Model, Request, Transport, TransportError};
use serde::Serialize;

use super::error::BridgeError;
use crate::settings::Settings;

/// A missing provider reaches the page through the same failure path as a failed run.
struct MissingAgent {
    searched: Vec<String>,
    error: fn(Vec<String>) -> TransportError,
}

impl Transport for MissingAgent {
    fn start(&self, _request: &Request) -> Result<Lines, TransportError> {
        Err((self.error)(self.searched.clone()))
    }
}

/// The provider a model runs on.
struct Selected {
    name: &'static str,
    /// Where the program is, or the places that were searched.
    program: Result<PathBuf, Vec<String>>,
    /// Runs the provider, or fails each reply when the program is missing.
    transport: Arc<dyn Transport>,
}

/// This is the one place that maps a model to a provider.
fn select(model: Model, settings: &Settings, data_dir: &Path) -> Result<Selected, BridgeError> {
    let (name, located, missing): (_, _, fn(_) -> _) = if model.is_codex() {
        (
            "Codex",
            CodexCli::locate(settings.codex_path.as_deref(), data_dir)
                .map(|cli| (cli.program().to_path_buf(), Arc::new(cli) as _)),
            |searched| TransportError::CodexMissing { searched },
        )
    } else {
        (
            "Claude Code",
            ClaudeCli::locate(settings.claude_path.as_deref(), data_dir)
                .map(|cli| (cli.program().to_path_buf(), Arc::new(cli) as _)),
            |searched| TransportError::ClaudeMissing { searched },
        )
    };
    match located {
        Ok((path, transport)) => Ok(Selected {
            name,
            program: Ok(path),
            transport,
        }),
        Err(
            TransportError::ClaudeMissing { searched } | TransportError::CodexMissing { searched },
        ) => Ok(Selected {
            name,
            program: Err(searched.clone()),
            transport: Arc::new(MissingAgent {
                searched,
                error: missing,
            }),
        }),
        Err(other) => Err(other.into()),
    }
}

pub(super) fn transport_for(
    model: Model,
    settings: &Settings,
    data_dir: &Path,
) -> Result<Arc<dyn Transport>, BridgeError> {
    Ok(select(model, settings, data_dir)?.transport)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    program: ProgramStatus,
    context: ContextStatus,
}

#[derive(Serialize)]
struct ProgramStatus {
    provider: &'static str,
    found: bool,
    path: Option<String>,
    searched: Vec<String>,
}

/// Where the selected agent is and the last measured context.
pub(super) fn agent_status(
    settings: &Settings,
    data_dir: &Path,
    conversation: &agent::Conversation,
) -> Result<AgentStatus, BridgeError> {
    let selected = select(settings.model, settings, data_dir)?;
    let program = match selected.program {
        Ok(path) => ProgramStatus {
            provider: selected.name,
            found: true,
            path: Some(path.display().to_string()),
            searched: Vec::new(),
        },
        Err(searched) => ProgramStatus {
            provider: selected.name,
            found: false,
            path: None,
            searched,
        },
    };
    let mut context = conversation.context_status(settings.model)?;
    if context.limit_tokens.is_none() && settings.model.is_codex() {
        let home = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")));
        context.limit_tokens = home.and_then(|home| {
            model_context_limit(&home.join("models_cache.json"), settings.model.alias())
        });
    }
    Ok(AgentStatus { program, context })
}

fn model_context_limit(path: &Path, model: &str) -> Option<u64> {
    let text = std::fs::read_to_string(path).ok()?;
    let metadata: serde_json::Value = serde_json::from_str(&text).ok()?;
    metadata["models"]
        .as_array()?
        .iter()
        .find(|entry| entry["slug"] == model)?["context_window"]
        .as_u64()
        .filter(|&limit| limit > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_context_limit_uses_selected_provider_metadata() {
        let dir = std::env::temp_dir().join(format!("jet-model-metadata-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("models_cache.json");
        std::fs::write(&path, r#"{"models":[{"slug":"gpt-6.1-sol","context_window":90000},{"slug":"other","context_window":0}]}"#).unwrap();
        assert_eq!(model_context_limit(&path, "gpt-6.1-sol"), Some(90000));
        assert_eq!(model_context_limit(&path, "gpt-6"), None);
        assert_eq!(model_context_limit(&path, "other"), None);
        std::fs::write(&path, "invalid").unwrap();
        assert_eq!(model_context_limit(&path, "gpt-6.1-sol"), None);
        std::fs::remove_dir_all(dir).unwrap();
        assert_eq!(model_context_limit(&path, "gpt-6.1-sol"), None);
    }
}
