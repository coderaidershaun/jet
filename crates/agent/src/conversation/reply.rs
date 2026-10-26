//! One streamed answer: reads a turn, turns its steps into events for the chat page, and
//! saves the session and the thread as it goes. A session that has vanished from Claude
//! Code is replaced once, so a deleted session file cannot lock the chat.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use super::memory::{DataDir, MemoryError, NewEntry, Session, Transcript, now_ms};
use super::session_policy::FreshReason;
use super::{Claim, shown};
use crate::chat::{Entry, EntryId, EntryStatus, Event, Failure, Role, SessionId};
use crate::turn::{
    Request, SessionMode, Step, Stopper, Summary, Transport, TransportError, Turn, TurnError,
};

/// Everything a reply needs to know about the message it answers.
pub(super) struct Context {
    pub identity: Option<crate::TurnIdentity>,
    pub dir: DataDir,
    pub transport: Arc<dyn Transport>,
    pub request: Request,
    /// What Claude reads of the message, without the local time line.
    pub text: String,
    pub local_time: String,
    pub persona_name: String,
    /// Fingerprint of the prompt inputs, saved with the session.
    pub prompt_hash: String,
    pub saved: Option<Session>,
    pub notice: Option<String>,
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
            Some(Step::Init { session_id, .. }) => self.handle_init(session_id),
            Some(Step::Mood(mood)) => self.queue.push_back(Event::Mood { mood }),
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
    /// something to resume.
    // SMELL: notes the user saves after the send but before this point lose their stale
    // mark here, so Claude only sees them in a later fresh conversation.
    fn save_new_session(&self, session_id: &SessionId) -> Result<(), MemoryError> {
        let Context {
            dir,
            request,
            saved,
            prompt_hash,
            ..
        } = &self.context;
        let kept = match (&request.session, saved) {
            (SessionMode::Resume(_), Some(saved)) => Some(saved),
            _ => None,
        };
        // The review may have moved on since this message was sent, so read its progress again.
        let reviewed = Session::load(dir)?
            .or_else(|| saved.clone())
            .unwrap_or_default();
        Session {
            session_id: session_id.clone(),
            last_request_at: self.spawned_at,
            context_tokens: kept.map_or(0, |saved| saved.context_tokens),
            context: kept.map_or_else(Default::default, |saved| saved.context.clone()),
            prompt_hash: prompt_hash.clone(),
            reviewed_through: reviewed.reviewed_through,
            reviewed_at: reviewed.reviewed_at,
        }
        .save(dir)
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
        let dir = &self.context.dir;
        match Session::load(dir)? {
            Some(session) => session.without_conversation().save(dir),
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
            (Err(memory_error), _) => {
                let message = memory_error.to_string();
                let unsaved = self.jet_entry(EntryStatus::Failed, Some(message.clone()));
                Event::Failed {
                    failure: Failure::Io { message },
                    entry: shown(unsaved.into_entry(EntryId(0), now_ms())),
                }
            }
        };
        self.queue.push_back(event);
    }

    /// The answer so far, as a thread entry.
    fn jet_entry(&self, status: EntryStatus, error: Option<String>) -> NewEntry {
        let turn = self.turn.as_ref();
        NewEntry {
            turn: self.context.identity.clone(),
            role: Role::Jet,
            text: turn.map(|turn| turn.text().to_owned()).unwrap_or_default(),
            mood: turn.and_then(Turn::mood),
            status,
            error,
            tools: turn.map(|turn| turn.tools().to_vec()).unwrap_or_default(),
        }
    }

    fn save_jet_entry(&self, entry: NewEntry, ending: &Ending) -> Result<Entry, MemoryError> {
        let dir = &self.context.dir;
        let entry = Transcript::open(dir).append(entry, now_ms())?;
        if let Ending::Finished(summary) = ending
            && let Some(mut session) = Session::load(dir)?
        {
            session.context_tokens = summary.context_tokens;
            session.context = summary.context.clone();
            session.context.model = Some(self.context.request.model);
            session.save(dir)?;
        }
        Ok(entry)
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
    use crate::turn::scripted::{Script, Scripted, reply_lines};

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
        let chat = Chat::with_transport("reply-vanished", scripted);
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

        let notices: Vec<&Event> = events
            .iter()
            .filter(|e| matches!(e, Event::Notice { .. }))
            .collect();
        assert_eq!(notices.len(), 1);
        assert!(matches!(notices[0], Event::Notice { message }
            if message == "Couldn't find the last conversation, so started a fresh one. Jet's memory is kept."));
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
    }

    #[test]
    fn a_transport_that_cannot_start_still_ends_with_a_failed_event() {
        let missing = TransportError::ClaudeMissing {
            searched: vec!["/a/claude".into(), "/b/claude".into()],
        };
        let chat = Chat::with_transport(
            "reply-missing",
            Scripted::new().then(Script::cannot_start(missing)),
        );
        let events = chat.send(message("hello"));

        let [Event::Failed { failure, entry }] = &events[..] else {
            panic!("expected one Failed event, got {events:?}");
        };
        assert_eq!(
            failure.message(),
            "I couldn't find Claude Code. I looked in: /a/claude, /b/claude"
        );
        assert_eq!(entry.entry.status, EntryStatus::Failed);
        assert_eq!(entry.entry.error.as_deref(), Some(failure.message()));
        let history = chat.conversation.history(10).unwrap();
        assert_eq!(
            history.len(),
            2,
            "the user entry and the failed Jet entry are saved"
        );
    }
}
