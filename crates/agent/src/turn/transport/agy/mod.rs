//! Google's agy program runs in a separate process on the account signed in on this machine.
//! It approves every tool request by itself, so a turn runs as an agent that has only Jet's tools.

mod args;
mod events;
mod folder;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, mpsc};
use std::time::SystemTime;

use serde_json::json;

use super::process::launch;
use super::{Lines, Request, SessionMode, Transport, TransportError};
use crate::chat::Model;
use args::args;
pub use folder::FolderError;
use folder::{Agent, prepare};

/// The versions of agy on which the limit to Jet's tools was proven. agy replaces itself with a
/// newer version in the background, and a version that nobody tested must not run.
pub(super) const PROVEN_VERSIONS: [&str; 1] = ["1.5.16"];

/// What each program said its version is, kept until its file changes, because the host looks
/// the program up for every message.
static VERSIONS: Mutex<Vec<(PathBuf, Stamp, String)>> = Mutex::new(Vec::new());

/// When a file was last changed and how long it is.
type Stamp = Option<(Option<SystemTime>, u64)>;

#[derive(Debug, Clone)]
pub struct AgyCli {
    program: PathBuf,
    folder: PathBuf,
}

impl AgyCli {
    /// The program as given, with no check of its version. `folder` is where the turns of one
    /// chat run. Two chats whose turns can run at the same
    /// time must not share one, because it holds the token of the running turn. It must lie
    /// outside every Git checkout, and only this user may be able to open it.
    pub fn at(program: PathBuf, folder: PathBuf) -> Self {
        Self { program, folder }
    }

    pub fn program(&self) -> &Path {
        &self.program
    }

    pub fn folder(&self) -> &Path {
        &self.folder
    }

    /// Finds the program. Its turns run in a folder of their own below the system's temporary
    /// folder, because the data folder may lie inside a checkout. `chat` tells the chats of one
    /// data folder apart, so that each chat has its own folder.
    ///
    /// # Errors
    /// `AgyMissing` when the program is in none of the places searched, and `AgyVersion` when it
    /// is not a version the limit was proven on.
    pub fn locate(
        configured: Option<&Path>,
        data_dir: &Path,
        chat: i64,
    ) -> Result<Self, TransportError> {
        let candidates = if let Some(path) = configured {
            vec![path.to_path_buf()]
        } else {
            let mut paths: Vec<_> = std::env::var_os("PATH")
                .map(|p| std::env::split_paths(&p).map(|p| p.join("agy")).collect())
                .unwrap_or_default();
            if let Some(home) = std::env::var_os("HOME") {
                paths.push(PathBuf::from(home).join(".local/bin/agy"));
            }
            paths.extend(["/opt/homebrew/bin/agy", "/usr/local/bin/agy"].map(PathBuf::from));
            paths
        };
        let Some(program) = candidates.iter().find(|p| p.is_file()) else {
            return Err(TransportError::AgyMissing {
                searched: candidates.iter().map(|p| p.display().to_string()).collect(),
            });
        };
        let found = version_of(program);
        if !PROVEN_VERSIONS.contains(&found.as_str()) {
            return Err(TransportError::AgyVersion {
                program: program.clone(),
                found,
            });
        }
        Ok(Self::at(program.clone(), folder_of(data_dir, chat)))
    }
}

/// The program, without Jet's own secrets and without any key in its environment: agy uses the
/// account signed in for this user and needs none of them.
fn command(program: &Path) -> Command {
    let mut command = Command::new(program);
    for (name, _) in std::env::vars_os() {
        let text = name.to_string_lossy();
        if text.ends_with("_API_KEY") || text.starts_with("JET_") {
            command.env_remove(name);
        }
    }
    command
}

