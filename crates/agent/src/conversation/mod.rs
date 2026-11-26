//! The chat as the app sees it: send a message and read the streamed answer, show and
//! forget the thread, edit the notes, and let the review keep them current.

mod accepted;
mod answer;
mod colleague;
mod hosts;
mod memory;
mod persona;
mod reply;
mod review;
mod session_policy;
mod wake;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub use answer::{AnswerAsk, AnswerError, CANNOT_ANSWER, answer_from_shared};
pub use colleague::colleague_notice;
use memory::Saved;
pub use memory::{InMemory, MemoryError, NewEntry, Session, Storage, now_ms};
pub use persona::size_words;
pub use reply::Reply;
pub use review::{
    Promise, REVIEW_GAP, REVIEW_QUIET, Review, ReviewError, ReviewOutcome, ReviewedChat,
    review_chats,
};
use session_policy::decide;
pub use wake::{
    CHECK_BUDGET_USD, CHECK_TIME_LIMIT, CheckDone, CheckFacts, CheckInState, CheckStart, CheckTurn,
    ColleagueFacts, ObjectiveFacts, SILENT, StepFacts, WakeError, brief, start_check,
};

use crate::chat::{
    Attachment, Effort, Entry, EntryId, McpConnection, McpServerFacts, Model, Notes, Persona, Role,
    ShownEntry, TurnIdentity,
};
use crate::markdown::render_markdown;
use crate::turn::{Request, SessionMode, Stopper, Transport, Turn};

/// Everything one message brings with it.
#[derive(Debug, Clone)]
pub struct Message {
    pub text: String,
    /// The files sent with the text. Jet is shown their details, not their contents.
    pub attachments: Vec<Attachment>,
    pub persona: Persona,
    pub model: Model,
    pub effort: Effort,
    /// The most one answer may cost.
    pub budget_usd: f64,
    /// The user's clock, for example `Tue 14 Oct 2026, 09:16`.
    pub local_time: String,
    pub mcp: Option<McpConnection>,
    pub active_app_id: Option<crate::apps::AppId>,
    /// A supported mood word supplied by the message classifier.
    pub feeling: Option<String>,
    /// True when the user hears this reply spoken aloud.
    pub spoken: bool,
    /// True when the voice that speaks the reply performs vocal cues such as `<laugh>`.
    pub voice_cues: bool,
    /// Lines for Jet about what the user did since their last message, such as a tap on a card.
    pub notices: Vec<String>,
    /// The MCP servers the user has turned on, read again for every turn.
    pub mcp_servers: Vec<McpServerFacts>,
}

/// How many of the newest entries a prompt lists the reactions of.
const REACTIONS_SHOWN: usize = 20;

