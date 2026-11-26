//! One streamed answer: reads a turn, turns its steps into events for the chat page, and
//! saves the session and the thread as it goes. A session that has vanished from Claude
//! Code is replaced once, so a deleted session file cannot lock the chat.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use super::memory::{MemoryError, NewEntry, Saved, Session, now_ms};
use super::session_policy::FreshReason;
use super::{Claim, shown};
use crate::chat::{
    Entry, EntryId, EntryStatus, Event, Failure, Notes, Role, SessionId, TurnIdentity,
};
use crate::turn::{
    Request, SessionMode, Step, Stopper, Summary, Transport, TransportError, Turn, TurnError,
};

/// Everything a reply needs to know about the message it answers.
pub(super) struct Context {
    pub identity: Option<TurnIdentity>,
    pub memory: Saved,
    pub transport: Arc<dyn Transport>,
    pub request: Request,
    /// What Claude reads of the message, without the local time line.
    pub text: String,
    pub local_time: String,
    pub persona_name: String,
    /// Fingerprint of the prompt inputs, saved with the session.
    pub prompt_hash: String,
    /// The notes the system prompt was made from.
    pub notes: Notes,
    pub saved: Option<Session>,
    pub notice: Option<String>,
    /// The user's message that Jet's reaction goes on.
    pub react_on: Option<EntryId>,
    /// True when the turn answers the user's reaction instead of a new message.
    pub answers_reaction: bool,
}

/// The events of one answer, read with `Iterator`. Reading blocks until the next event.
pub struct Reply {
    context: Context,
    turn: Option<Turn>,
    spawned_at: u64,
    retry_left: bool,
    seen_init: bool,
    ended: bool,
    queue: VecDeque<Event>,
    /// The stopper of whichever turn is running now.
    running: Arc<Mutex<Stopper>>,
    stopper: Stopper,
    _claim: Claim,
}

/// How the answer ends.
enum Ending {
    Finished(Summary),
    Stopped,
    Failed(Failure),
}

impl Reply {
    pub(super) fn new(context: Context, claim: Claim, started: Result<Turn, TurnError>) -> Reply {
        let current = started
            .as_ref()
            .map_or_else(|_| Stopper::inert(), Turn::stopper);
        let running = Arc::new(Mutex::new(current));
        let forward = Arc::clone(&running);
        let stopper = Stopper::new(move || {
            if let Ok(current) = forward.lock() {
                current.stop();
            }
        });
        let mut reply = Reply {
            context,
            turn: None,
            spawned_at: now_ms(),
            retry_left: true,
            seen_init: false,
            ended: false,
            queue: VecDeque::new(),
            running,
            stopper,
            _claim: claim,
        };
        match started {
            Ok(turn) => reply.turn = Some(turn),
            Err(error) => reply.handle_failure(error),
        }
        reply
    }

    /// Stops the answer, whichever turn is running. The text so far is kept.
    pub fn stopper(&self) -> Stopper {
        self.stopper.clone()
    }

    fn advance(&mut self) {
        let step = self.turn.as_mut().and_then(Iterator::next);
        match step {
            Some(Step::Init { session_id }) => self.handle_init(session_id),
            Some(Step::Mood(mood)) => self.queue.push_back(Event::Mood { mood }),
            Some(Step::Reaction(emoji)) => self.react(&emoji),
            Some(Step::Text(delta)) => self.queue.push_back(Event::Text { delta }),
            Some(Step::ToolStarted(start)) => self.queue.push_back(Event::ToolStarted(start)),
            Some(Step::ToolFinished(call)) => self.queue.push_back(Event::ToolFinished(call)),
            Some(Step::Finished(summary)) => self.conclude(Ending::Finished(summary)),
            Some(Step::Stopped) => self.conclude(Ending::Stopped),
            Some(Step::Failed(error)) => self.handle_failure(error),
            None => self.handle_failure(TurnError::NoResult),
        }
    }

    fn handle_init(&mut self, session_id: SessionId) {
        self.seen_init = true;
        let fresh = self.context.request.session == SessionMode::New;
        if let Err(error) = self.save_new_session(&session_id) {
            self.stopper.stop();
            return self.conclude(Ending::Failed(Failure::Io {
                message: error.to_string(),
            }));
        }
        self.queue.push_back(Event::Started { fresh });
        if let Some(message) = self.context.notice.take() {
            self.queue.push_back(Event::Notice { message });
        }
    }

