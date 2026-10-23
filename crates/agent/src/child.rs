//! What every program Jet runs as a child process needs: reading its output a line at a time,
//! keeping the end of its error output, waiting for it to exit, and ending it.

use std::io::{self, BufRead, BufReader, Read};
use std::process::{Child, ExitStatus};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

/// How much of a program's error output is kept for the failure message.
const STDERR_KEPT: usize = 4096;

/// How often a finished process is looked for.
pub(crate) const EXIT_POLL: Duration = Duration::from_millis(10);

/// Returns the last `STDERR_KEPT` bytes of everything a program writes to its error output.
pub(crate) fn keep_tail(mut stderr: impl Read) -> String {
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
pub(crate) fn output_lines(reader: impl Read) -> impl Iterator<Item = io::Result<String>> {
    let mut reader = BufReader::new(reader);
    let mut buffer = Vec::new();
    let mut failed = false;
    std::iter::from_fn(move || {
        while !failed {
            buffer.clear();
            match reader.read_until(b'\n', &mut buffer) {
                Ok(0) => return None,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buffer).trim_end().to_owned();
                    if !line.is_empty() {
                        return Some(Ok(line));
                    }
                }
                Err(error) => {
                    failed = true;
                    return Some(Err(error));
                }
            }
        }
        None
    })
}

/// Waits without holding the lock, so a stop request can still get in.
pub(crate) fn wait_for_exit(child: &Mutex<Child>) -> Option<ExitStatus> {
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
