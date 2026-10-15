//! Codex runs in a separate process so Jet can use the installed account and cancel each turn.
mod args;
mod events;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Instant;

use super::process::launch;
use super::{Lines, Request, Transport, TransportError};
use crate::chat::{Effort, Model};
use args::args;

#[derive(Debug, Clone)]
pub struct CodexCli {
    program: PathBuf,
    cwd: PathBuf,
}

impl CodexCli {
    pub fn at(program: PathBuf, cwd: PathBuf) -> Self {
        Self { program, cwd }
    }
    pub fn program(&self) -> &Path {
        &self.program
    }
    pub fn locate(configured: Option<&Path>, cwd: &Path) -> Result<Self, TransportError> {
        let candidates = if let Some(path) = configured {
            vec![path.to_path_buf()]
        } else {
            let mut paths: Vec<_> = std::env::var_os("PATH")
                .map(|p| std::env::split_paths(&p).map(|p| p.join("codex")).collect())
                .unwrap_or_default();
            if let Some(home) = std::env::var_os("HOME") {
                paths.push(PathBuf::from(home).join(".local/bin/codex"));
            }
            paths.extend(["/opt/homebrew/bin/codex", "/usr/local/bin/codex"].map(PathBuf::from));
            paths
        };
        candidates
            .iter()
            .find(|p| p.is_file())
            .map(|p| Self::at(p.clone(), cwd.to_path_buf()))
            .ok_or_else(|| TransportError::CodexMissing {
                searched: candidates.iter().map(|p| p.display().to_string()).collect(),
            })
    }
}

impl Transport for CodexCli {
    fn review_model(&self) -> Model {
        Model::Gpt6Luna
    }
    fn start(&self, request: &Request) -> Result<Lines, TransportError> {
        let spawn_failed = |source| TransportError::Spawn {
            program: self.program.clone(),
            source,
        };
        if !request.model.is_codex()
            || (request.effort == Effort::Ultra && !request.model.supports_ultra())
        {
            return Err(TransportError::CodexModel {
                model: request.model,
                effort: request.effort,
            });
        }
        std::fs::create_dir_all(&self.cwd).map_err(spawn_failed)?;
        let mut schema = request
            .schema
            .as_ref()
            .map(|value| {
                let mut file = tempfile::NamedTempFile::new()?;
                file.write_all(value.to_string().as_bytes())?;
                Ok::<_, std::io::Error>(file)
            })
            .transpose()
            .map_err(spawn_failed)?;
        let mut command = Command::new(&self.program);
        command
            .args(args(request, schema.as_ref().map(|f| f.path()))?)
            .current_dir(&self.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (name, _) in std::env::vars_os() {
            let key = name.to_string_lossy();
            if key.ends_with("_API_KEY")
                || key.starts_with("CODEX_THREAD")
                || key == "CODEX_SESSION_ID"
            {
                command.env_remove(name);
            }
        }
        let child = command.spawn().map_err(spawn_failed)?;
        let lines = launch(child, &request.prompt)?;
        let (sender, receiver) = mpsc::channel();
        let stopper = lines.stopper.clone();
        let watcher = stopper.clone();
        let model = request.model.alias().to_owned();
        let wants_structured_output = request.schema.is_some();
        std::thread::spawn(move || {
            let _schema = schema.take();
            let mut events = events::Events::new(model, wants_structured_output, Instant::now());
            for line in lines.receiver {
                let mapped = match line {
                    Ok(line) => events.translate(&line).into_iter().map(Ok).collect(),
                    Err(error) => vec![Err(error)],
                };
                for item in mapped {
                    if sender.send(item).is_err() {
                        watcher.stop();
                        return;
                    }
                }
            }
        });
        Ok(Lines { receiver, stopper })
    }
}
