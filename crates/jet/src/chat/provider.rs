//! Which provider answers the chat, Claude Code or Codex: where its program is, the stand-in that
//! fails each reply when it is missing, and the status the page checks.

use std::path::Path;
use std::sync::Arc;

use agent::{ClaudeCli, CodexCli, ContextStatus, Lines, Model, Request, Transport, TransportError};
use serde::Serialize;

use super::error::BridgeError;
use crate::settings::Settings;

/// A missing provider reaches the page through the same failure path as a failed run.
struct MissingAgent {
    is_codex: bool,
    searched: Vec<String>,
}

impl Transport for MissingAgent {
    fn start(&self, _request: &Request) -> Result<Lines, TransportError> {
        if self.is_codex {
            Err(TransportError::CodexMissing {
                searched: self.searched.clone(),
            })
        } else {
            Err(TransportError::ClaudeMissing {
                searched: self.searched.clone(),
            })
        }
    }
}

pub(super) fn transport_for(
    model: Model,
    claude_path: Option<&Path>,
    codex_path: Option<&Path>,
    data_dir: &Path,
) -> Result<Arc<dyn Transport>, BridgeError> {
    if model.is_codex() {
        return match CodexCli::locate(codex_path, data_dir) {
            Ok(codex) => Ok(Arc::new(codex)),
            Err(TransportError::CodexMissing { searched }) => Ok(Arc::new(MissingAgent {
                is_codex: true,
                searched,
            })),
            Err(other) => Err(other.into()),
        };
    }
    match ClaudeCli::locate(claude_path, data_dir) {
        Ok(claude) => Ok(Arc::new(claude)),
        Err(TransportError::ClaudeMissing { searched }) => Ok(Arc::new(MissingAgent {
            is_codex: false,
            searched,
        })),
        Err(other) => Err(other.into()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    // SMELL: this holds whichever provider is selected, Codex too, so the name misleads. The
    // page reads the name, so rename both together.
    claude: ProgramStatus,
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
// SMELL: this makes the same choice between Claude Code and Codex as transport_for, so a new
// provider must be added in both places.
pub(super) fn agent_status(
    settings: &Settings,
    data_dir: &Path,
    conversation: &agent::Conversation,
) -> Result<AgentStatus, BridgeError> {
    let provider = if settings.model.is_codex() {
        "Codex"
    } else {
        "Claude Code"
    };
    let located = if settings.model.is_codex() {
        CodexCli::locate(settings.codex_path.as_deref(), data_dir)
            .map(|cli| cli.program().to_path_buf())
    } else {
        ClaudeCli::locate(settings.claude_path.as_deref(), data_dir)
            .map(|cli| cli.program().to_path_buf())
    };
    let program = match located {
        Ok(path) => ProgramStatus {
            provider,
            found: true,
            path: Some(path.display().to_string()),
            searched: Vec::new(),
        },
        Err(
            TransportError::ClaudeMissing { searched } | TransportError::CodexMissing { searched },
        ) => ProgramStatus {
            provider,
            found: false,
            path: None,
            searched,
        },
        Err(other) => return Err(other.into()),
    };
    let mut context = conversation.context_status(settings.model)?;
    if context.limit_tokens.is_none() && settings.model.is_codex() {
        let home = std::env::var_os("CODEX_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".codex"))
            });
        context.limit_tokens = home.and_then(|home| {
            model_context_limit(&home.join("models_cache.json"), settings.model.alias())
        });
    }
    Ok(AgentStatus {
        claude: program,
        context,
    })
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