    /// Records the session as soon as Claude names it, so a crash mid-answer still leaves
    /// something to resume. Notes the user saved since the send are not in this session's prompt,
    /// so the session is then saved stale and the next message starts fresh.
    fn save_new_session(&self, session_id: &SessionId) -> Result<(), MemoryError> {
        let Context {
            memory: storage,
            request,
            saved,
            prompt_hash,
            notes,
            ..
        } = &self.context;
        let kept = match (&request.session, saved) {
            (SessionMode::Resume(_), Some(saved)) => Some(saved),
            _ => None,
        };
        let stored = storage.session()?;
        // The user's save clears the mark of the stored session, or finds none to clear. Notes the
        // review saves meanwhile leave the mark, as they do outside a send.
        let user_saved_notes = storage.notes()? != *notes
            && stored
                .as_ref()
                .is_none_or(|stored| stored.prompt_hash.is_empty());
        let prompt_hash = if user_saved_notes {
            String::new()
        } else {
            prompt_hash.clone()
        };
        // The review may have moved on since this message was sent, so read its progress again.
        let reviewed = stored.or_else(|| saved.clone()).unwrap_or_default();
        storage.save_session(&Session {
            session_id: session_id.clone(),
            last_request_at: self.spawned_at,
            context_tokens: kept.map_or(0, |saved| saved.context_tokens),
            context: kept.map_or_else(Default::default, |saved| saved.context.clone()),
            prompt_hash,
            reviewed_through: reviewed.reviewed_through,
            reviewed_at: reviewed.reviewed_at,
        })
    }

    /// Saves Jet's emoji on the user's message at once, so the page shows it while the reply runs.
    /// A failed save loses only the reaction, never the reply.
    fn react(&mut self, emoji: &str) {
        let Some(id) = self.context.react_on else {
            return;
        };
        match self
            .context
            .memory
            .react(id, Role::Jet, Some(emoji), now_ms())
        {
            Ok(Some((entry, true))) => self.queue.push_back(Event::Reactions {
                entry_id: entry.id,
                reactions: entry.reactions,
            }),
            Ok(_) => {}
            Err(error) => {
                eprintln!("jet: could not save Jet's reaction on message {id}: {error}");
            }
        }
    }

    fn handle_failure(&mut self, error: TurnError) {
        let vanished = self.retry_left
            && !self.seen_init
            && matches!(self.context.request.session, SessionMode::Resume(_))
            && matches!(error, TurnError::Transport(TransportError::Exited { .. }));
        if !vanished {
            return self.conclude(Ending::Failed(Failure::from(&error)));
        }
        self.retry_left = false;
        if let Err(error) = self.drop_vanished_session() {
            return self.conclude(Ending::Failed(Failure::Io {
                message: error.to_string(),
            }));
        }
        let context = &mut self.context;
        context.request.session = SessionMode::New;
        context.request.prompt = first_message(&context.local_time, &context.text);
        self.spawned_at = now_ms();
        match Turn::start(&*self.context.transport, &self.context.request) {
            Ok(turn) => {
                self.context.notice = FreshReason::Vanished.notice(&self.context.persona_name);
                self.follow(turn);
            }
            Err(error) => self.conclude(Ending::Failed(Failure::from(&error))),
        }
    }

    /// Forgets the id Claude no longer knows, so the next message starts fresh even when
    /// this retry fails too.
    fn drop_vanished_session(&self) -> Result<(), MemoryError> {
        let saved = &self.context.memory;
        match saved.session()? {
            Some(session) => saved.save_session(&session.without_conversation()),
            None => Ok(()),
        }
    }

    /// Makes the reply's stopper control the new turn, even if a stop came in meanwhile.
    fn follow(&mut self, turn: Turn) {
        if let Ok(mut current) = self.running.lock() {
            *current = turn.stopper();
        }
        if self.stopper.is_stopped() {
            turn.stopper().stop();
        }
        self.turn = Some(turn);
    }

    fn conclude(&mut self, ending: Ending) {
        self.ended = true;
        // A stopped turn without words leaves no empty bubble either; a failed one keeps its error.
        if !matches!(ending, Ending::Failed(_)) && self.is_wordless() {
            let saved = match &ending {
                Ending::Finished(summary) => self.save_context(summary),
                _ => Ok(()),
            };
            let event = match saved {
                Ok(()) => Event::NoReply,
                Err(error) => self.unsaved_failure(&error),
            };
            return self.queue.push_back(event);
        }
        let (status, error) = match &ending {
            Ending::Finished(_) => (EntryStatus::Complete, None),
            Ending::Stopped => (EntryStatus::Stopped, None),
            Ending::Failed(failure) => (EntryStatus::Failed, Some(failure.message().to_owned())),
        };
        let saved = self.save_jet_entry(self.jet_entry(status, error), &ending);
        let event = match (saved, ending) {
            (Ok(entry), Ending::Finished(_)) => Event::Finished {
                entry: shown(entry),
            },
            (Ok(entry), Ending::Stopped) => Event::Stopped {
                entry: shown(entry),
            },
            (Ok(entry), Ending::Failed(failure)) => Event::Failed {
                failure,
                entry: shown(entry),
            },
            (Err(memory_error), _) => self.unsaved_failure(&memory_error),
        };
        self.queue.push_back(event);
    }

