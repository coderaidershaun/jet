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

/// Two reviews of one user are at least this far apart, unless the host sets its own gap.
pub const REVIEW_GAP: Duration = Duration::from_secs(10 * 60);

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

/// A promise of Jet, found in one of its own lines, to come back to something.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Promise {
    /// Which of the reviewed chats Jet said it in, as an index into the list given to the review.
    pub chat: usize,
    /// When Jet said it, in milliseconds.
    pub said_at: u64,
    /// Jet's words, with the white space squeezed to single spaces.
    pub words: String,
    /// The local time `YYYY-MM-DDTHH:MM` that Jet named, if it named one.
    pub at: Option<String>,
}

/// What a review did and the promises it found. The promises count only when the review's
/// notes and read marks were committed; a discarded review gives none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Review {
    pub outcome: ReviewOutcome,
    pub promises: Vec<Promise>,
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
    #[serde(default)]
    promises: Vec<Said>,
    #[serde(flatten)]
    notes: Notes,
}

/// A promise as the model reports it, before the server checks it against Jet's own lines.
#[derive(Deserialize)]
struct Said {
    words: String,
    at: Option<String>,
}

impl Conversation {
    /// Prevents future reviews and cancels any provider review already running.
    pub fn stop_review(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        if let Some(stopper) = crate::lock(&self.review_stop).as_ref() {
            stopper.stop();
        }
    }

