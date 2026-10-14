//! Runs the installed Claude Code program as a child process: finds it, builds the exact
//! command line and environment, feeds it the prompt and reads its output line by line.
//! The flags and their order stay fixed so that Claude's prompt cache keeps hitting.

use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex, OnceLock, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use super::transport::{Lines, Request, SessionMode, Stopper, Transport, TransportError};

/// Keeps Claude's prompt cache alive for an hour instead of five minutes.
const CACHE_TTL_ENV: (&str, &str) = ("CLAUDE_CODE_PROMPT_CACHE_TTL", "1h");

/// Whether a variable is one that a running Claude Code session sets for its own tools.
fn is_session_variable(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT"].contains(&name.as_ref())
        || name.starts_with("CLAUDE_CODE_")
}

/// How much of Claude's error output is kept for the failure message.
const STDERR_KEPT: usize = 4096;

/// How long the login shell may take to say where Claude Code lives.
const SHELL_PROBE_LIMIT: Duration = Duration::from_secs(3);

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
    /// Looks for Claude Code in the configured path, then the usual install places, then
    /// asks the user's login shell. Fails with every place that was searched.
    pub fn locate(configured: Option<&Path>, cwd: &Path) -> Result<ClaudeCli, TransportError> {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let shell = std::env::var_os("SHELL").map(PathBuf::from);
        let candidates = candidate_paths(configured, home.as_deref());
        let program = find_program(&candidates, shell.as_deref())?;
        Ok(ClaudeCli::at(program, cwd.to_path_buf()))
    }

    pub fn at(program: PathBuf, cwd: PathBuf) -> ClaudeCli {
        ClaudeCli { program, cwd }
    }

    pub fn program(&self) -> &Path {
        &self.program
    }
}

fn candidate_paths(configured: Option<&Path>, home: Option<&Path>) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = configured.map(Path::to_path_buf).into_iter().collect();
    if let Some(home) = home {
        paths.push(home.join(".local/bin/claude"));
        paths.push(home.join(".claude/local/claude"));
    }
    paths.push(PathBuf::from("/opt/homebrew/bin/claude"));
    paths.push(PathBuf::from("/usr/local/bin/claude"));
    paths
}

fn find_program(candidates: &[PathBuf], shell: Option<&Path>) -> Result<PathBuf, TransportError> {
    if let Some(found) = candidates.iter().find(|path| path.is_file()) {
        return Ok(found.clone());
    }
    let mut searched: Vec<String> = candidates
        .iter()
        .map(|path| path.display().to_string())
        .collect();
    if let Some(shell) = shell {
        if let Some(found) = ask_login_shell(shell) {
            return Ok(found);
        }
        searched.push(format!("{} -ilc 'command -v claude'", shell.display()));
    }
    Err(TransportError::ClaudeMissing { searched })
}

/// The answer is kept for the life of the process, because starting a login shell is slow.
// SMELL: a "not found" is kept too, so a Claude Code that only the login shell can find,
// installed after the app started, stays unfound until the app restarts.
fn ask_login_shell(shell: &Path) -> Option<PathBuf> {
    static ANSWER: OnceLock<Option<PathBuf>> = OnceLock::new();
    ANSWER.get_or_init(|| probe_login_shell(shell)).clone()
}

fn probe_login_shell(shell: &Path) -> Option<PathBuf> {
    let mut child = Command::new(shell)
        .args(["-ilc", "command -v claude"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = thread::spawn(move || {
        let mut text = String::new();
        stdout.read_to_string(&mut text).ok().map(|_| text)
    });
    let deadline = Instant::now() + SHELL_PROBE_LIMIT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(EXIT_POLL),
            Ok(None) | Err(_) => {
                // The shell is taking too long, or cannot be asked: give up on it.
                child.kill().ok();
                child.wait().ok();
                break;
            }
        }
    }
    let text = reader.join().ok()??;
    // Interactive shells may print greetings first; the answer is the last line.
    let path = PathBuf::from(
        text.lines()
            .rev()
            .find(|line| !line.trim().is_empty())?
            .trim(),
    );
    path.is_absolute()
        .then_some(path)
        .filter(|path| path.is_file())
}

