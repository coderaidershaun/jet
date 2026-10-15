//! The thread that keeps polysim-bridge running: it starts the program, passes its lines on,
//! writes the page's commands to its input, and starts it again when it fails.
//!
//! A lock guard that is a temporary of a `match` or `if let` head lives to the end of the whole
//! block. So every place that takes something out of a mutex does it in a `let` statement of its
//! own first. No lock is held while sleeping or waiting for a process, and none but the sink's own
//! while calling the sink.

use std::io::{self, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use super::line::{
    BridgeStatus, Checked, check, hide_token, missing_detail, protocol_detail, restart_detail,
    usage_detail,
};
use super::sink::{Call, Sink};
use super::{BridgeLaunch, FeedError, RESTART_DELAYS};
use crate::child::{EXIT_POLL, keep_tail, kill_and_reap, output_lines};

/// How long a bridge may take to leave after its input closed, before it is killed.
const STOP_GRACE: Duration = Duration::from_secs(1);

/// A run this long counts as working, so the next failure starts the delays again.
const STEADY_RUN: Duration = Duration::from_secs(30);

/// A run that ends this soon, before it says hello, failed on its arguments or its start-up.
const FAST_FAIL: Duration = Duration::from_secs(1);

/// How many such runs in a row it takes to stop trying.
const FAST_FAILS_ALLOWED: u32 = 2;

const DROPPED_LINE_CHARS: usize = 120;

/// What a page that took over the feed is asked for, so that the bridge says everything again.
const RESYNC: &str = r#"{"cmd":"resync"}"#;

/// What the feed and its supervisor thread share.
pub(super) struct Shared {
    stopping: AtomicBool,
    sink: Mutex<Sink>,
    run: Mutex<Option<Run>>,
    wake: (Mutex<()>, Condvar),
}

/// The running bridge, as far as the outside needs it: the process, to end it, and the queue
/// that feeds its input.
struct Run {
    child: Arc<Mutex<Child>>,
    commands: mpsc::Sender<String>,
}

/// A lock that still opens after another thread panicked while holding it.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Shared {
    pub(super) fn new(sink: Call) -> Shared {
        Shared {
            stopping: AtomicBool::new(false),
            sink: Mutex::new(Sink::new(sink)),
            run: Mutex::new(None),
            wake: (Mutex::new(()), Condvar::new()),
        }
    }

    fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    /// Lets `send` hand lines to the sink, unless the feed was stopped.
    // The sink runs while this lock is held, so `stop` can wait for a line in flight and promise
    // that none follows it. That means the sink must never wait for the main thread, which is
    // where `stop` runs when the app closes, and must never call back into the feed.
    fn deliver(&self, send: impl FnOnce(&mut Sink)) {
        let mut sink = lock(&self.sink);
        if self.is_stopping() {
            return;
        }
        send(&mut sink);
    }

    fn emit_status(&self, status: BridgeStatus, detail: &str) {
        let line = status.line(detail);
        self.deliver(|sink| sink.send_status(status, line));
    }

    fn emit_bridge_line(&self, kind: &str, line: String) {
        self.deliver(|sink| sink.send_bridge_line(kind, line));
    }

    /// Moves the lines to a new sink, after telling it the lines the old one has been told that
    /// still hold. Returns `false`, and leaves everything as it was, when the feed has ended.
    pub(super) fn reattach(&self, sink: Call) -> bool {
        // Kept to the end, so that the old sink is dropped where no lock is held.
        let _old_sink = {
            let mut current = lock(&self.sink);
            if self.is_stopping() || current.has_ended() {
                return false;
            }
            current.take_over(sink)
        };
        // A bridge that waits to be started again has no input; its next run says it all anyway.
        self.send(RESYNC).ok();
        true
    }

    pub(super) fn send(&self, command: &str) -> Result<(), FeedError> {
        let slot = lock(&self.run);
        let run = slot.as_ref().ok_or(FeedError::NotRunning)?;
        run.commands
            .send(command.to_owned())
            .map_err(|_| FeedError::NotRunning)
    }

    pub(super) fn stop(&self) {
        // Set before anything else, so the waits below see it and the sink refuses new lines.
        self.stopping.store(true, Ordering::SeqCst);
        let run = lock(&self.run).take();
        if let Some(run) = run {
            end_process(run);
        }
        // Taking the wake lock once means the supervisor is either still to check the flag or
        // already waiting, so the notice below cannot be missed.
        drop(lock(&self.wake.0));
        self.wake.1.notify_all();
        // Taking the sink lock once waits for a line that is being handed over right now.
        drop(lock(&self.sink));
    }

    /// Waits for `delay`, or until the feed is stopped.
    fn wait_unless_stopped(&self, delay: Duration) {
        let guard = lock(&self.wake.0);
        drop(
            self.wake
                .1
                .wait_timeout_while(guard, delay, |()| !self.is_stopping())
                .unwrap_or_else(PoisonError::into_inner),
        );
    }
}