    /// The end of a reply whose saving failed: the user sees why, on an entry that is not saved.
    fn unsaved_failure(&self, error: &MemoryError) -> Event {
        let message = error.to_string();
        let unsaved = self.jet_entry(EntryStatus::Failed, Some(message.clone()));
        Event::Failed {
            failure: Failure::Io { message },
            entry: shown(unsaved.into_entry(0, now_ms())),
        }
    }

    /// A turn with nothing to show needs no Jet entry when Jet reacted in it, or when it answers
    /// a reaction. Any other empty reply still gets its entry, as before.
    fn is_wordless(&self) -> bool {
        let Some(turn) = &self.turn else {
            return false;
        };
        let nothing_shown = turn.text().trim().is_empty() && turn.tools().is_empty();
        nothing_shown && (self.context.answers_reaction || turn.reaction().is_some())
    }

    /// The answer so far, as a thread entry.
    fn jet_entry(&self, status: EntryStatus, error: Option<String>) -> NewEntry {
        let turn = self.turn.as_ref();
        NewEntry {
            turn: self.context.identity.clone(),
            role: Role::Jet,
            text: turn.map(|turn| turn.text().to_owned()).unwrap_or_default(),
            attachments: Vec::new(),
            mood: turn.and_then(Turn::mood),
            status,
            error,
            tools: turn.map(|turn| turn.tools().to_vec()).unwrap_or_default(),
            check: None,
            colleague: None,
        }
    }

    fn save_jet_entry(&self, entry: NewEntry, ending: &Ending) -> Result<Entry, MemoryError> {
        let entry = self.context.memory.append(entry, now_ms())?;
        if let Ending::Finished(summary) = ending {
            self.save_context(summary)?;
        }
        Ok(entry)
    }

    fn save_context(&self, summary: &Summary) -> Result<(), MemoryError> {
        let saved = &self.context.memory;
        let Some(mut session) = saved.session()? else {
            return Ok(());
        };
        session.context_tokens = summary.context_tokens;
        session.context = summary.context.clone();
        session.context.model = Some(self.context.request.model);
        saved.save_session(&session)
    }
}

impl Iterator for Reply {
    type Item = Event;

    fn next(&mut self) -> Option<Event> {
        loop {
            if let Some(event) = self.queue.pop_front() {
                return Some(event);
            }
            if self.ended {
                return None;
            }
            self.advance();
        }
    }
}