    /// How long until a review of this chat is due, or `None` when there is nothing new to read.
    /// It is due once the chat has been quiet for `quiet` and the last review was `gap` ago.
    pub fn review_wait(&self, now_ms: u64, quiet: Duration, gap: Duration) -> Option<Duration> {
        let (session, pending) = self.pending_since_last_review().ok().flatten()?;
        let last_said = pending.last().map_or(0, |entry| entry.at);
        let since = |at: u64| Duration::from_millis(now_ms.saturating_sub(at));
        let quiet_left = quiet.saturating_sub(since(last_said));
        let gap_left = gap.saturating_sub(since(session.reviewed_at));
        Some(quiet_left.max(gap_left))
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
    /// Where the chat stands in the list given to the review, which counts chats with nothing new.
    index: usize,
    chat: &'a ReviewedChat<'a>,
    pending: Vec<Entry>,
}

/// Reads what was said since the last review in every one of `chats` and updates the notes they
/// share, which are saved through the first chat. `when` is the user's local date, weekday and time
/// zone, so that the model can turn "on Thursday" into a time. Each chat keeps its own mark of how far it was
/// read. The caller sees to it that no two reviews of the same notes run at once.
pub fn review_chats(
    transport: &dyn Transport,
    name: &str,
    when: &str,
    chats: &[ReviewedChat],
) -> Result<Review, ReviewError> {
    let nothing = |outcome| {
        Ok(Review {
            outcome,
            promises: Vec::new(),
        })
    };
    let Some(lead) = chats.first().map(|chat| chat.conversation) else {
        return nothing(ReviewOutcome::Skipped);
    };
    let Some(_claim) = Claim::take(&lead.reviewing) else {
        return nothing(ReviewOutcome::Skipped);
    };
    let mut sources = Vec::new();
    for (index, chat) in chats.iter().enumerate() {
        if let Some((_, pending)) = chat.conversation.pending_since_last_review()? {
            sources.push(Source {
                index,
                chat,
                pending,
            });
        }
    }
    if sources.is_empty() {
        return nothing(ReviewOutcome::Skipped);
    }
    let before = lead.saved.notes()?;
    let request = Request {
        prompt: review_prompt(&before, &sources, name, when),
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
            return nothing(ReviewOutcome::Skipped);
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
            return nothing(ReviewOutcome::Stale);
        };
        let thread = saved.entries()?;
        let Some(last_read) = source.pending.last().filter(|last| thread.contains(last)) else {
            return nothing(ReviewOutcome::Stale);
        };
        marks.push((session, last_read.id));
    }
    if lead.saved.notes()? != before {
        return nothing(ReviewOutcome::Stale);
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
    Ok(Review {
        outcome,
        promises: resolve(verdict.promises, &sources),
    })
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

fn review_prompt(notes: &Notes, sources: &[Source], name: &str, when: &str) -> String {
    format!(
        "<now>{when}</now>\n<memory>{}</memory>\n<user>{}</user>\n<recent>{}</recent>\n<exchange>\n{}\n</exchange>",
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

/// Keeps a promise only when its words are in a line that Jet said, outside quoted text, among the
/// lines this review read. The model's word about where a promise came from is never trusted.
fn resolve(said: Vec<Said>, sources: &[Source]) -> Vec<Promise> {
    let mut found: Vec<Promise> = Vec::new();
    for promise in said {
        let words = squeeze(&promise.words);
        let spoken = sources.iter().find_map(|source| {
            let line = source.pending.iter().find(|entry| {
                entry.role == Role::Jet && squeeze(&outside_quotes(&entry.text)).contains(&words)
            })?;
            Some((source.index, line.at))
        });
        let Some((chat, said_at)) = spoken.filter(|_| !words.is_empty()) else {
            continue;
        };
        if !found.iter().any(|p| p.chat == chat && p.words == words) {
            let at = promise.at.filter(|at| !at.trim().is_empty());
            found.push(Promise {
                chat,
                said_at,
                words,
                at,
            });
        }
    }
    found
}

fn squeeze(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The text without quote lines (`>`), fenced code, and anything inside double quotes, straight
/// or curly. A quote that is never closed hides the rest of the text.
fn outside_quotes(text: &str) -> String {
    let mut fenced = false;
    let mut unquoted = String::new();
    for line in text.lines() {
        let line = line.trim_start();
        if line.starts_with("```") {
            fenced = !fenced;
        } else if !fenced && !line.starts_with('>') {
            unquoted.push_str(line);
            unquoted.push('\n');
        }
    }
    let (mut kept, mut closing) = (String::new(), None);
    for letter in unquoted.chars() {
        match (closing, letter) {
            (None, '"') => closing = Some('"'),
            (None, '\u{201C}') => closing = Some('\u{201D}'),
            (None, _) => kept.push(letter),
            (Some(end), _) if letter == end => {
                closing = None;
                kept.push(' ');
            }
            (Some(_), _) => {}
        }
    }
    kept
}

fn schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["changed", "memory", "user", "recent", "promises"],
        "properties": {
            "changed": {"type": "boolean"},
            "memory": {"type": "string", "maxLength": MEMORY_LIMIT},
            "user": {"type": "string", "maxLength": USER_LIMIT},
            "recent": {"type": "string", "maxLength": RECENT_LIMIT},
            "promises": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["words", "at"],
                    "properties": {
                        "words": {"type": "string"},
                        "at": {"type": ["string", "null"]}
                    }
                }
            }
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

    const WHEN: &str = "Tuesday 2026-11-24 10:00, time zone America/New_York";

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
        review_chats(&*chat.transport(), "Jet", WHEN, &[only]).map(|review| review.outcome)
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
                .review_wait(said_at + after_ms, REVIEW_QUIET, REVIEW_GAP)
                == Some(Duration::ZERO)
        };
        assert!(!due_after(10_000_000), "no thread yet");
        reviewed_thread(&chat.storage, said_at);

        assert!(!due_after(89_999), "still typing");
        assert!(due_after(90_000));
        assert!(
            chat.conversation
                .review_wait(said_at + 5_000, Duration::from_secs(5), REVIEW_GAP)
                == Some(Duration::ZERO),
            "the host may set a shorter wait"
        );
        chat.edit_session(|session| session.reviewed_at = said_at + 100_000);
        assert!(!due_after(100_000 + 599_999), "reviewed too recently");
        assert!(due_after(100_000 + 600_000));
        assert_eq!(
            chat.conversation
                .review_wait(said_at + 100_000 + 500_000, REVIEW_QUIET, REVIEW_GAP),
            Some(Duration::from_secs(100)),
            "a review that falls due too soon waits for the rest of the gap"
        );
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
        let outcome = review_chats(&*scripted, "Jet", WHEN, &chats)
            .unwrap()
            .outcome;
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
            review_chats(&*scripted, "Jet", WHEN, &chats)
                .unwrap()
                .outcome,
            ReviewOutcome::Skipped,
            "no entry is read twice"
        );
    }

