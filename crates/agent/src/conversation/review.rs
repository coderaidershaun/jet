//! Keeps the three notes current. Once the conversation has been quiet for a while, one
//! cheap model call reads everything said since the last review and rewrites the notes.

use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use super::memory::{MemoryError, Session, now_ms};
use super::persona::{fill, note_or_empty};
use super::{Claim, Conversation};
use crate::chat::{Effort, Entry, MEMORY_LIMIT, Notes, RECENT_LIMIT, Role, USER_LIMIT};
use crate::turn::{Request, SessionMode, Step, Summary, Transport, Turn, TurnError};

const PROMPT: &str = include_str!("review.md");

/// How long the chat must be quiet before a review is due, unless the host sets its own wait.
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
        if let Some(stopper) = crate::lock(&self.review_stop).as_ref() {
            stopper.stop();
        }
    }

    /// Whether it is time for a review: something new was said, the chat has been quiet for
    /// `quiet`, and the last review was at least ten minutes ago.
    pub fn review_due(&self, now_ms: u64, quiet: Duration) -> bool {
        self.pending_since_last_review()
            .ok()
            .flatten()
            .is_some_and(|(session, pending)| {
                let last_said = pending.last().map_or(0, |entry| entry.at);
                Duration::from_millis(now_ms.saturating_sub(last_said)) >= quiet
                    && now_ms.saturating_sub(session.reviewed_at) >= MIN_GAP_BETWEEN_REVIEWS_MS
            })
    }

    /// The session and the entries with text that the review has not read yet, or `None`
    /// when there is no session or nothing new.
    fn pending_since_last_review(&self) -> Result<Option<(Session, Vec<Entry>)>, MemoryError> {
        let Some(session) = self.saved.session()? else {
            return Ok(None);
        };
        let mut pending = self.saved.after(session.reviewed_through)?;
        pending.retain(|entry| !entry.text.trim().is_empty());
        Ok((!pending.is_empty()).then_some((session, pending)))
    }
}

/// One chat whose new entries a review reads. The title tells the notes where a topic came from.
pub struct ReviewedChat<'a> {
    pub title: &'a str,
    pub conversation: &'a Conversation,
}

/// What a review read from one chat: the entries it had not read yet.
struct Source<'a> {
    chat: &'a ReviewedChat<'a>,
    pending: Vec<Entry>,
}

