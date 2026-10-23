//! Which provider answers the chat, Claude Code or Codex: where its program is, the stand-in that
//! fails each reply when it is missing, and the status the page checks.

use std::path::Path;
use std::sync::Arc;

use agent::{CacheStatus, ClaudeCli, CodexCli, Lines, Model, Request, Transport, TransportError};
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
    data_dir: String,
    busy: bool,
    cache: CacheStatus,
}

#[derive(Serialize)]
struct ProgramStatus {
    provider: &'static str,
    found: bool,
    path: Option<String>,
    searched: Vec<String>,
}

/// Where the selected agent is, whether a reply is running, and whether the prompt cache is warm.
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
    Ok(AgentStatus {
        claude: program,
        data_dir: data_dir.display().to_string(),
        busy: conversation.is_busy(),
        cache: conversation.cache_status()?,
    })
}
