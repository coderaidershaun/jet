//! Runs the installed Claude Code program as a child process: finds it, builds the exact
//! command line and environment, feeds it the prompt and reads its output line by line.

mod args;
mod locate;

use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::transport::{Lines, Request, Stopper, Transport, TransportError};
use args::{CACHE_TTL_ENV, args};

/// Whether a variable is one that a running Claude Code session sets for its own tools.
fn is_session_variable(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT"].contains(&name.as_ref())
        || name.starts_with("CLAUDE_CODE_")
}

/// How much of Claude's error output is kept for the failure message.
const STDERR_KEPT: usize = 4096;

/// How often a finished process is looked for.
const EXIT_POLL: Duration = Duration::from_millis(10);

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
        // SMELL: the cache setting's name also starts with CLAUDE_CODE_, so it must be set
        // after the session variables are removed, or the removal can drop it.
        let mut child = command
            .args(args(request).into_iter().map(OsString::from))
            .env(CACHE_TTL_ENV.0, CACHE_TTL_ENV.1)
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

fn kill_and_reap(child: &mut Child) {
    child.kill().ok();
    child.wait().ok();
}

fn keep_tail(mut stderr: impl Read) -> String {
    let mut kept: Vec<u8> = Vec::new();
    let mut chunk = [0_u8; 1024];
    while let Ok(count) = stderr.read(&mut chunk) {
        if count == 0 {
            break;
        }
        kept.extend_from_slice(&chunk[..count]);
        if kept.len() > STDERR_KEPT {
            kept.drain(..kept.len() - STDERR_KEPT);
        }
    }
    String::from_utf8_lossy(&kept).into_owned()
}

/// Sends every output line, then the exit status if the process failed on its own.
fn pump(
    stdout: impl Read,
    sender: &mpsc::Sender<Result<String, TransportError>>,
    child: &Mutex<Child>,
    stderr_tail: JoinHandle<String>,
    stopper: &Stopper,
) {
    let mut reader = BufReader::new(stdout);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        let item = match reader.read_until(b'\n', &mut buffer) {
            Ok(0) => break,
            Ok(_) => Ok(String::from_utf8_lossy(&buffer).trim_end().to_owned()),
            Err(source) => Err(TransportError::Read { source }),
        };
        let failed = item.is_err();
        if matches!(&item, Ok(line) if line.is_empty()) {
            continue;
        }
        if sender.send(item).is_err() {
            // Nobody is listening any more, so there is no reason to let it run on.
            stopper.stop();
            break;
        }
        if failed {
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

/// Waits without holding the lock, so a stop request can still get in.
fn wait_for_exit(child: &Mutex<Child>) -> Option<ExitStatus> {
    loop {
        match child.lock().ok()?.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => thread::sleep(EXIT_POLL),
            Err(_) => return None,
        }
    }
}
