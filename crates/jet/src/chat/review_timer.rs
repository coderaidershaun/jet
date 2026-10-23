//! Review notes after quiet periods without tying provider work to a browser connection.

use super::ChatState;
use agent::{ReviewOutcome, Transport};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;

const REVIEW_DELAY: Duration = Duration::from_secs(91);

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
            std::thread::sleep(REVIEW_DELAY);
            if generation.load(Ordering::SeqCst) != waiting
                || !host.conversation.review_due(agent::now_ms())
            {
                return;
            }
            match host
                .conversation
                .review_notes(&*target.transport, &target.name)
            {
                Ok(ReviewOutcome::Updated(notes)) => host.memory_updated(notes),
                Ok(_) => {}
                Err(error) => eprintln!("jet: notes review failed: {error}"),
            }
        });
    }
}