/// The command line for a request. One function builds both the chat and the review
/// call, so the order of the flags cannot drift between them.
fn args(request: &Request) -> Vec<String> {
    let ephemeral = request.session == SessionMode::Ephemeral;
    let mut args: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose"]
        .map(String::from)
        .into();
    if !ephemeral {
        args.push("--include-partial-messages".into());
    }
    args.extend([
        "--model".into(),
        request.model.alias().into(),
        "--effort".into(),
        request.effort.alias().into(),
        "--system-prompt".into(),
        request.system_prompt.clone(),
    ]);
    if let Some(schema) = &request.schema {
        args.extend(["--json-schema".into(), schema.to_string()]);
    }
    args.extend(
        [
            "--tools",
            "",
            "--safe-mode",
            "--strict-mcp-config",
            "--no-chrome",
            "--permission-prompts",
            "none",
        ]
        .map(String::from),
    );
    if ephemeral {
        args.push("--no-session-persistence".into());
    } else {
        args.extend(["--autocompact".into(), "100k".into()]);
    }
    args.extend([
        "--max-budget-usd".into(),
        format!("{:.2}", request.budget_usd),
    ]);
    if let SessionMode::Resume(id) = &request.session {
        args.extend(["--resume".into(), id.0.clone()]);
    }
    args
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::chat::{Effort, Model, SessionId};

    fn chat_request(session: SessionMode) -> Request {
        Request {
            prompt: "hello".into(),
            system_prompt: "You-are-Jet.".into(),
            model: Model::Sonnet,
            effort: Effort::Medium,
            budget_usd: 1.0,
            session,
            schema: None,
        }
    }

    /// Splits a command line on spaces; `''` stands for one empty argument.
    fn words(line: &str) -> Vec<String> {
        let unquoted = |word: &str| word.trim_matches('\'').to_owned();
        line.split(' ').map(unquoted).collect()
    }

    #[test]
    fn chat_and_review_args_are_exact() {
        let new_chat = words(
            "-p --output-format stream-json --verbose --include-partial-messages \
             --model sonnet --effort medium --system-prompt You-are-Jet. \
             --tools '' --safe-mode --strict-mcp-config --no-chrome --permission-prompts none \
             --autocompact 100k --max-budget-usd 1.00",
        );
        assert_eq!(args(&chat_request(SessionMode::New)), new_chat);

        let resume = SessionMode::Resume(SessionId("abc-123".into()));
        let resumed = [new_chat, words("--resume abc-123")].concat();
        assert_eq!(args(&chat_request(resume)), resumed);

        let review = Request {
            prompt: "notes".into(),
            system_prompt: "Keep-notes.".into(),
            model: Model::Haiku,
            effort: Effort::Low,
            budget_usd: 0.2,
            session: SessionMode::Ephemeral,
            schema: Some(json!({"type": "object"})),
        };
        assert_eq!(
            args(&review),
            words(
                "-p --output-format stream-json --verbose --model haiku --effort low \
                 --system-prompt Keep-notes. --json-schema {\"type\":\"object\"} \
                 --tools '' --safe-mode --strict-mcp-config --no-chrome --permission-prompts none \
                 --no-session-persistence --max-budget-usd 0.20"
            )
        );
        assert_eq!(CACHE_TTL_ENV, ("CLAUDE_CODE_PROMPT_CACHE_TTL", "1h"));
    }

    #[test]
    fn locate_lists_every_place_searched() {
        let home = Path::new("/home/someone");
        let configured = Path::new("/opt/custom/claude");
        assert_eq!(
            candidate_paths(Some(configured), Some(home)),
            [
                configured.to_path_buf(),
                home.join(".local/bin/claude"),
                home.join(".claude/local/claude"),
                PathBuf::from("/opt/homebrew/bin/claude"),
                PathBuf::from("/usr/local/bin/claude"),
            ]
        );

        // Made-up places, so the answer never depends on what this machine has installed.
        let nowhere = std::env::temp_dir().join("agent-no-claude-here");
        let missing = ["first", "second", "third"].map(|name| nowhere.join(name));
        let Err(TransportError::ClaudeMissing { searched }) = find_program(&missing, None) else {
            panic!("a made-up folder cannot hold Claude Code");
        };
        let in_order = missing.map(|path| path.display().to_string());
        assert_eq!(searched, in_order);
    }
}
