//! Both providers need the same prompt delivery, output readers and process cleanup.

use std::io::{Read, Write};
use std::process::Child;
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};

use super::{Lines, Stopper, TransportError};
use crate::child::{keep_tail, kill_and_reap, output_lines, wait_for_exit};

pub(super) fn launch(mut child: Child, prompt: &str) -> Result<Lines, TransportError> {
    let mut stdin = child.stdin.take().expect("stdin was piped");
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");

    // A program that quit before reading closes the pipe. Its exit status and error
    // output explain why, so that is not reported as a write failure.
    let written = stdin.write_all(prompt.as_bytes());
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
