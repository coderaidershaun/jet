//! Finds the installed Claude Code program, and names every place it looked when it is not there.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

use super::super::process::EXIT_POLL;
use super::ClaudeCli;
use crate::turn::transport::TransportError;

/// How long the login shell may take to say where Claude Code lives.
const SHELL_PROBE_LIMIT: Duration = Duration::from_secs(3);

impl ClaudeCli {
    /// Uses the configured path when there is one, and nothing else: a path that is not a
    /// file fails with that one path, so a wrong setting never runs some other Claude Code.
    /// With no configured path it looks in the usual install places, then asks the user's
    /// login shell, and fails with every place that was searched.
    pub fn locate(configured: Option<&Path>, cwd: &Path) -> Result<ClaudeCli, TransportError> {
        if let Some(path) = configured {
            return if path.is_file() {
                Ok(ClaudeCli::at(path.to_path_buf(), cwd.to_path_buf()))
            } else {
                Err(TransportError::ClaudeMissing {
                    searched: vec![path.display().to_string()],
                })
            };
        }
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let shell = std::env::var_os("SHELL").map(PathBuf::from);
        let candidates = candidate_paths(home.as_deref());
        let program = find_program(&candidates, shell.as_deref())?;
        Ok(ClaudeCli::at(program, cwd.to_path_buf()))
    }
}

fn candidate_paths(home: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
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

/// A path the login shell found is kept for the life of the process, because starting a login
/// shell is slow. A miss is not kept, so a Claude Code installed later is found without a restart.
fn ask_login_shell(shell: &Path) -> Option<PathBuf> {
    static FOUND: OnceLock<PathBuf> = OnceLock::new();
    if let Some(path) = FOUND.get() {
        return Some(path.clone());
    }
    let path = probe_login_shell(shell)?;
    Some(FOUND.get_or_init(|| path).clone())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locate_lists_every_place_searched() {
        // Made-up places, so the answer never depends on what this machine has installed.
        let nowhere = std::env::temp_dir().join("agent-no-claude-here");
        let missing = ["first", "second", "third"].map(|name| nowhere.join(name));
        let Err(TransportError::ClaudeMissing { searched }) = find_program(&missing, None) else {
            panic!("a made-up folder cannot hold Claude Code");
        };
        let in_order = missing.map(|path| path.display().to_string());
        assert_eq!(searched, in_order);

        // A path the user typed is the only place to look; no other Claude Code may stand in for it.
        let typed = nowhere.join("typed-claude");
        let Err(TransportError::ClaudeMissing { searched }) =
            ClaudeCli::locate(Some(&typed), &nowhere)
        else {
            panic!("a configured path that is not a file cannot be found");
        };
        assert_eq!(searched, [typed.display().to_string()]);
    }
}
