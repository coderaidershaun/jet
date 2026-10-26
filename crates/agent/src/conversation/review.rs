//! Keeps the three notes current. Once the conversation has been quiet for a while, one
//! cheap model call reads everything said since the last review and rewrites the notes.

use std::sync::{MutexGuard, PoisonError, atomic::Ordering};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use super::memory::{MemoryError, Session, Transcript, now_ms};
use super::persona::{fill, note_or_empty};
use super::{Claim, Conversation};
use crate::chat::{Effort, Entry, MEMORY_LIMIT, Notes, RECENT_LIMIT, Role, USER_LIMIT};
use crate::turn::{Request, SessionMode, Step, Stopper, Summary, Transport, Turn, TurnError};

const PROMPT: &str = include_str!("review.md");

/// How long the chat must be quiet before a review is due.
pub const REVIEW_QUIET: Duration = Duration::from_secs(90);

/// Two reviews are at least this far apart.
const MIN_GAP_BETWEEN_REVIEWS_MS: u64 = 10 * 60 * 1000;

/// The most conversation text sent for one review, in characters. Older text is dropped.
const EXCHANGE_LIMIT: usize = 6000;

const BUDGET_USD: f64 = 0.20;

/// The review is short; a longer silence than this means it is stuck.
const IDLE_LIMIT: Duration = Duration::from_secs(60);

/// What a review did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReviewOutcome {
    /// The notes were rewritten.
    Updated(Notes),
    /// The model read the new messages and kept the notes as they were.
    Unchanged,
    /// Another review is running, or there was nothing new to read.
    Skipped,
    /// The notes changed, or the thread was forgotten, while the model was reading, so its
    /// answer was thrown away.
    Stale,
}

