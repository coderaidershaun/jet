//! Which provider answers the chat, Claude Code, Codex or agy: where its program is, the stand-in
//! that fails each reply when it is missing, and the status the page checks.

use std::path::{Path, PathBuf};
use std::sync::{Arc, mpsc};
use std::thread;

use agent::{
    AgyCli, ClaudeCli, CodexCli, ContextStatus, Lines, Model, Request, Transport, TransportError,
};
use serde::Serialize;

use super::error::BridgeError;
use crate::settings::{ProgramPaths, Settings};
use crate::store::ChatId;

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

/// agy at a version the limit to Jet's tools was not proven on. Every reply fails with the reason,
/// so an agy that replaced itself with a newer version stops instead of running untested.
struct UnprovenAgy {
    program: PathBuf,
    found: String,
}

impl UnprovenAgy {
    fn error(&self) -> TransportError {
        TransportError::AgyVersion {
            program: self.program.clone(),
            found: self.found.clone(),
        }
    }
}

impl Transport for UnprovenAgy {
    fn start(&self, _request: &Request) -> Result<Lines, TransportError> {
        Err(self.error())
    }
}

/// The provider a model runs on.
struct Selected {
    name: &'static str,
    /// Where the program is, or the places that were searched. For a program that must not run,
    /// the one entry says why.
    program: Result<PathBuf, Vec<String>>,
    /// Runs the provider, or fails each reply when the program is missing.
    transport: Arc<dyn Transport>,
}

/// This is the one place that maps a model to a provider. Only agy needs the chat: its turns run
/// in a folder of the chat's own.
fn select(
    model: Model,
    paths: &ProgramPaths,
    data_dir: &Path,
    chat: ChatId,
) -> Result<Selected, BridgeError> {
    let (name, located, missing): (_, _, fn(_) -> _) = if model.is_codex() {
        (
            "Codex",
            CodexCli::locate(paths.codex_path.as_deref(), data_dir)
                .map(|cli| (cli.program().to_path_buf(), Arc::new(cli) as _)),
            |searched| TransportError::CodexMissing { searched },
        )
    } else if model.is_agy() {
        (
            "agy",
            AgyCli::locate(paths.agy_path.as_deref(), data_dir, chat.0)
                .map(|cli| (cli.program().to_path_buf(), Arc::new(cli) as _)),
            |searched| TransportError::AgyMissing { searched },
        )
    } else {
        (
            "Claude Code",
            ClaudeCli::locate(paths.claude_path.as_deref(), data_dir)
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
            TransportError::ClaudeMissing { searched }
            | TransportError::CodexMissing { searched }
            | TransportError::AgyMissing { searched },
        ) => Ok(Selected {
            name,
            program: Err(searched.clone()),
            transport: Arc::new(MissingAgent {
                searched,
                error: missing,
            }),
        }),
        Err(TransportError::AgyVersion { program, found }) => {
            let unproven = UnprovenAgy { program, found };
            Ok(Selected {
                name,
                program: Err(vec![unproven.error().to_string()]),
                transport: Arc::new(unproven),
            })
        }
        Err(other) => Err(other.into()),
    }
}

pub(super) fn transport_for(
    model: Model,
    paths: &ProgramPaths,
    data_dir: &Path,
    chat: ChatId,
) -> Result<Arc<dyn Transport>, BridgeError> {
    Ok(select(model, paths, data_dir, chat)?.transport)
}

/// What a reply that could not start says instead of the places of the program on the server.
const PLACES_HIDDEN: &str = "the places set on this server";

/// A provider whose failures name no place on the server, for a user who is not an admin: neither a
/// failed start nor the error output of a run that exits badly.
pub(super) struct PlacesHidden(pub Arc<dyn Transport>);

impl Transport for PlacesHidden {
    fn review_model(&self) -> Model {
        self.0.review_model()
    }

    fn start(&self, request: &Request) -> Result<Lines, TransportError> {
        let lines = self.0.start(request).map_err(hide_places)?;
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            for line in lines.receiver {
                if sender.send(line.map_err(hide_places)).is_err() {
                    break;
                }
            }
        });
        Ok(Lines {
            receiver,
            stopper: lines.stopper,
        })
    }
}

fn hide_places(error: TransportError) -> TransportError {
    let hidden = || vec![PLACES_HIDDEN.to_owned()];
    match error {
        TransportError::ClaudeMissing { .. } => {
            TransportError::ClaudeMissing { searched: hidden() }
        }
        TransportError::CodexMissing { .. } => TransportError::CodexMissing { searched: hidden() },
        TransportError::AgyMissing { .. } => TransportError::AgyMissing { searched: hidden() },
        TransportError::AgyVersion { found, .. } => TransportError::AgyVersion {
            program: PathBuf::from(PLACES_HIDDEN),
            found,
        },
        // The folder of an agy turn is named after the data folder.
        TransportError::AgyFolder(_) => TransportError::Spawn {
            program: PathBuf::from(PLACES_HIDDEN),
            source: std::io::Error::other("the folder for its turns cannot be used"),
        },
        TransportError::Spawn { source, .. } => TransportError::Spawn {
            program: PathBuf::from(PLACES_HIDDEN),
            source,
        },
        // The tail of the program's error output stays in the server's log, where an admin reads it.
        TransportError::Exited { code, stderr } => {
            eprintln!(
                "jet: a provider run exited with {code:?}: {}",
                stderr.trim()
            );
            TransportError::Exited {
                code,
                stderr: String::new(),
            }
        }
        other => other,
    }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    searched: Vec<String>,
}

impl AgentStatus {
    /// The status without the places of the program, which only an admin may read.
    pub(crate) fn without_program_paths(mut self) -> AgentStatus {
        self.program.path = None;
        self.program.searched.clear();
        self
    }
}

/// Where the selected agent is and the last measured context.
pub(super) fn agent_status(
    settings: &Settings,
    paths: &ProgramPaths,
    data_dir: &Path,
    chat: ChatId,
    conversation: &agent::Conversation,
) -> Result<AgentStatus, BridgeError> {
    let selected = select(settings.model, paths, data_dir, chat)?;
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
