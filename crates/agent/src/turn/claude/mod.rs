//! Runs the installed Claude Code program as a child process: finds it, builds the exact
//! command line and environment, feeds it the prompt and reads its output line by line.

mod args;
mod locate;

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::process::launch;
use super::transport::{Lines, Request, Transport, TransportError};
use args::{CACHE_TTL_ENV, ISOLATION_ENV, args};

/// Whether a variable is one that a running Claude Code session sets for its own tools.
fn is_session_variable(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT"].contains(&name.as_ref())
        || name.starts_with("CLAUDE_CODE_")
}

/// The installed Claude Code program and the folder it runs in. The folder never changes,
/// because Claude's prompt cache is kept per folder.
#[derive(Debug, Clone)]
pub struct ClaudeCli {
    program: PathBuf,
    cwd: PathBuf,
}

impl ClaudeCli {
    pub fn at(program: PathBuf, cwd: PathBuf) -> ClaudeCli {
        ClaudeCli { program, cwd }
    }

    pub fn program(&self) -> &Path {
        &self.program
    }
}

impl Transport for ClaudeCli {
    fn start(&self, request: &Request) -> Result<Lines, TransportError> {
        let spawn_failed = |source| TransportError::Spawn {
            program: self.program.clone(),
            source,
        };
        std::fs::create_dir_all(&self.cwd).map_err(spawn_failed)?;
        let mut command = Command::new(&self.program);
        // When a Claude Code session started this app, its variables would make the child
        // act as part of that session.
        for (name, _) in std::env::vars_os().filter(|(name, _)| is_session_variable(name)) {
            command.env_remove(name);
        }
        // SMELL: these settings' names also start with CLAUDE_CODE_, so they must be set
        // after the session variables are removed, or the removal can drop them.
        let child = command
            .args(args(request).into_iter().map(OsString::from))
            .env(CACHE_TTL_ENV.0, CACHE_TTL_ENV.1)
            .envs(ISOLATION_ENV)
            .current_dir(&self.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(spawn_failed)?;
        launch(child, &request.prompt)
    }
}
