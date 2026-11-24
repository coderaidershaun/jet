//! Start the notes review after a chat has been quiet, without tying provider work to a browser
//! connection. Each chat has its own timer; the review it starts reads all of its user's chats.

use super::ChatState;
use agent::Transport;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;

/// How long past the quiet wait the timer fires, so the review is due by then.
const MARGIN: Duration = Duration::from_millis(500);

pub(super) struct ReviewTarget {
    pub transport: Arc<dyn Transport>,
    pub name: String,
}

pub(super) struct ReviewTimer {
    generation: Arc<AtomicU64>,
}

impl ReviewTimer {
    pub fn new() -> Self {
        Self {
            generation: Arc::new(AtomicU64::new(0)),
        }
    }
    pub fn note_activity(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
    pub fn schedule(&self, host: Arc<ChatState>, target: ReviewTarget) {
        let waiting = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let generation = self.generation.clone();
        std::thread::spawn(move || {
            std::thread::sleep(host.review_quiet + MARGIN);
            if generation.load(Ordering::SeqCst) != waiting {
                return;
            }
            if let Some(hub) = host.hub.upgrade() {
                hub.review(&host, &*target.transport, &target.name);
            }
        });
    }
}