#[derive(Debug, thiserror::Error)]
pub enum ReviewError {
    #[error(transparent)]
    Turn(#[from] TurnError),
    #[error("the review returned no notes: {result}")]
    NoNotes { result: String },
    #[error("the review returned notes in the wrong shape: {source}")]
    Shape {
        #[source]
        source: serde_json::Error,
    },
    #[error(transparent)]
    Memory(#[from] MemoryError),
}

#[derive(Deserialize)]
struct Verdict {
    changed: bool,
    #[serde(flatten)]
    notes: Notes,
}

impl Conversation {
    /// Prevents future reviews and cancels any provider review already running.
    pub fn stop_review(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        if let Some(stopper) = self.lock_review_stop().as_ref() {
            stopper.stop();
        }
    }

    /// Whether it is time for a review: something new was said, the chat has been quiet
    /// for 90 seconds, and the last review was at least ten minutes ago.
    pub fn review_due(&self, now_ms: u64) -> bool {
        self.pending_since_last_review()
            .ok()
            .flatten()
            .is_some_and(|(session, pending)| {
                let last_said = pending.last().map_or(0, |entry| entry.at);
                Duration::from_millis(now_ms.saturating_sub(last_said)) >= REVIEW_QUIET
                    && now_ms.saturating_sub(session.reviewed_at) >= MIN_GAP_BETWEEN_REVIEWS_MS
            })
    }

    /// Reads what was said since the last review and updates the notes. `name` is what
    /// the assistant is called.
    pub fn review_notes(
        &self,
        transport: &dyn Transport,
        name: &str,
    ) -> Result<ReviewOutcome, ReviewError> {
        let Some(_claim) = Claim::take(&self.reviewing) else {
            return Ok(ReviewOutcome::Skipped);
        };
        let Some((_, pending)) = self.pending_since_last_review()? else {
            return Ok(ReviewOutcome::Skipped);
        };
        let before = Notes::load(&self.dir)?;
        let request = Request {
            prompt: review_prompt(&before, &pending, name),
            system_prompt: system_prompt(name),
            model: transport.review_model(),
            effort: Effort::Low,
            budget_usd: BUDGET_USD,
            session: SessionMode::Ephemeral,
            schema: Some(schema()),
            mcp: None,
        };
        let turn = {
            let mut current = self.lock_review_stop();
            if self.shutting_down.load(Ordering::SeqCst) {
                return Ok(ReviewOutcome::Skipped);
            }
            let turn = Turn::start_with_idle(transport, &request, IDLE_LIMIT)?;
            *current = Some(turn.stopper());
            turn
        };
        let result = run(turn);
        *self.lock_review_stop() = None;
        let summary = result?;
        let verdict = read_verdict(summary)?;

        let Some(mut session) = Session::load(&self.dir)? else {
            return Ok(ReviewOutcome::Stale);
        };
        // A thread forgotten meanwhile starts again at id 1, so it must not be marked as read.
        let thread = Transcript::open(&self.dir).entries()?;
        let Some(last_read) = pending.last().filter(|last| thread.contains(last)) else {
            return Ok(ReviewOutcome::Stale);
        };
        if Notes::load(&self.dir)? != before {
            return Ok(ReviewOutcome::Stale);
        }
        let outcome = if verdict.changed {
            ReviewOutcome::Updated(verdict.notes.save(&self.dir)?)
        } else {
            ReviewOutcome::Unchanged
        };
        session.reviewed_through = last_read.id;
        session.reviewed_at = now_ms();
        session.save(&self.dir)?;
        Ok(outcome)
    }

    /// A lock that a panic poisoned is still usable: it only holds a stopper.
    fn lock_review_stop(&self) -> MutexGuard<'_, Option<Stopper>> {
        self.review_stop
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// The session and the entries with text that the review has not read yet, or `None`
    /// when there is no session or nothing new.
    fn pending_since_last_review(&self) -> Result<Option<(Session, Vec<Entry>)>, MemoryError> {
        let Some(session) = Session::load(&self.dir)? else {
            return Ok(None);
        };
        let mut pending = Transcript::open(&self.dir).after(session.reviewed_through)?;
        pending.retain(|entry| !entry.text.trim().is_empty());
        Ok((!pending.is_empty()).then_some((session, pending)))
    }
}

fn system_prompt(name: &str) -> String {
    let [memory, user, recent] = [MEMORY_LIMIT, USER_LIMIT, RECENT_LIMIT].map(|n| n.to_string());
    let values = [
        ("name", name),
        ("memory_limit", &memory),
        ("user_limit", &user),
        ("recent_limit", &recent),
    ];
    fill(PROMPT, &values)
}

fn run(turn: Turn) -> Result<Summary, ReviewError> {
    match turn.last() {
        Some(Step::Finished(summary)) => Ok(summary),
        Some(Step::Failed(error)) => Err(error.into()),
        _ => Err(TurnError::NoResult.into()),
    }
}

/// The notes come back as structured output, or, failing that, as JSON text.
fn read_verdict(summary: Summary) -> Result<Verdict, ReviewError> {
    let value = match summary.structured_output {
        Some(value) => value,
        None => {
            let text = summary.result.trim();
            let json = text
                .strip_prefix("```json")
                .or_else(|| text.strip_prefix("```"))
                .and_then(|inner| inner.trim().strip_suffix("```"))
                .unwrap_or(text);
            serde_json::from_str::<Value>(json.trim()).map_err(|_| ReviewError::NoNotes {
                result: summary.result.clone(),
            })?
        }
    };
    serde_json::from_value(value).map_err(|source| ReviewError::Shape { source })
}

fn review_prompt(notes: &Notes, pending: &[Entry], name: &str) -> String {
    format!(
        "<memory>{}</memory>\n<user>{}</user>\n<recent>{}</recent>\n<exchange>\n{}\n</exchange>",
        note_or_empty(&notes.memory),
        note_or_empty(&notes.user),
        note_or_empty(&notes.recent),
        exchange(pending, name),
    )
}

/// One line per message, newest messages kept first when the text is too long.
fn exchange(pending: &[Entry], name: &str) -> String {
    let mut lines: Vec<String> = pending
        .iter()
        .map(|entry| {
            let speaker = match entry.role {
                Role::User => "user",
                Role::Jet => name,
            };
            format!("{speaker}: {}", entry.text.trim())
        })
        .collect();
    let length = |lines: &[String]| {
        lines
            .iter()
            .map(|line| line.chars().count() + 1)
            .sum::<usize>()
    };
    while lines.len() > 1 && length(&lines) > EXCHANGE_LIMIT {
        lines.remove(0);
    }
    let text = lines.join("\n");
    text.chars().take(EXCHANGE_LIMIT).collect()
}

fn schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["changed", "memory", "user", "recent"],
        "properties": {
            "changed": {"type": "boolean"},
            "memory": {"type": "string", "maxLength": MEMORY_LIMIT},
            "user": {"type": "string", "maxLength": USER_LIMIT},
            "recent": {"type": "string", "maxLength": RECENT_LIMIT}
        }
    })
}

#[cfg(test)]
mod tests {
    use super::super::memory::{DataDir, NewEntry};
    use super::super::test_support::Chat;
    use super::*;
    use crate::chat::{EntryId, Model, SessionId};
    use crate::turn::scripted::{Script, Scripted, structured_result_line};

    fn jet_says(text: &str) -> NewEntry {
        NewEntry {
            turn: None,
            role: Role::Jet,
            ..NewEntry::user(text)
        }
    }

    /// A thread of four entries with the first two already reviewed.
    fn reviewed_thread(chat: &Chat, said_at: u64) {
        let transcript = Transcript::open(&chat.dir);
        for entry in [
            NewEntry::user("I am Sam"),
            jet_says("Hi Sam"),
            NewEntry::user("I just shipped my first app"),
            jet_says("Congratulations!"),
        ] {
            transcript.append(entry, said_at).unwrap();
        }
        Session {
            session_id: SessionId("s1".into()),
            reviewed_through: EntryId(2),
            ..Session::default()
        }
        .save(&chat.dir)
        .unwrap();
        Notes {
            memory: "- old fact".into(),
            ..Notes::default()
        }
        .save(&chat.dir)
        .unwrap();
    }