/// The first message of a conversation carries the local time, because the system prompt
/// must not (a changing prompt would defeat Claude's cache).
pub(super) fn first_message(local_time: &str, text: &str) -> String {
    format!("[local time: {local_time}]\n{text}")
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{Chat, message};
    use super::*;
    use crate::chat::Event;
    use crate::turn::scripted::{
        Script, Scripted, delta_line, init_line, reply_lines, result_line, tool_result_line,
        tool_use_line,
    };
    use serde_json::json;

    #[test]
    fn vanished_session_retries_once_fresh_with_a_notice() {
        let gone = || {
            Script::lines(vec![]).then_error(TransportError::Exited {
                code: Some(1),
                stderr: "No conversation found with session ID: old-session".into(),
            })
        };
        let scripted = Scripted::new()
            .then(Script::lines(reply_lines(
                "old-session",
                "mood: happy\nFirst",
            )))
            .then(gone())
            .then(Script::lines(reply_lines(
                "new-session",
                "mood: happy\nSecond",
            )))
            .then(gone())
            .then(gone())
            .then(Script::lines(reply_lines("third-session", "Third")));
        let chat = Chat::with_transport(scripted);
        chat.send(message("hello"));
        let events = chat.send(message("are you there?"));

        let requests = chat.requests();
        assert_eq!(requests.len(), 3);
        assert_eq!(
            requests[1].session,
            SessionMode::Resume(SessionId("old-session".into()))
        );
        assert_eq!(requests[1].prompt, "are you there?");
        assert_eq!(requests[2].session, SessionMode::New);
        assert!(requests[2].prompt.starts_with("[local time: "));
        assert!(requests[2].prompt.ends_with("\nare you there?"));
        // The thread keeps only what the user wrote.
        let thread = chat.conversation.history(10).unwrap();
        let users: Vec<&str> = thread
            .iter()
            .filter(|shown| shown.entry.role == Role::User)
            .map(|shown| shown.entry.text.as_str())
            .collect();
        assert_eq!(users, ["hello", "are you there?"]);

        let notices = events.iter().filter(|e| matches!(e, Event::Notice { .. }));
        assert_eq!(notices.count(), 1);
        let started: Vec<_> = events
            .iter()
            .filter(|e| matches!(e, Event::Started { fresh: true }))
            .collect();
        assert_eq!(
            started.len(),
            1,
            "one Started, from the fresh session: {events:?}"
        );
        let started_at = events
            .iter()
            .position(|e| matches!(e, Event::Started { .. }))
            .unwrap();
        let notice_at = events
            .iter()
            .position(|e| matches!(e, Event::Notice { .. }))
            .unwrap();
        assert_eq!(notice_at, started_at + 1);
        assert!(matches!(events.last(), Some(Event::Finished { .. })));
        assert_eq!(chat.saved_session().session_id.0, "new-session");

        // When the fresh start fails as well, the next message does not try the lost id again.
        chat.send(message("and now?"));
        let events = chat.send(message("hello?"));
        assert_eq!(chat.requests()[5].session, SessionMode::New);
        let notices = events.iter().filter(|e| matches!(e, Event::Notice { .. }));
        assert_eq!(notices.count(), 1, "{events:?}");

        // A transport that cannot start still ends the reply with a Failed event.
        let missing = TransportError::ClaudeMissing {
            searched: vec!["/a/claude".into(), "/b/claude".into()],
        };
        let chat = Chat::with_transport(Scripted::new().then(Script::cannot_start(missing)));
        let events = chat.send(message("hello"));
        let [Event::Failed { failure, entry }] = &events[..] else {
            panic!("expected one Failed event, got {events:?}");
        };
        for place in ["/a/claude", "/b/claude"] {
            assert!(failure.message().contains(place), "{}", failure.message());
        }
        assert_eq!(entry.entry.status, EntryStatus::Failed);
        assert_eq!(entry.entry.error.as_deref(), Some(failure.message()));
        let history = chat.conversation.history(10).unwrap();
        assert_eq!(
            history.len(),
            2,
            "the user entry and the failed Jet entry are saved"
        );
    }

    #[test]
    fn notes_the_user_saves_while_a_reply_starts_reach_the_next_message() {
        let chat = Chat::new(["one", "two", "three"]);
        chat.send(message("first"));
        let (_, reply) = chat
            .conversation
            .send(chat.transport(), message("second"), None)
            .unwrap();
        let notes = Notes {
            memory: "likes tea".into(),
            ..Notes::default()
        };
        chat.conversation.save_notes(notes).unwrap();
        let _: Vec<Event> = reply.collect();
        chat.send(message("third"));

        let requests = chat.requests();
        assert!(matches!(requests[1].session, SessionMode::Resume(_)));
        assert_eq!(requests[2].session, SessionMode::New);
        assert!(requests[2].system_prompt.contains("likes tea"));
    }

    #[test]
    fn a_web_read_line_becomes_a_tool_card_kept_on_the_turn() {
        let fetch = json!({"url": "https://github.com/anthropics", "prompt": "What is it?"});
        let search = json!({"query": "jet kite"});
        let lines = vec![
            init_line("s1"),
            tool_use_line(&[
                ("w1", "WebFetch", fetch.clone()),
                ("w2", "WebSearch", search.clone()),
            ]),
            tool_result_line("w1", "A page about Claude Code."),
            tool_result_line("w2", "Three results."),
            delta_line("mood: neutral\nRead it."),
            result_line("Read it."),
        ];
        let chat = Chat::with_transport(Scripted::new().then(Script::lines(lines)));
        let events = chat.send(message("read https://github.com/anthropics"));

        let cards: Vec<(&str, &str, &serde_json::Value)> = events
            .iter()
            .filter_map(|event| match event {
                Event::ToolStarted(start) => {
                    Some((start.server.as_str(), start.tool.as_str(), &start.input))
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            cards,
            [("web", "fetch", &fetch), ("web", "search", &search)]
        );
        let Some(Event::Finished { entry }) = events.last() else {
            panic!("the reply finishes: {events:?}");
        };
        let saved = &chat.conversation.history(1).unwrap()[0].entry;
        for tools in [&entry.entry.tools, &saved.tools] {
            let read: Vec<(&str, bool, bool)> = tools
                .iter()
                .map(|call| (call.tool.as_str(), call.ok, call.read_web()))
                .collect();
            assert_eq!(read, [("fetch", true, true), ("search", true, true)]);
            assert_eq!(tools[0].result, json!("A page about Claude Code."));
        }
    }
}
