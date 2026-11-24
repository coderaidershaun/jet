//! Wakes Jet when an agent-task it set for itself falls due. One thread sleeps until the earliest
//! due task, wakes early when a task changes, and runs one check at a time, the task that fell due
//! first before the others.

mod brief;
mod check;

use crate::chat::Chats;
use crate::facade::Facade;
use crate::lock;
use crate::objectives::{Clock, Objectives};
use crate::store::{AgentTask, ChatId, Store, StoreError};
use agent::Stopper;
use std::collections::HashSet;
use std::sync::{
    Arc, Condvar, Mutex, PoisonError, Weak,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

/// The longest the scheduler sleeps when no task is due sooner.
const LONGEST_SLEEP: Duration = Duration::from_secs(60);

/// What tells the scheduler that something changed, and what lets a user's message stop the check
/// that runs in the same chat.
#[derive(Clone, Default)]
pub(crate) struct Signals(Arc<Shared>);

#[derive(Default)]
struct Shared {
    changed: Mutex<bool>,
    wake: Condvar,
    running: Mutex<Option<Running>>,
    /// The chats in which the user wrote and the reply has not ended.
    writing: Mutex<HashSet<ChatId>>,
}

/// The check that runs now.
struct Running {
    chat: ChatId,
    stopper: Option<Stopper>,
    preempted: bool,
}

impl Signals {
    /// A task changed, or a reply ended: the scheduler looks again at once.
    pub(crate) fn changed(&self) {
        *lock(&self.0.changed) = true;
        self.0.wake.notify_all();
    }

    /// The user wrote in `chat`. A check that runs there stops, and runs again later, and no check
    /// of that chat starts until `reply_ended`.
    pub(crate) fn user_wrote(&self, chat: ChatId) {
        let mut running = lock(&self.0.running);
        lock(&self.0.writing).insert(chat);
        if let Some(running) = running.as_mut()
            && running.chat == chat
        {
            running.preempted = true;
            if let Some(stopper) = &running.stopper {
                stopper.stop();
            }
        }
    }

    /// The reply to the user's message in `chat` ended, or never started.
    pub(crate) fn reply_ended(&self, chat: ChatId) {
        lock(&self.0.writing).remove(&chat);
        self.changed();
    }

    fn wait(&self, longest: Duration) {
        let mut changed = lock(&self.0.changed);
        if !*changed {
            changed = self
                .0
                .wake
                .wait_timeout(changed, longest)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        *changed = false;
    }

    /// A check is about to claim a task of `chat`. `false` when the user is writing there.
    fn begin(&self, chat: ChatId) -> bool {
        if lock(&self.0.writing).contains(&chat) {
            return false;
        }
        *lock(&self.0.running) = Some(Running {
            chat,
            stopper: None,
            preempted: false,
        });
        true
    }

    /// The check's turn has started. A user's message that came before it stops the turn now.
    fn attach(&self, stopper: Stopper) {
        if let Some(running) = lock(&self.0.running).as_mut() {
            if running.preempted {
                stopper.stop();
            }
            running.stopper = Some(stopper);
        }
    }

    fn end(&self) {
        lock(&self.0.running).take();
    }
}

/// What the scheduler needs to run a check.
pub(crate) struct Scheduler {
    store: Store,
    clock: Clock,
    objectives: Objectives,
    chats: Weak<Chats>,
    facade: Arc<Facade>,
    signals: Signals,
    /// How often the scheduler looks again while it sleeps. A test sets a short one, because its
    /// clock moves without a real wait.
    poll: Duration,
    /// How long a check may run on a provider that has no money limit.
    time_limit: Duration,
    stopping: AtomicBool,
}

/// Why the scheduler stopped looking for work.
#[derive(Debug, thiserror::Error)]
#[error(
    "checks are paused: the database cannot be written, so no task is claimed (failed with: {}); restart Jet after the database is fixed",
    reason(.0)
)]
struct Paused(StoreError);

/// The error and what caused it, in one line.
fn reason(error: &StoreError) -> String {
    let mut text = error.to_string();
    let mut cause = std::error::Error::source(error);
    while let Some(next) = cause {
        text.push_str(&format!(": {next}"));
        cause = next.source();
    }
    text
}

impl Scheduler {
    pub(crate) fn new(
        store: Store,
        objectives: Objectives,
        chats: &Arc<Chats>,
        facade: Arc<Facade>,
        signals: Signals,
        test_clock: bool,
    ) -> Arc<Self> {
        let test = |millis: u64, real: Duration| {
            if test_clock {
                Duration::from_millis(millis)
            } else {
                real
            }
        };
        Arc::new(Self {
            store,
            clock: {
                let objectives = objectives.clone();
                Arc::new(move || objectives.now())
            },
            objectives,
            chats: Arc::downgrade(chats),
            facade,
            signals,
            poll: test(20, LONGEST_SLEEP),
            time_limit: test(
                std::env::var("JET_TEST_CHECK_LIMIT_MS")
                    .ok()
                    .and_then(|text| text.parse().ok())
                    .unwrap_or(agent::CHECK_TIME_LIMIT.as_millis() as u64),
                agent::CHECK_TIME_LIMIT,
            ),
            stopping: AtomicBool::new(false),
        })
    }

    /// Runs the scheduler on a thread of its own until `stop`.
    pub(crate) fn start(self: &Arc<Self>) {
        let scheduler = self.clone();
        std::thread::spawn(move || {
            if let Err(error) = scheduler.run() {
                eprintln!("jet: {error}");
            }
        });
    }

    pub(crate) fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.signals.changed();
        if let Some(running) = lock(&self.signals.0.running).as_ref()
            && let Some(stopper) = &running.stopper
        {
            stopper.stop();
        }
    }

    fn run(&self) -> Result<(), Paused> {
        self.recover().map_err(Paused)?;
        while !self.stopping.load(Ordering::SeqCst) {
            let now = (self.clock)();
            let ran = self.run_oldest_due(now).map_err(Paused)?;
            if !ran {
                self.signals.wait(self.sleep(now).map_err(Paused)?);
            }
        }
        Ok(())
    }

    /// How long to sleep: until the first task falls due, at most a minute.
    fn sleep(&self, now: u64) -> Result<Duration, StoreError> {
        let until_due = self.store.next_due(now)?.map_or(LONGEST_SLEEP, |due| {
            Duration::from_secs(due.saturating_sub(now))
        });
        Ok(until_due.min(self.poll).max(Duration::from_millis(1)))
    }

    /// Runs the due task that fell due first and whose chat is not answering the user. `false`
    /// when there was none.
    fn run_oldest_due(&self, now: u64) -> Result<bool, StoreError> {
        for task in self.store.due_tasks(now)? {
            if self.replying_in(&task) || !self.signals.begin(task.chat_id) {
                continue;
            }
            let ran = match self.store.claim_task(task.id, now) {
                // The claim raised the task's version; the check is held to the new one.
                Ok(Some(run)) => match self.store.task(task.id)? {
                    Some(claimed) => self.check(&claimed, run, now),
                    None => Ok(()),
                },
                Ok(None) => Ok(()),
                Err(error) if error.is_busy() => Ok(()),
                Err(error) => Err(error),
            };
            self.signals.end();
            ran?;
            return Ok(true);
        }
        Ok(false)
    }

    /// Whether the user's chat of the task is answering a message.
    fn replying_in(&self, task: &AgentTask) -> bool {
        self.chats
            .upgrade()
            .and_then(|chats| chats.open_chat(task.chat_id))
            .is_some_and(|chat| chat.is_replying())
    }
}
