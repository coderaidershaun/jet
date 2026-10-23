//! Both providers need the same prompt delivery, output readers and process cleanup.

use std::io::{Read, Write};
use std::process::Child;
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};

use super::{Lines, Stopper, TransportError};
use crate::child::{keep_tail, output_lines, wait_for_exit};

pub(super) fn launch(mut child: Child, prompt: &str) -> Result<Lines, TransportError> {
    let mut stdin = child.stdin.take().expect("stdin was piped");
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");

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
    let prompt = prompt.to_owned();
    let input_sender = sender.clone();
    let input_stopper = stopper.clone();
    // A provider that never reads its input must still be cancellable.
    thread::spawn(move || {
        if let Err(source) = stdin.write_all(prompt.as_bytes())
            && source.kind() != std::io::ErrorKind::BrokenPipe
        {
            if input_sender
                .send(Err(TransportError::Stdin { source }))
                .is_err()
            {
                eprintln!("jet: provider input failed after its reader closed");
            }
            input_stopper.stop();
        }
    });
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
