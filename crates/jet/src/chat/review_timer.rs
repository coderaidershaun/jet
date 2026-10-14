//! Keeps Jet's notes current in the background: a timer starts when a reply ends, and runs
//! a review if the chat stays quiet. Closing the app runs one last review.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use agent::{Conversation, ReviewOutcome, Transport};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// A little over the 90 seconds of quiet that the review waits for.
const REVIEW_DELAY: Duration = Duration::from_secs(91);

/// What a review needs: how to reach Claude, and what the assistant is called.
pub struct ReviewTarget {
    pub transport: Arc<dyn Transport>,
    pub name: String,
}

pub struct ReviewTimer {
    /// Raised at each message and each reply end. A timer only fires if nothing newer has
    /// raised it since the timer was set.
    generation: Arc<AtomicU64>,
}

/// The payload of the `memory-updated` event.
#[derive(Clone, Serialize)]
struct MemoryUpdated {
    memory: String,
    user: String,
    recent: String,
}

impl ReviewTimer {
    pub fn new() -> ReviewTimer {
        ReviewTimer {
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Cancels any waiting timer: the user is talking again.
    pub fn note_activity(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    /// Reviews the conversation after a quiet spell, if it is still quiet and a review is due.
    pub fn schedule(&self, app: AppHandle, conversation: Conversation, target: ReviewTarget) {
        let waiting_for = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let generation = Arc::clone(&self.generation);
        std::thread::spawn(move || {
            std::thread::sleep(REVIEW_DELAY);
            let still_quiet = generation.load(Ordering::SeqCst) == waiting_for;
            if still_quiet && conversation.review_due(agent::now_ms()) {
                review(&conversation, &target, |notes| {
                    app.emit("memory-updated", notes).ok();
                });
            }
        });
    }
}

/// Reviews right away, whatever the timing rules say. Used when the app closes.
pub fn review_now(conversation: &Conversation, target: &ReviewTarget) {
    review(conversation, target, |_| {});
}

fn review(
    conversation: &Conversation,
    target: &ReviewTarget,
    on_update: impl FnOnce(MemoryUpdated),
) {
    match conversation.review_notes(&*target.transport, &target.name) {
        Ok(ReviewOutcome::Updated(notes)) => on_update(MemoryUpdated {
            memory: notes.memory,
            user: notes.user,
            recent: notes.recent,
        }),
        Ok(ReviewOutcome::Unchanged | ReviewOutcome::Skipped | ReviewOutcome::Stale) => {}
        Err(error) => eprintln!("jet: the notes review failed: {error}"),
    }
}