    fn with_promises(promises: Value) -> Script {
        let output =
            json!({"changed": false, "memory": "", "user": "", "recent": "", "promises": promises});
        Script::lines(vec![structured_result_line(&output)])
    }

    #[test]
    fn promises_count_only_from_jets_own_unquoted_words() {
        let storage = Arc::new(InMemory::default());
        let lines = [
            NewEntry::user_text("I will check in on Friday."),
            jet_says("Sure. I will check in on 2090-03-04 at 10:00 to see how it went."),
            jet_says(
                "Your colleague wrote: \u{201C}I will remind you on Monday\u{201D}.\n> I will ping you on Tuesday\n```\nI will call you on Wednesday\n```",
            ),
        ];
        for line in lines {
            storage.add_entry(line, 5000).unwrap();
        }
        let session = Session {
            session_id: SessionId("s".into()),
            ..Session::default()
        };
        storage.save_session(Some(&session)).unwrap();
        let said = |words: &str, at: Value| json!({"words": words, "at": at});
        let chat = Chat::in_storage(
            storage,
            Scripted::new().then(with_promises(json!([
                said("I will check in on Friday.", Value::Null),
                said(
                    "I will check in on 2090-03-04  at 10:00",
                    json!("2090-03-04T10:00")
                ),
                said("I will remind you on Monday", Value::Null),
                said("I will ping you on Tuesday", Value::Null),
                said("I will call you on Wednesday", Value::Null),
                said("I will check in on 2090-03-04 at 10:00", Value::Null),
            ]))),
        );
        let only = ReviewedChat {
            title: "",
            conversation: &chat.conversation,
        };
        let review = review_chats(&*chat.transport(), "Jet", WHEN, &[only]).unwrap();
        assert_eq!(
            review.promises,
            vec![Promise {
                chat: 0,
                said_at: 5000,
                words: "I will check in on 2090-03-04 at 10:00".into(),
                at: Some("2090-03-04T10:00".into()),
            }],
            "the user's line, the quote, the quoted line and the code are not Jet's promise"
        );
    }

    #[test]
    fn a_promise_names_its_chat_in_the_list_even_when_earlier_chats_have_nothing_new() {
        let (quiet, busy) = (Arc::new(InMemory::default()), Arc::new(InMemory::default()));
        busy.add_entry(jet_says("I will check in later."), 7000)
            .unwrap();
        let session = Session {
            session_id: SessionId("s".into()),
            ..Session::default()
        };
        for storage in [&quiet, &busy] {
            storage.save_session(Some(&session)).unwrap();
        }
        let (first, second) = (Conversation::new(quiet), Conversation::new(busy));
        let chats = [
            ReviewedChat {
                title: "Quiet",
                conversation: &first,
            },
            ReviewedChat {
                title: "Busy",
                conversation: &second,
            },
        ];
        let scripted = Scripted::new().then(with_promises(
            json!([{"words": "I will check in later.", "at": null}]),
        ));
        let review = review_chats(&scripted, "Jet", WHEN, &chats).unwrap();
        assert_eq!(review.promises.len(), 1);
        assert_eq!(review.promises[0].chat, 1);
    }

    #[test]
    fn the_review_prompt_holds_the_rules_for_promises_and_for_less_please() {
        let rules = system_prompt("Jet");
        for rule in [
            "promises",
            "YYYY-MM-DDTHH:MM",
            "09:00",
            "never the user's lines",
            "quoted from the user, a colleague, a web page, a repository or an app",
            "ease off",
            "check in less",
            "waves a subject away",
        ] {
            assert!(rules.contains(rule), "the rules lack `{rule}`:\n{rules}");
        }
        let chat = Chat::with_transport(Scripted::new().then(verdict(false, "")));
        reviewed_thread(&chat.storage, 1000);
        review_one(&chat).unwrap();
        assert!(
            chat.requests()[0]
                .prompt
                .starts_with(&format!("<now>{WHEN}</now>"))
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
            index: 0,
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