    fn verdict(changed: bool, memory: &str) -> Script {
        let output = json!({"changed": changed, "memory": memory, "user": "- Sam", "recent": "- app launch"});
        Script::lines(vec![structured_result_line(&output)])
    }

    #[test]
    fn review_covers_entries_since_last_review_and_updates_recent() {
        let chat = Chat::with_transport(
            "review-batch",
            Scripted::new().then(verdict(true, "- old fact\n- shipped app")),
        );
        reviewed_thread(&chat, 1000);

        let outcome = chat
            .conversation
            .review_notes(&*chat.transport(), "Jet")
            .unwrap();
        let expected = Notes {
            memory: "- old fact\n- shipped app".into(),
            user: "- Sam".into(),
            recent: "- app launch".into(),
        };
        assert_eq!(outcome, ReviewOutcome::Updated(expected.clone()));
        assert_eq!(chat.conversation.notes().unwrap(), expected);

        let request = &chat.requests()[0];
        assert_eq!(request.session, SessionMode::Ephemeral);
        assert_eq!(request.model, Model::Haiku);
        assert_eq!(request.schema, Some(schema()));
        assert!(request.system_prompt.contains("called Jet"));
        assert!(
            request
                .system_prompt
                .contains("Never infer anything from file paths, folder names or other metadata"),
            "a name read from a home folder path must not reach the notes"
        );
        assert!(request.prompt.contains("<memory>- old fact</memory>"));
        assert!(request.prompt.contains("<recent>(empty)</recent>"));
        assert!(
            request
                .prompt
                .contains("user: I just shipped my first app\nJet: Congratulations!")
        );
        assert!(!request.prompt.contains("I am Sam"), "already reviewed");

        let session = chat.saved_session();
        assert_eq!(session.reviewed_through, EntryId(4));
        assert!(session.reviewed_at > 0);
        assert_eq!(
            chat.conversation
                .review_notes(&*chat.transport(), "Jet")
                .unwrap(),
            ReviewOutcome::Skipped,
            "nothing new to read"
        );
    }

    /// Reviews the thread of `reviewed_thread` while `meanwhile` changes the data folder.
    fn review_while(name: &str, meanwhile: impl Fn(&DataDir) + Send + Sync + 'static) -> Chat {
        let dir = DataDir::scratch(name);
        let scripted = Scripted::new()
            .then(verdict(true, "- from the review"))
            .before_start({
                let dir = dir.clone();
                move || meanwhile(&dir)
            });
        let chat = Chat::in_dir(dir, scripted);
        reviewed_thread(&chat, 1000);
        let outcome = chat.conversation.review_notes(&*chat.transport(), "Jet");
        assert_eq!(outcome.unwrap(), ReviewOutcome::Stale);
        chat
    }

    #[test]
    fn review_is_discarded_when_notes_changed_meanwhile() {
        let chat = review_while("review-stale", |dir| {
            Notes {
                memory: "- typed by the user".into(),
                ..Notes::default()
            }
            .save(dir)
            .unwrap();
        });
        assert_eq!(
            chat.conversation.notes().unwrap().memory,
            "- typed by the user"
        );
        assert_eq!(
            chat.saved_session().reviewed_through,
            EntryId(2),
            "no progress"
        );

        // A thread forgotten and begun again meanwhile restarts its ids at 1, so none of it
        // counts as read.
        let chat = review_while("review-forgotten", |dir| {
            Conversation::new(dir.clone()).forget().unwrap();
            Transcript::open(dir)
                .append(NewEntry::user("hello again"), 5)
                .unwrap();
            let fresh = Session {
                session_id: SessionId("s2".into()),
                ..Session::default()
            };
            fresh.save(dir).unwrap();
        });
        assert_eq!(chat.saved_session().reviewed_through, EntryId(0));
    }

    #[test]
    fn review_due_obeys_debounce_and_minimum_gap() {
        let chat = Chat::new("review-due", [] as [&str; 0]);
        let said_at = 1_000_000;
        assert!(
            !chat.conversation.review_due(said_at + 10_000_000),
            "no thread yet"
        );
        reviewed_thread(&chat, said_at);

        assert!(
            !chat.conversation.review_due(said_at + 89_999),
            "still typing"
        );
        assert!(chat.conversation.review_due(said_at + 90_000));

        chat.edit_session(|session| session.reviewed_at = said_at + 100_000);
        assert!(
            !chat.conversation.review_due(said_at + 100_000 + 599_999),
            "reviewed too recently"
        );
        assert!(chat.conversation.review_due(said_at + 100_000 + 600_000));

        chat.edit_session(|session| session.reviewed_through = EntryId(4));
        assert!(
            !chat.conversation.review_due(said_at + 100_000_000),
            "nothing new"
        );
    }
}