/// What the program answers to `--version`, or `unknown` when it does not answer.
fn version_of(program: &Path) -> String {
    let file = std::fs::metadata(program).ok();
    let stamp: Stamp = file.map(|file| (file.modified().ok(), file.len()));
    let mut known = crate::lock(&VERSIONS);
    let same = |(path, at, _): &&(PathBuf, Stamp, String)| path == program && *at == stamp;
    if let Some((_, _, version)) = known.iter().find(same) {
        return version.clone();
    }
    let said = command(program)
        .arg("--version")
        .stdin(Stdio::null())
        .output();
    let version = match said {
        Ok(said) if said.status.success() => {
            String::from_utf8_lossy(&said.stdout).trim().to_owned()
        }
        _ => String::new(),
    };
    let version = if version.is_empty() {
        "unknown".to_owned()
    } else {
        version
    };
    known.retain(|(path, ..)| path != program);
    known.push((program.to_owned(), stamp, version.clone()));
    version
}

/// One folder for each chat of each data folder. The data folder's whole path goes into the
/// name as a hash, because a file name has room for 255 bytes only.
fn folder_of(data_dir: &Path, chat: i64) -> PathBuf {
    let whole = std::fs::canonicalize(data_dir)
        .or_else(|_| std::path::absolute(data_dir))
        .unwrap_or_else(|_| data_dir.to_owned());
    // FNV-1a, written out because the standard hasher may change between Rust releases, and a
    // changed name would leave the old folders behind.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in whole.as_os_str().as_encoded_bytes() {
        hash = (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3);
    }
    std::env::temp_dir().join(format!("jet-agy-{hash:016x}-chat-{chat}"))
}

/// Put before the message of a continued turn, because agy keeps the system prompt a
/// conversation began with.
fn with_changed_prompt(system_prompt: &str, message: &str) -> String {
    format!(
        "[Your instructions and notes have changed since this conversation began. The text \
         between the two lines of dashes replaces them in full.]\n-----\n{system_prompt}\n-----\n{message}"
    )
}

impl Transport for AgyCli {
    fn review_model(&self) -> Model {
        Model::Gemini4Neon
    }

    fn start(&self, request: &Request) -> Result<Lines, TransportError> {
        let agent = Agent::of(request);
        let args = args(request, &agent)?;
        let prepared = prepare(&self.folder, &agent, request)?;
        let continues = matches!(request.session, SessionMode::Resume(_));
        let prompt = if continues && prepared.prompt_changed {
            with_changed_prompt(&request.system_prompt, &request.prompt)
        } else {
            request.prompt.clone()
        };
        let message = json!({"event": "user", "message": {"content": prompt}}).to_string() + "\n";
        let mut command = command(&self.program);
        command
            .args(args)
            .current_dir(&self.folder)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = command.spawn().map_err(|source| TransportError::Spawn {
            program: self.program.clone(),
            source,
        })?;
        let lines = launch(child, &message);
        let (sender, receiver) = mpsc::channel();
        let stopper = lines.stopper.clone();
        let watcher = stopper.clone();
        let folder = self.folder.clone();
        std::thread::spawn(move || {
            // The file with the turn's token goes when the run is over.
            let _token_file = prepared.token_file;
            let mut events = events::Events::new(agent.allowed);
            for line in lines.receiver {
                let translated = line.and_then(|line| events.translate(&line));
                let limit_in_doubt = match &translated {
                    Err(
                        error @ (TransportError::AgyTool { .. } | TransportError::AgyLine { .. }),
                    ) => {
                        // The user of the chat sees the failed reply; this line is for whoever
                        // runs the server.
                        eprintln!("jet: stopped the agy turn in {}: {error}", folder.display());
                        true
                    }
                    _ => false,
                };
                let items = match translated {
                    Ok(lines) => lines.into_iter().map(Ok).collect(),
                    Err(error) => vec![Err(error)],
                };
                for item in items {
                    if sender.send(item).is_err() {
                        watcher.stop();
                        return;
                    }
                }
                if limit_in_doubt {
                    watcher.stop();
                    return;
                }
            }
        });
        Ok(Lines { receiver, stopper })
    }
}