/// What one turn is asked, and where Jet's reaction in it goes.
struct Answer {
    words: String,
    /// The user's message that Jet's reaction goes on.
    react_on: Option<EntryId>,
    answers_reaction: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ConversationError {
    #[error("Jet is still answering")]
    Busy,
    #[error("the thread has no Jet message {0} to react to")]
    NotJetMessage(EntryId),
    #[error(transparent)]
    Memory(#[from] MemoryError),
}

/// The saved thread and notes, and the right to run one answer and one review at a time.
#[derive(Clone)]
pub struct Conversation {
    saved: Saved,
    answering: Arc<AtomicBool>,
    reviewing: Arc<AtomicBool>,
    review_stop: Arc<Mutex<Option<Stopper>>>,
    shutting_down: Arc<AtomicBool>,
}

/// Holds a flag raised until it is dropped.
pub(super) struct Claim(Arc<AtomicBool>);

impl Claim {
    pub(super) fn take(flag: &Arc<AtomicBool>) -> Option<Claim> {
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| Claim(Arc::clone(flag)))
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Conversation {
    pub fn new(storage: Arc<dyn Storage>) -> Conversation {
        Conversation {
            saved: Saved::new(storage),
            answering: Arc::new(AtomicBool::new(false)),
            reviewing: Arc::new(AtomicBool::new(false)),
            review_stop: Arc::new(Mutex::new(None)),
            shutting_down: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn is_busy(&self) -> bool {
        self.answering.load(Ordering::SeqCst)
    }

    /// Saves the user's message and starts the answer. The returned `Reply` streams the
    /// events; the conversation stays busy until it is dropped. Even when Claude cannot
    /// be started, the failure comes out of the `Reply`, as it does for any other. The
    /// identity is saved with the user's entry before any provider work starts.
    pub fn send(
        &self,
        transport: Arc<dyn Transport>,
        message: Message,
        identity: Option<TurnIdentity>,
    ) -> Result<(ShownEntry, Reply), ConversationError> {
        let claim = Claim::take(&self.answering).ok_or(ConversationError::Busy)?;
        let recent = self.saved.last(REACTIONS_SHOWN)?;
        let mut user = NewEntry::user_text(&message.text);
        user.turn = identity.clone();
        user.attachments = message.attachments.clone();
        let words = persona::reaction_words(&recent) + &persona::message_words(&message);
        let answer = Answer {
            words,
            react_on: None,
            answers_reaction: false,
        };
        let (user_entry, reply) =
            self.answer(claim, transport, message, identity, answer, Some(user))?;
        let user_entry = user_entry.expect("a send saves the user's entry");
        Ok((shown(user_entry), reply))
    }

    /// Puts the user's emoji on a Jet message, or takes it off with `None`, and gives the message
    /// back with `true` when its reaction changed. Starts no turn: the caller decides whether Jet
    /// answers it.
    ///
    /// # Errors
    /// `NotJetMessage` when the thread has no Jet message with that id.
    pub fn react(
        &self,
        id: EntryId,
        emoji: Option<&str>,
    ) -> Result<(ShownEntry, bool), ConversationError> {
        let (entry, changed) = self
            .saved
            .react(id, Role::User, emoji, now_ms())?
            .ok_or(ConversationError::NotJetMessage(id))?;
        Ok((shown(entry), changed))
    }

    /// Lets Jet answer the user's reaction on one of its messages. Jet may write, react on the
    /// user's newest message, or do nothing. No user entry is added, and the text and files of
    /// `message` are left out; only its settings count.
    ///
    /// # Errors
    /// `Busy` while another answer runs, and `NotJetMessage` when the message has no reaction
    /// from the user.
    pub fn answer_reaction(
        &self,
        transport: Arc<dyn Transport>,
        message: Message,
        reacted: EntryId,
        identity: Option<TurnIdentity>,
    ) -> Result<Reply, ConversationError> {
        let claim = Claim::take(&self.answering).ok_or(ConversationError::Busy)?;
        let message = Message {
            text: String::new(),
            attachments: Vec::new(),
            ..message
        };
        let entries = self.saved.entries()?;
        let target = entries.iter().find(|entry| entry.id == reacted);
        let Some((target, emoji)) =
            target.and_then(|entry| Some((entry, entry.reaction_by(Role::User)?)))
        else {
            return Err(ConversationError::NotJetMessage(reacted));
        };
        let recent = &entries[entries.len().saturating_sub(REACTIONS_SHOWN)..];
        let words = persona::reaction_words(recent)
            + &persona::message_words(&message)
            + &persona::reacted_words(emoji, &target.text);
        let answer = Answer {
            words,
            react_on: entries
                .iter()
                .rev()
                .find(|entry| entry.role == Role::User)
                .map(|entry| entry.id),
            answers_reaction: true,
        };
        Ok(self
            .answer(claim, transport, message, identity, answer, None)?
            .1)
    }

    /// Every read that can fail comes before the user's entry is saved, so a failed answer leaves
    /// no message that has no reply.
    fn answer(
        &self,
        claim: Claim,
        transport: Arc<dyn Transport>,
        message: Message,
        identity: Option<TurnIdentity>,
        answer: Answer,
        user: Option<NewEntry>,
    ) -> Result<(Option<Entry>, Reply), ConversationError> {
        let Answer {
            words,
            react_on,
            answers_reaction,
        } = answer;
        let now = now_ms();
        let notes = self.saved.notes()?;
        let prompt_hash = persona::prompt_hash(&message.persona, message.model, message.effort);
        let saved = self.saved.session()?;
        let decision = decide(saved.as_ref(), &prompt_hash, now);
        // A session that is restarted after the provider lost it opens with the summary too, so the
        // reply keeps the opening words it was made from.
        let opening = match self.saved.objective_summary()? {
            Some(summary) => format!("{}{words}", persona::objective_words(&summary)),
            None => words.clone(),
        };
        let prompt = match decision.mode {
            SessionMode::New => reply::first_message(&message.local_time, &opening),
            _ => words,
        };
        let mut entries = self.saved.entries()?;
        let page_hosts = self.saved.page_hosts()?;
        if decision.mode == SessionMode::New
            && let Some(session) = &saved
        {
            let _held = self.saved.hold_session();
            self.saved
                .save_session(&session.clone().without_conversation())?;
        }
        let user_entry = user
            .map(|user| self.saved.append(user, now_ms()))
            .transpose()?;
        let react_on = user_entry.as_ref().map(|entry| entry.id).or(react_on);
        entries.extend(user_entry.clone());
        let request = Request {
            prompt,
            system_prompt: persona::compose(
                &message.persona,
                &notes,
                message.model,
                Some(&message.mcp_servers),
            ),
            model: message.model,
            effort: message.effort,
            budget_usd: message.budget_usd,
            session: decision.mode,
            schema: None,
            mcp: message.mcp,
            hosts: hosts::linked_hosts(&entries, &page_hosts),
        };
        let started = Turn::start(&*transport, &request);
        let context = reply::Context {
            identity,
            memory: self.saved.clone(),
            transport,
            request,
            text: opening,
            local_time: message.local_time,
            // A reaction turn often shows nothing at all, so it says nothing about the session.
            notice: decision
                .reason
                .filter(|_| !answers_reaction)
                .and_then(|reason| reason.notice(&message.persona.name)),
            persona_name: message.persona.name,
            prompt_hash,
            notes,
            saved,
            react_on,
            answers_reaction,
        };
        Ok((user_entry, Reply::new(context, claim, started)))
    }

    /// The newest `limit` entries of the thread, oldest first.
    pub fn history(&self, limit: usize) -> Result<Vec<ShownEntry>, MemoryError> {
        let entries = self.saved.last(limit)?;
        Ok(entries.into_iter().map(shown).collect())
    }

    /// Starts the thread over. The notes stay.
    pub fn forget(&self) -> Result<(), ConversationError> {
        let _claim = Claim::take(&self.answering).ok_or(ConversationError::Busy)?;
        self.saved.forget(now_ms())?;
        Ok(())
    }

    /// Saves a Jet entry that answers no message, such as a check-in, and gives it back.
    pub fn add_jet_entry(&self, entry: NewEntry) -> Result<ShownEntry, MemoryError> {
        Ok(shown(self.saved.append(entry, now_ms())?))
    }

    pub fn notes(&self) -> Result<Notes, MemoryError> {
        self.saved.notes()
    }

    /// Saves notes the user edited. The next message starts a fresh conversation, so
    /// Claude sees them.
    pub fn save_notes(&self, notes: Notes) -> Result<Notes, MemoryError> {
        let saved = self.saved.save_notes(&notes)?;
        self.saved
            .update_session(|session| session.prompt_hash.clear())?;
        Ok(saved)
    }

    /// Returns only measurements associated with the selected model.
    ///
    /// # Errors
    /// Returns a memory error if the saved session cannot be read.
    pub fn context_status(&self, model: Model) -> Result<crate::chat::ContextStatus, MemoryError> {
        let session = self.saved.session()?.unwrap_or_default();
        if session.context.model == Some(model) {
            Ok(session.context)
        } else {
            Ok(crate::chat::ContextStatus {
                model: Some(model),
                ..Default::default()
            })
        }
    }
}

/// An entry with its text rendered for display.
pub(super) fn shown(entry: Entry) -> ShownEntry {
    let html = match entry.role {
        Role::Jet => render_markdown(&entry.text),
        Role::User => String::new(),
    };
    ShownEntry { entry, html }
}

#[cfg(test)]
mod test_support {
    use super::*;
    use crate::chat::Event;
    use crate::turn::scripted::{Script, Scripted, reply_lines};

    pub(super) fn message(text: &str) -> Message {
        Message {
            text: text.to_owned(),
            attachments: Vec::new(),
            persona: Persona::default(),
            model: Model::Sonnet,
            effort: Effort::Medium,
            budget_usd: 1.0,
            local_time: "Tue 14 Oct 2026, 11:20".to_owned(),
            mcp: None,
            active_app_id: None,
            feeling: None,
            spoken: false,
            voice_cues: false,
            notices: Vec::new(),
            mcp_servers: Vec::new(),
        }
    }

    /// A conversation kept in memory, talking to a scripted Claude.
    pub(super) struct Chat {
        pub conversation: Conversation,
        pub storage: Arc<InMemory>,
        transport: Arc<Scripted>,
    }

    impl Chat {
        /// One scripted reply for each session id, in order.
        pub fn new<const N: usize>(sessions: [&str; N]) -> Chat {
            let scripted = sessions.iter().fold(Scripted::new(), |scripted, id| {
                scripted.then(Script::lines(reply_lines(id, "mood: neutral\nHi")))
            });
            Chat::with_transport(scripted)
        }

        pub fn with_transport(scripted: Scripted) -> Chat {
            Chat::in_storage(Arc::new(InMemory::default()), scripted)
        }

        pub fn in_storage(storage: Arc<InMemory>, scripted: Scripted) -> Chat {
            Chat {
                conversation: Conversation::new(storage.clone()),
                storage,
                transport: Arc::new(scripted),
            }
        }

        pub fn send(&self, message: Message) -> Vec<Event> {
            let (_, reply) = self
                .conversation
                .send(self.transport.clone(), message, None)
                .unwrap();
            reply.collect()
        }

        pub fn transport(&self) -> Arc<Scripted> {
            Arc::clone(&self.transport)
        }

        pub fn requests(&self) -> Vec<Request> {
            self.transport.requests()
        }

        pub fn saved_session(&self) -> Session {
            self.storage
                .session()
                .unwrap()
                .expect("a session was saved")
        }

        pub fn edit_session(&self, change: impl FnOnce(&mut Session)) {
            let mut session = self.saved_session();
            change(&mut session);
            self.storage.save_session(Some(&session)).unwrap();
        }
    }
}

// A send that fails before its turn starts must leave no user entry behind.
#[cfg(test)]
mod failed_send {
    use super::test_support::message;
    use super::*;
    use crate::turn::scripted::Scripted;

    struct NotesFail(InMemory);
    impl Storage for NotesFail {
        fn entries(&self) -> Result<Vec<Entry>, MemoryError> {
            self.0.entries()
        }
        fn last_entries(&self, limit: usize) -> Result<Vec<Entry>, MemoryError> {
            self.0.last_entries(limit)
        }
        fn add_entry(&self, entry: NewEntry, at: u64) -> Result<Entry, MemoryError> {
            self.0.add_entry(entry, at)
        }
        fn replace_entry(&self, entry: &Entry) -> Result<(), MemoryError> {
            self.0.replace_entry(entry)
        }
        fn forget_entries(&self, at: u64) -> Result<(), MemoryError> {
            self.0.forget_entries(at)
        }
        fn session(&self) -> Result<Option<Session>, MemoryError> {
            self.0.session()
        }
        fn save_session(&self, session: Option<&Session>) -> Result<(), MemoryError> {
            self.0.save_session(session)
        }
        fn notes(&self) -> Result<Notes, MemoryError> {
            Err(MemoryError::Storage("the database is locked".into()))
        }
        fn save_notes(&self, notes: &Notes) -> Result<(), MemoryError> {
            self.0.save_notes(notes)
        }
    }

    #[test]
    fn a_send_that_fails_before_its_turn_leaves_no_user_entry() {
        let storage = Arc::new(NotesFail(InMemory::default()));
        let conversation = Conversation::new(storage.clone());
        let sent = conversation.send(Arc::new(Scripted::new()), message("hello"), None);
        assert!(sent.is_err(), "the send fails");
        let entries = storage.entries().unwrap();
        let texts: Vec<_> = entries
            .iter()
            .map(|entry| (entry.role, entry.text.clone()))
            .collect();
        assert!(
            entries.is_empty(),
            "the failed send left entries: {texts:?}"
        );
    }
}
