//! The thread that keeps one library's server running: it starts the program, watches it,
//! starts it again after a pause whenever it dies, and stops it when told to.

use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::process::{pass_on_stderr, spawn_http, terminate};
use crate::chat::McpServer;

/// How long a program gets to print that it listens before it is taken for a working one.
const FIRST_WAIT: Duration = Duration::from_secs(2);

/// How long a stopping server gets to put its affairs in order before it is killed.
/// polysim stops its engines within 20 seconds.
const STOP_WAIT: Duration = Duration::from_secs(25);

/// How often a running server is checked to see if it has exited.
const EXIT_POLL: Duration = Duration::from_millis(50);

/// A server that ran this long before it died starts its restart delays from the first again.
const STEADY_AFTER: Duration = Duration::from_secs(30);

/// How long to wait before starting a server that died again, by how often it died in a row.
const RESTART_DELAYS: [Duration; 4] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
];

/// What a keeper needs to start its server again and again.
pub(super) struct Launch {
    pub(super) name: &'static str,
    pub(super) server: McpServer,
    pub(super) port: u16,
    pub(super) url: String,
}

/// How the first start of a server went.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum FirstOutcome {
    /// It printed that it listens.
    Ready,
    /// It printed nothing but stayed up for the first two seconds.
    Alive,
    /// It exited within the first two seconds without printing that it listens.
    Refused,
    /// The program could not be started at all.
    Unstartable,
}

/// A thread that starts one server and starts it again whenever it dies, and the way to
/// stop both.
pub(super) struct Keeper {
    state: Arc<KeeperState>,
    thread: Option<JoinHandle<()>>,
}

struct KeeperState {
    stopping: AtomicBool,
    child: Mutex<Option<Child>>,
    /// Pairs with `child`: wakes the keeper from its wait before a restart.
    wake: Condvar,
    first: Mutex<Option<FirstOutcome>>,
    /// Pairs with `first`.
    first_known: Condvar,
}

impl KeeperState {
    /// Records how the first start went and says whether this call was the one that did.
    /// Only the first call counts: the thread that reads the error output and the thread
    /// that watches the child may both have an opinion.
    fn decide(&self, outcome: FirstOutcome) -> bool {
        let mut first = lock(&self.first);
        if first.is_some() {
            return false;
        }
        *first = Some(outcome);
        self.first_known.notify_all();
        true
    }

    fn is_decided(&self) -> bool {
        lock(&self.first).is_some()
    }
}

impl Keeper {
    pub(super) fn start(launch: Launch) -> Keeper {
        let state = Arc::new(KeeperState {
            stopping: AtomicBool::new(false),
            child: Mutex::new(None),
            wake: Condvar::new(),
            first: Mutex::new(None),
            first_known: Condvar::new(),
        });
        let thread = {
            let state = Arc::clone(&state);
            std::thread::spawn(move || {
                keep(&state, &launch);
                // A keeper that ends before it ever decided must not leave anyone waiting.
                state.decide(FirstOutcome::Unstartable);
            })
        };
        Keeper {
            state,
            thread: Some(thread),
        }
    }