/// Closes the bridge's input, gives it a moment to leave on its own, then kills it. Returns how
/// it left, or `None` when it had to be killed.
fn end_process(run: Run) -> Option<ExitStatus> {
    let Run { child, commands } = run;
    // The writer thread writes what is still queued, then closes the input.
    drop(commands);
    let deadline = Instant::now() + STOP_GRACE;
    loop {
        let status = lock(&child).try_wait();
        match status {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(EXIT_POLL),
            Ok(None) | Err(_) => {
                kill_and_reap(&mut lock(&child));
                return None;
            }
        }
    }
}

/// A started bridge: its process, the queue that feeds its input, and what it writes.
struct Started {
    child: Arc<Mutex<Child>>,
    commands: mpsc::Sender<String>,
    output: Output,
}

/// What the supervisor reads from a running bridge: its lines, and the end of its error output.
struct Output {
    stdout: ChildStdout,
    stderr_tail: JoinHandle<String>,
}

fn spawn(launch: &BridgeLaunch) -> io::Result<Started> {
    let mut command = Command::new(&launch.program);
    command.arg("--strategy").arg(&launch.strategy_id);
    for link in &launch.links {
        command.arg("--link").arg(link);
    }
    if let Some(token) = &launch.token {
        command.arg("--token").arg(token);
    }
    let mut child = command
        .current_dir(&launch.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdin = child.stdin.take().expect("stdin was piped");
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let stderr_tail = thread::spawn(move || keep_tail(stderr));
    let (commands, queued) = mpsc::channel();
    thread::spawn(move || write_commands(stdin, &queued));
    Ok(Started {
        child: Arc::new(Mutex::new(child)),
        commands,
        output: Output {
            stdout,
            stderr_tail,
        },
    })
}

/// Writes each queued command as a line. A bridge that does not read its input blocks only this
/// thread; it ends when the queue closes or the pipe breaks.
fn write_commands(mut stdin: ChildStdin, queued: &mpsc::Receiver<String>) {
    for command in queued {
        if writeln!(stdin, "{command}")
            .and_then(|()| stdin.flush())
            .is_err()
        {
            break;
        }
    }
}

/// How one run ended.
enum RunEnd {
    /// The feed was stopped.
    Stopped,
    /// It cannot be started again, and the page was told why.
    GaveUp,
    /// The bridge quit by itself.
    Failed {
        code: Option<i32>,
        stderr: String,
        has_said_hello: bool,
    },
}

/// Runs polysim-bridge, and again each time it fails, until the feed is stopped or the bridge
/// cannot run. The delays between runs follow `launch`, and start over after a long steady run.
pub(super) fn supervise(shared: &Shared, launch: &BridgeLaunch) {
    let delays: &[Duration] = if launch.restart_delays.is_empty() {
        &RESTART_DELAYS
    } else {
        &launch.restart_delays
    };
    let mut attempt = 0;
    let mut fast_fails = 0;
    while !shared.is_stopping() {
        let started_at = Instant::now();
        let RunEnd::Failed {
            code,
            stderr,
            has_said_hello,
        } = run_once(shared, launch)
        else {
            return;
        };
        let lived = started_at.elapsed();
        if lived >= STEADY_RUN {
            attempt = 0;
        }
        if code != Some(0) && lived < FAST_FAIL && !has_said_hello {
            fast_fails += 1;
        } else {
            fast_fails = 0;
        }
        if fast_fails == FAST_FAILS_ALLOWED {
            shared.emit_status(BridgeStatus::Exited, &usage_detail(launch, code, &stderr));
            return;
        }
        let delay = delays[attempt.min(delays.len() - 1)];
        attempt += 1;
        let detail = restart_detail(launch, code, &stderr, delay);
        shared.emit_status(BridgeStatus::Restarting, &detail);
        shared.wait_unless_stopped(delay);
    }
}

fn run_once(shared: &Shared, launch: &BridgeLaunch) -> RunEnd {
    shared.emit_status(
        BridgeStatus::Starting,
        &format!(
            "starting {} for {}",
            launch.program.display(),
            launch.strategy_id
        ),
    );
    if let Some(detail) = missing_detail(launch) {
        shared.emit_status(BridgeStatus::Missing, &detail);
        return RunEnd::GaveUp;
    }
    let Started {
        child,
        commands,
        output,
    } = match spawn(launch) {
        Ok(started) => started,
        Err(error) => {
            let detail = format!("could not start {}: {error}", launch.program.display());
            shared.emit_status(BridgeStatus::Missing, &detail);
            return RunEnd::GaveUp;
        }
    };

    // Checked while holding the run lock, so a stop that began meanwhile is never missed: it
    // either sees this run and ends it, or this sees the stop and ends the process itself.
    let mut slot = lock(&shared.run);
    if shared.is_stopping() {
        drop(slot);
        kill_and_reap(&mut lock(&child));
        return RunEnd::Stopped;
    }
    *slot = Some(Run { child, commands });
    drop(slot);
    follow_run(shared, launch, output)
}

/// Passes the bridge's lines on while it runs, then ends its process and says how the run ended.
fn follow_run(shared: &Shared, launch: &BridgeLaunch, output: Output) -> RunEnd {
    let Output {
        stdout,
        stderr_tail,
    } = output;
    let mut reported_drop = false;
    let mut has_said_hello = false;
    for line in output_lines(stdout) {
        let Ok(line) = line else {
            break;
        };
        match check(&line) {
            Checked::Pass { kind } => {
                has_said_hello |= kind == "hello";
                shared.emit_bridge_line(&kind, line);
            }
            Checked::Dropped if !reported_drop => {
                reported_drop = true;
                let shown = hide_token(launch, &line);
                // SMELL: a library writing to the error output itself. The sink carries only
                // lines for the page, so there is no other way yet to tell the developer.
                eprintln!(
                    "jet: polysim-bridge printed a line that is not a bridge line, so it was not passed on: {}",
                    shown.chars().take(DROPPED_LINE_CHARS).collect::<String>()
                );
            }
            Checked::Dropped => {}
            Checked::OtherProtocol(found) => {
                shared.emit_bridge_line("hello", line);
                let run = lock(&shared.run).take();
                if let Some(run) = run {
                    end_process(run);
                }
                stderr_tail.join().ok();
                shared.emit_status(BridgeStatus::Exited, &protocol_detail(found.as_ref()));
                return RunEnd::GaveUp;
            }
        }
    }

    // The bridge may have closed its output and still run, so its input is closed too and it gets
    // the same moment to leave as at a stop. `None` means a stop already took it.
    let run = lock(&shared.run).take();
    let status = run.and_then(end_process);
    let stderr = stderr_tail.join().unwrap_or_default();
    if shared.is_stopping() {
        return RunEnd::Stopped;
    }
    RunEnd::Failed {
        code: status.and_then(|status| status.code()),
        stderr,
        has_said_hello,
    }
}
