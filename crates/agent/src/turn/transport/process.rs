//! Both providers need the same prompt delivery, output readers and process cleanup.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::process::{Child, ExitStatus};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::{Lines, Stopper, TransportError};

pub(super) fn launch(mut child: Child, prompt: &str) -> Lines {
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
    Lines { receiver, stopper }
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

/// How much of a program's error output is kept for the failure message.
const STDERR_KEPT: usize = 4096;

/// How often a finished process is looked for.
pub(super) const EXIT_POLL: Duration = Duration::from_millis(10);

/// Returns the last `STDERR_KEPT` bytes of everything a program writes to its error output.
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

/// The lines a program writes to its output, without the line break and without empty lines.
/// A read error is the last item.
fn output_lines(reader: impl Read) -> impl Iterator<Item = io::Result<String>> {
    let mut failed = false;
    BufReader::new(reader)
        .split(b'\n')
        .take_while(move |item| {
            let already_failed = std::mem::replace(&mut failed, item.is_err());
            !already_failed
        })
        .map(|item| item.map(|bytes| String::from_utf8_lossy(&bytes).trim_end().to_owned()))
        .filter(|item| !matches!(item, Ok(line) if line.is_empty()))
}

/// Waits without holding the lock, so a stop request can still get in.
fn wait_for_exit(child: &Mutex<Child>) -> Option<ExitStatus> {
    loop {
        // The lock is let go at the end of this line. Matching on the lock call itself would
        // keep it through the sleep below.
        let status = child.lock().ok()?.try_wait();
        match status {
            Ok(Some(status)) => return Some(status),
            Ok(None) => thread::sleep(EXIT_POLL),
            Err(_) => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fails on every read, like a pipe that broke.
    struct Broken;

    impl Read for Broken {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("pipe broke"))
        }
    }

    #[test]
    fn output_lines_trim_skip_blanks_and_end_at_the_first_read_error() {
        let output: &[u8] = b"first  \r\n\n   \nsecond \xff\nthird\n";
        let items: Vec<_> = output_lines(output.chain(Broken)).collect();
        let lines: Vec<&str> = items
            .iter()
            .filter_map(|item| item.as_ref().ok())
            .map(String::as_str)
            .collect();
        assert_eq!(lines, ["first", "second \u{fffd}", "third"]);
        assert_eq!(items.len(), 4, "{items:?}");
        assert!(items[3].is_err());
    }
}