    /// Waits until the first start has gone one way or the other.
    pub(super) fn first_outcome(&self) -> FirstOutcome {
        let mut first = lock(&self.state.first);
        loop {
            if let Some(outcome) = *first {
                return outcome;
            }
            first = self
                .state
                .first_known
                .wait(first)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// Stops the server (asking it to stop, then killing it after `STOP_WAIT`) and ends
    /// the thread.
    pub(super) fn stop(mut self) {
        {
            // The flag is raised and the thread woken while the lock is held, so the thread
            // cannot check the flag, miss the wake-up and sleep out its whole wait.
            let _held = lock(&self.state.child);
            self.state.stopping.store(true, Ordering::SeqCst);
            self.state.wake.notify_all();
        }
        let child = lock(&self.state.child).take();
        if let Some(child) = child {
            terminate(child, STOP_WAIT);
        }
        if let Some(thread) = self.thread.take()
            && thread.join().is_err()
        {
            eprintln!("jet: the thread that keeps a server running ended in a panic");
        }
    }
}

/// The keeper's thread: start the server, watch it, and start it again after a pause
/// whenever it dies, until it is told to stop.
// SMELL: the keeper never gives up, so a program that always dies is started again every
// ten seconds for ever.
fn keep(state: &Arc<KeeperState>, launch: &Launch) {
    let mut is_first_run = true;
    let mut failures = 0;
    while !state.stopping.load(Ordering::SeqCst) {
        let started = Instant::now();
        match spawn_http(launch.name, &launch.server, launch.port) {
            Ok(child) => match watch(state, launch, child, is_first_run) {
                AfterExit::StartAgain => {}
                AfterExit::End => return,
            },
            Err(error) if is_first_run => {
                eprintln!("jet: could not start {}: {error}", launch.name);
                state.decide(FirstOutcome::Unstartable);
                return;
            }
            Err(error) => eprintln!("jet: could not start {}: {error}", launch.name),
        }
        is_first_run = false;
        if started.elapsed() > STEADY_AFTER {
            failures = 0;
        }
        let delay = RESTART_DELAYS[failures.min(RESTART_DELAYS.len() - 1)];
        failures += 1;
        eprintln!("jet: starting {} again in {delay:?}", launch.name);
        pause(state, delay);
    }
}

/// Sleeps for `delay`, or less when the keeper is told to stop.
fn pause(state: &KeeperState, delay: Duration) {
    let child = lock(&state.child);
    let waited = state
        .wake
        .wait_timeout_while(child, delay, |_| !state.stopping.load(Ordering::SeqCst));
    drop(waited.unwrap_or_else(PoisonError::into_inner));
}

/// How a check on the running child went.
enum Polled {
    /// `stop` took the child away.
    Taken,
    Running,
    Exited(String),
}

/// What the keeper does once its child has gone.
enum AfterExit {
    StartAgain,
    End,
}

/// Runs one child to its end.
fn watch(
    state: &Arc<KeeperState>,
    launch: &Launch,
    mut child: Child,
    is_first_run: bool,
) -> AfterExit {
    let started = Instant::now();
    if let Some(stderr) = child.stderr.take() {
        let ready = Arc::clone(state);
        let (name, url) = (launch.name, launch.url.clone());
        pass_on_stderr(stderr, format!("listening on {}", launch.url), move || {
            ready.decide(FirstOutcome::Ready);
            eprintln!("jet: {name} is shared at {url}");
        });
    }
    {
        let mut slot = lock(&state.child);
        if state.stopping.load(Ordering::SeqCst) {
            drop(slot);
            terminate(child, STOP_WAIT);
            return AfterExit::End;
        }
        *slot = Some(child);
    }
    loop {
        match poll(state) {
            Polled::Taken => return AfterExit::End,
            Polled::Exited(status) => {
                eprintln!("jet: {} stopped ({status})", launch.name);
                let has_no_http = is_first_run && state.decide(FirstOutcome::Refused);
                return if has_no_http || state.stopping.load(Ordering::SeqCst) {
                    AfterExit::End
                } else {
                    AfterExit::StartAgain
                };
            }
            Polled::Running => {
                if is_first_run && started.elapsed() >= FIRST_WAIT && !state.is_decided() {
                    state.decide(FirstOutcome::Alive);
                }
            }
        }
        std::thread::sleep(EXIT_POLL);
    }
}

/// Checks whether the child has exited. A child that has is taken out in the same step, so
/// `stop` can never signal a process id that has already been given back.
fn poll(state: &KeeperState) -> Polled {
    let mut slot = lock(&state.child);
    let checked = slot.as_mut().map(Child::try_wait);
    match checked {
        None => Polled::Taken,
        Some(Ok(None)) => Polled::Running,
        Some(Ok(Some(status))) => {
            *slot = None;
            Polled::Exited(status.to_string())
        }
        Some(Err(error)) => {
            *slot = None;
            Polled::Exited(format!("its state could not be read: {error}"))
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