/// Reads what was said since the last review in every one of `chats` and updates the notes they
/// share, which are saved through the first chat. Each chat keeps its own mark of how far it was
/// read. The caller sees to it that no two reviews of the same notes run at once.
pub fn review_chats(
    transport: &dyn Transport,
    name: &str,
    chats: &[ReviewedChat],
) -> Result<ReviewOutcome, ReviewError> {
    let Some(lead) = chats.first().map(|chat| chat.conversation) else {
        return Ok(ReviewOutcome::Skipped);
    };
    let Some(_claim) = Claim::take(&lead.reviewing) else {
        return Ok(ReviewOutcome::Skipped);
    };
    let mut sources = Vec::new();
    for chat in chats {
        if let Some((_, pending)) = chat.conversation.pending_since_last_review()? {
            sources.push(Source { chat, pending });
        }
    }
    if sources.is_empty() {
        return Ok(ReviewOutcome::Skipped);
    }
    let before = lead.saved.notes()?;
    let request = Request {
        prompt: review_prompt(&before, &sources, name),
        system_prompt: system_prompt(name),
        model: transport.review_model(),
        effort: Effort::Low,
        budget_usd: BUDGET_USD,
        session: SessionMode::Ephemeral,
        schema: Some(schema()),
        mcp: None,
        hosts: Vec::new(),
    };
    let turn = {
        let mut current = crate::lock(&lead.review_stop);
        if lead.shutting_down.load(Ordering::SeqCst) {
            return Ok(ReviewOutcome::Skipped);
        }
        let turn = Turn::start_with_idle(transport, &request, IDLE_LIMIT)?;
        *current = Some(turn.stopper());
        turn
    };
    let result = run(turn);
    *crate::lock(&lead.review_stop) = None;
    let verdict = read_verdict(result?)?;

    // A thread forgotten meanwhile starts again at id 1, so it must not be marked as read.
    let mut marks = Vec::new();
    for source in &sources {
        let saved = &source.chat.conversation.saved;
        let Some(session) = saved.session()? else {
            return Ok(ReviewOutcome::Stale);
        };
        let thread = saved.entries()?;
        let Some(last_read) = source.pending.last().filter(|last| thread.contains(last)) else {
            return Ok(ReviewOutcome::Stale);
        };
        marks.push((session, last_read.id));
    }
    if lead.saved.notes()? != before {
        return Ok(ReviewOutcome::Stale);
    }
    let outcome = if verdict.changed {
        ReviewOutcome::Updated(lead.saved.save_notes(&verdict.notes)?)
    } else {
        ReviewOutcome::Unchanged
    };
    for (source, (mut session, last_read)) in sources.iter().zip(marks) {
        session.reviewed_through = last_read;
        session.reviewed_at = now_ms();
        source.chat.conversation.saved.save_session(&session)?;
    }
    Ok(outcome)
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

fn review_prompt(notes: &Notes, sources: &[Source], name: &str) -> String {
    format!(
        "<memory>{}</memory>\n<user>{}</user>\n<recent>{}</recent>\n<exchange>\n{}\n</exchange>",
        note_or_empty(&notes.memory),
        note_or_empty(&notes.user),
        note_or_empty(&notes.recent),
        exchange(sources, name),
    )
}

/// One line per message. When the text is too long the oldest lines of all the chats go first.
/// Each chat's lines come under a line with the chat's title.
fn exchange(sources: &[Source], name: &str) -> String {
    let mut lines: Vec<(u64, usize, String)> = sources
        .iter()
        .enumerate()
        .flat_map(|(at, source)| {
            source.pending.iter().map(move |entry| {
                let speaker = match entry.role {
                    Role::User => "user",
                    Role::Jet => name,
                };
                (entry.at, at, format!("{speaker}: {}", entry.text.trim()))
            })
        })
        .collect();
    lines.sort_by_key(|(at, _, _)| *at);
    let length = |lines: &[(u64, usize, String)]| {
        lines
            .iter()
            .map(|(_, _, line)| line.chars().count() + 1)
            .sum::<usize>()
    };
    while lines.len() > 1 && length(&lines) > EXCHANGE_LIMIT {
        lines.remove(0);
    }
    let mut text = String::new();
    for (index, source) in sources.iter().enumerate() {
        let mut kept = lines
            .iter()
            .filter(|(_, chat, _)| *chat == index)
            .peekable();
        if kept.peek().is_some() && !source.chat.title.is_empty() {
            text.push_str(&format!("[chat: {}]\n", source.chat.title));
        }
        for (_, _, line) in kept {
            text.push_str(line);
            text.push('\n');
        }
    }
    text.trim_end().chars().take(EXCHANGE_LIMIT).collect()
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
    use super::super::memory::{InMemory, NewEntry, Storage};
    use super::super::test_support::Chat;
    use super::*;
    use crate::chat::{EntryId, Model, SessionId};
    use crate::turn::scripted::{Script, Scripted, structured_result_line};
    use std::sync::Arc;

    fn jet_says(text: &str) -> NewEntry {
        NewEntry {
            turn: None,
            role: Role::Jet,
            ..NewEntry::user_text(text)
        }
    }

    /// A thread of four entries with the first two already reviewed.
    fn reviewed_thread(storage: &InMemory, said_at: u64) {
        for entry in [
            NewEntry::user_text("I am Sam"),
            jet_says("Hi Sam"),
            NewEntry::user_text("I just shipped my first app"),
            jet_says("Congratulations!"),
        ] {
            storage.add_entry(entry, said_at).unwrap();
        }
        let session = Session {
            session_id: SessionId("s1".into()),
            reviewed_through: EntryId(2),
            ..Session::default()
        };
        storage.save_session(Some(&session)).unwrap();
        let notes = Notes {
            memory: "- old fact".into(),
            ..Notes::default()
        };
        storage.save_notes(&notes).unwrap();
    }

    fn review_one(chat: &Chat) -> Result<ReviewOutcome, ReviewError> {
        let only = ReviewedChat {
            title: "",
            conversation: &chat.conversation,
        };
        review_chats(&*chat.transport(), "Jet", &[only])
    }

    fn verdict(changed: bool, memory: &str) -> Script {
        let output = json!({"changed": changed, "memory": memory, "user": "- Sam", "recent": "- app launch"});
        Script::lines(vec![structured_result_line(&output)])
    }

    #[test]
    fn review_covers_entries_since_last_review_and_updates_recent() {
        let chat =
            Chat::with_transport(Scripted::new().then(verdict(true, "- old fact\n- shipped app")));
        let said_at = 1_000_000;
        let due_after = |after_ms: u64| {
            chat.conversation
                .review_due(said_at + after_ms, REVIEW_QUIET)
        };
        assert!(!due_after(10_000_000), "no thread yet");
        reviewed_thread(&chat.storage, said_at);

        assert!(!due_after(89_999), "still typing");
        assert!(due_after(90_000));
        assert!(
            chat.conversation
                .review_due(said_at + 5_000, Duration::from_secs(5)),
            "the host may set a shorter wait"
        );
        chat.edit_session(|session| session.reviewed_at = said_at + 100_000);
        assert!(!due_after(100_000 + 599_999), "reviewed too recently");
        assert!(due_after(100_000 + 600_000));
        chat.edit_session(|session| session.reviewed_at = 0);

        let outcome = review_one(&chat).unwrap();
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
        assert!(request.prompt.contains("I just shipped my first app"));
        assert!(!request.prompt.contains("I am Sam"), "already reviewed");

        let session = chat.saved_session();
        assert_eq!(session.reviewed_through, EntryId(4));
        assert!(session.reviewed_at > 0);
        assert!(!due_after(100_000_000), "nothing new to read");
        assert_eq!(
            review_one(&chat).unwrap(),
            ReviewOutcome::Skipped,
            "nothing new to read"
        );
    }

    /// Reviews the thread of `reviewed_thread` while `meanwhile` changes the saved chat.
    fn review_while(meanwhile: impl Fn(&Arc<InMemory>) + Send + Sync + 'static) -> Chat {
        let storage = Arc::new(InMemory::default());
        let scripted = Scripted::new()
            .then(verdict(true, "- from the review"))
            .before_start({
                let storage = storage.clone();
                move || meanwhile(&storage)
            });
        let chat = Chat::in_storage(storage, scripted);
        reviewed_thread(&chat.storage, 1000);
        let outcome = review_one(&chat);
        assert_eq!(outcome.unwrap(), ReviewOutcome::Stale);
        chat
    }

    #[test]
    fn review_is_discarded_when_notes_changed_meanwhile() {
        let chat = review_while(|storage| {
            let typed = Notes {
                memory: "- typed by the user".into(),
                ..Notes::default()
            };
            storage.save_notes(&typed).unwrap();
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

        // A thread forgotten and begun again meanwhile has none of the read entries, so none of
        // it counts as read.
        let chat = review_while(|storage| {
            Conversation::new(storage.clone()).forget().unwrap();
            storage
                .add_entry(NewEntry::user_text("hello again"), 5)
                .unwrap();
            let fresh = Session {
                session_id: SessionId("s2".into()),
                ..Session::default()
            };
            storage.save_session(Some(&fresh)).unwrap();
        });
        assert_eq!(chat.saved_session().reviewed_through, EntryId(0));
    }

    #[test]
    fn one_review_reads_every_chat_and_marks_each_one() {
        let (kites, boats) = (Arc::new(InMemory::default()), Arc::new(InMemory::default()));
        for (storage, said) in [(&kites, "kites fly"), (&boats, "boats float")] {
            storage.add_entry(NewEntry::user_text(said), 1000).unwrap();
            let session = Session {
                session_id: SessionId("s".into()),
                ..Session::default()
            };
            storage.save_session(Some(&session)).unwrap();
        }
        let scripted = Arc::new(Scripted::new().then(verdict(true, "- both")));
        let (first, second) = (
            Conversation::new(kites.clone()),
            Conversation::new(boats.clone()),
        );
        let chats = [
            ReviewedChat {
                title: "Kites",
                conversation: &first,
            },
            ReviewedChat {
                title: "Boats",
                conversation: &second,
            },
        ];
        let outcome = review_chats(&*scripted, "Jet", &chats).unwrap();
        assert!(matches!(outcome, ReviewOutcome::Updated(_)));
        let prompt = &scripted.requests()[0].prompt;
        assert!(
            prompt.contains("[chat: Kites]\nuser: kites fly"),
            "{prompt}"
        );
        assert!(
            prompt.contains("[chat: Boats]\nuser: boats float"),
            "{prompt}"
        );
        for storage in [&kites, &boats] {
            assert_eq!(
                storage.session().unwrap().unwrap().reviewed_through,
                EntryId(1)
            );
        }
        assert_eq!(
            review_chats(&*scripted, "Jet", &chats).unwrap(),
            ReviewOutcome::Skipped,
            "no entry is read twice"
        );
    }

    #[test]
    fn a_long_chat_does_not_push_out_the_newest_lines_of_a_quiet_one() {
        let (long, quiet) = (Arc::new(InMemory::default()), Arc::new(InMemory::default()));
        for at in 1..=70 {
            long.add_entry(NewEntry::user_text(&"x".repeat(100)), at)
                .unwrap();
        }
        quiet
            .add_entry(NewEntry::user_text("the newest talk"), 1000)
            .unwrap();
        let (long, quiet) = (Conversation::new(long), Conversation::new(quiet));
        let chats = [
            ReviewedChat {
                title: "Long",
                conversation: &long,
            },
            ReviewedChat {
                title: "Quiet",
                conversation: &quiet,
            },
        ];
        let sources = chats.each_ref().map(|chat| Source {
            chat,
            pending: chat.conversation.saved.entries().unwrap(),
        });
        let text = exchange(&sources, "Jet");
        assert!(
            text.contains("[chat: Quiet]\nuser: the newest talk"),
            "{text}"
        );
    }
}
