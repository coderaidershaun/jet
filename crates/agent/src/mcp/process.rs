//! The child processes behind the shared servers: starting a library's program in its
//! `--http` mode, reading what it says on its error output, and stopping it politely.

use std::io::{self, BufRead, BufReader};
use std::net::TcpListener;
use std::process::{Child, ChildStderr, Command, Stdio};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use crate::chat::McpServer;

/// How often a stopping program is checked to see if it has gone.
const STOP_POLL: Duration = Duration::from_millis(50);

/// Held while a server program starts. On macOS a program started at the very moment a pipe
/// is made can inherit it, so a quanty started beside polysim could keep polysim's input open
/// after Jet ends.
// SMELL: Claude Code and polysim-bridge start without this lock, so one of them can still
// inherit polysim's input, and polysim then stops only once that program has ended too.
static STARTING: Mutex<()> = Mutex::new(());

/// A port on this machine that nothing listens on right now. No program may start while it
/// runs: on macOS one started meanwhile can inherit the socket and keep the port.
pub(super) fn free_port() -> io::Result<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

/// Only polysim takes `--watch-stdin`, with which it stops its engines when its input
/// closes. quanty does not know the flag.
fn watches_its_input(library: &str) -> bool {
    library == "polysim"
}

/// Starts `<program> --http <port>` in the server's folder, for the library of that name.
///
/// A program that watches its input also gets `--watch-stdin` and a pipe for that input
/// which nobody writes to. Every other program gets its standard input closed on purpose:
/// one that has no `--http` mode would otherwise wait for input in its plain mode instead
/// of exiting, and it would be taken for a working one.
pub(super) fn spawn_http(library: &str, server: &McpServer, port: u16) -> io::Result<Child> {
    let mut command = Command::new(&server.command);
    command.arg("--http").arg(port.to_string());
    if watches_its_input(library) {
        // Nothing may write to this pipe or take it out of the `Child`. It then stays open for
        // as long as Jet holds the child, and the system closes it when Jet ends, however it ends.
        command.arg("--watch-stdin").stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }
    command.stdout(Stdio::null()).stderr(Stdio::piped());
    if let Some(cwd) = &server.cwd {
        command.current_dir(cwd);
    }
    let _one_at_a_time = STARTING.lock().unwrap_or_else(PoisonError::into_inner);
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
    // Closing the pipe stops a program that watches its input, by the same route as a Jet that
    // has ended. Other programs have no pipe, so this does nothing for them.
    drop(child.stdin.take());
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
