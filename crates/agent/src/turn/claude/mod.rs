//! Runs the installed Claude Code program as a child process: finds it, builds the exact
//! command line and environment, feeds it the prompt and reads its output line by line.

mod args;
mod locate;

use std::ffi::{OsStr, OsString};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};

use super::transport::{Lines, Request, Stopper, Transport, TransportError};
use crate::child::{keep_tail, kill_and_reap, output_lines, wait_for_exit};
pub(crate) use args::mcp_config;
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
        let mut child = command
            .args(args(request).into_iter().map(OsString::from))
            .env(CACHE_TTL_ENV.0, CACHE_TTL_ENV.1)
            .envs(ISOLATION_ENV)
            .current_dir(&self.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(spawn_failed)?;
        let mut stdin = child.stdin.take().expect("stdin was piped");
        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");

        // A program that quit before reading closes the pipe. Its exit status and error
        // output explain why, so that is not reported as a write failure.
        let written = stdin.write_all(request.prompt.as_bytes());
        drop(stdin);
        if let Err(source) = written
            && source.kind() != std::io::ErrorKind::BrokenPipe
        {
            kill_and_reap(&mut child);
            return Err(TransportError::Stdin { source });
        }

        let child = Arc::new(Mutex::new(child));
        let stopper = Stopper::new({
            let child = Arc::clone(&child);
            move || {
                if let Ok(mut child) = child.lock() {
                    // A process that already exited cannot be killed, and that is fine.
                    child.kill().ok();
                }
            }
        });
        let stderr_tail = thread::spawn(move || keep_tail(stderr));
        let (sender, receiver) = mpsc::channel();
        let watcher = stopper.clone();
        thread::spawn(move || pump(stdout, &sender, &child, stderr_tail, &watcher));
        Ok(Lines { receiver, stopper })
    }
}

/// Sends every output line, then the exit status if the process failed on its own.
fn pump(
    stdout: impl Read,
    sender: &mpsc::Sender<Result<String, TransportError>>,
    child: &Mutex<Child>,
    stderr_tail: JoinHandle<String>,
    stopper: &Stopper,
) {
    for item in output_lines(stdout) {
        let item = item.map_err(|source| TransportError::Read { source });
        if sender.send(item).is_err() {
            // Nobody is listening any more, so there is no reason to let it run on.
            stopper.stop();
            break;
        }
    }
    let status = wait_for_exit(child);
    let stderr = stderr_tail.join().unwrap_or_default();
    if stopper.is_stopped() {
        return;
    }
    if let Some(status) = status.filter(|status| !status.success()) {
        let code = status.code();
        sender
            .send(Err(TransportError::Exited { code, stderr }))
            .ok();
    }
}
