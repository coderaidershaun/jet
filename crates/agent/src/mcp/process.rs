//! The child processes behind the shared servers: starting a library's program in its
//! `--http` mode, reading what it says on its error output, and stopping it politely.

use std::io::{self, BufRead, BufReader};
use std::net::TcpListener;
use std::process::{Child, ChildStderr, Command, Stdio};
use std::time::{Duration, Instant};

use crate::chat::McpServer;

/// How often a stopping program is checked to see if it has gone.
const STOP_POLL: Duration = Duration::from_millis(50);

/// A port on this machine that nothing listens on right now. No program may start while it
/// runs: on macOS one started meanwhile can inherit the socket and keep the port.
pub(super) fn free_port() -> io::Result<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

/// Starts `<program> --http <port>` in the server's folder. Standard input stays closed on
/// purpose: a program that has no `--http` mode would otherwise wait for input in its
/// plain mode instead of exiting, and it would be taken for a working one.
pub(super) fn spawn_http(server: &McpServer, port: u16) -> io::Result<Child> {
    let mut command = Command::new(&server.command);
    command
        .arg("--http")
        .arg(port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if let Some(cwd) = &server.cwd {
        command.current_dir(cwd);
    }
    command.spawn()
}

/// Copies the program's error output to Jet's own, line by line, until it ends, and calls
/// `on_ready` the first time a line holds `ready_text`.
pub(super) fn pass_on_stderr(
    stderr: ChildStderr,
    ready_text: String,
    on_ready: impl FnOnce() + Send + 'static,
) {
    std::thread::spawn(move || {
        let mut on_ready = Some(on_ready);
        for line in BufReader::new(stderr).split(b'\n').map_while(Result::ok) {
            let line = String::from_utf8_lossy(&line);
            eprintln!("{line}");
            if line.contains(&ready_text)
                && let Some(on_ready) = on_ready.take()
            {
                on_ready();
            }
        }
    });
}

/// Asks the program to stop, waits up to `wait` for it to go, then kills it.
pub(super) fn terminate(mut child: Child, wait: Duration) {
    // polysim stops the engines it started only when it is asked to stop. A bare kill would
    // leave them running with nobody to look after them.
    let asked = Command::new("/bin/kill")
        .args(["-TERM", &child.id().to_string()])
        .status();
    if !asked.is_ok_and(|status| status.success()) {
        kill(&mut child);
    }
    let deadline = Instant::now() + wait;
    while Instant::now() < deadline {
        let exited = child.try_wait();
        if !matches!(exited, Ok(None)) {
            return;
        }
        std::thread::sleep(STOP_POLL);
    }
    kill(&mut child);
    if let Err(error) = child.wait() {
        eprintln!("jet: could not wait for a stopped server: {error}");
    }
}

fn kill(child: &mut Child) {
    if let Err(error) = child.kill() {
        eprintln!("jet: could not kill a server: {error}");
    }
}
