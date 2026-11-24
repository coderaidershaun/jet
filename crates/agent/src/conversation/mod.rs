//! The chat as the app sees it: send a message and read the streamed answer, show and
//! forget the thread, edit the notes, and let the review keep them current.

mod accepted;
mod hosts;
mod memory;
mod persona;
mod reply;
mod review;
mod session_policy;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub use memory::{DataDir, MemoryError, now_ms};
use memory::{NewEntry, Session, Transcript};
pub use reply::Reply;
pub use review::{REVIEW_QUIET, ReviewError, ReviewOutcome};
use session_policy::decide;

use crate::chat::{
    Attachment, Effort, Entry, EntryId, McpConnection, Model, Notes, Persona, Role, ShownEntry,
    TurnIdentity,
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
    dir: DataDir,
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
    pub fn new(dir: DataDir) -> Conversation {
        Conversation {
            dir,
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
        let transcript = Transcript::open(&self.dir);
        let recent = transcript.last(REACTIONS_SHOWN)?;
        let mut user = NewEntry::user(&message.text);
        user.turn = identity.clone();
        user.attachments = message.attachments.clone();
        let user_entry = transcript.append(user, now_ms())?;
        let words = persona::reaction_words(&recent) + &persona::message_words(&message);
        let answer = Answer {
            words,
            react_on: Some(user_entry.id),
            answers_reaction: false,
        };
        let reply = self.answer(claim, transport, message, identity, answer)?;
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
        let (entry, changed) = Transcript::open(&self.dir)
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
        let entries = Transcript::open(&self.dir).entries()?;
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
        self.answer(claim, transport, message, identity, answer)
    }

    fn answer(
        &self,
        claim: Claim,
        transport: Arc<dyn Transport>,
        message: Message,
        identity: Option<TurnIdentity>,
        answer: Answer,
    ) -> Result<Reply, ConversationError> {
        let Answer {
            words,
            react_on,
            answers_reaction,
        } = answer;
        let now = now_ms();
        let notes = Notes::load(&self.dir)?;
        let prompt_hash = persona::prompt_hash(&message.persona, message.model, message.effort);
        let saved = Session::load(&self.dir)?;
        let decision = decide(saved.as_ref(), &prompt_hash, now);
        let prompt = match decision.mode {
            SessionMode::New => reply::first_message(&message.local_time, &words),
            _ => words.clone(),
        };
        let entries = Transcript::open(&self.dir).entries()?;
        let request = Request {
            prompt,
            system_prompt: persona::compose(&message.persona, &notes, message.model),
            model: message.model,
            effort: message.effort,
            budget_usd: message.budget_usd,
            session: decision.mode,
            schema: None,
            mcp: message.mcp,
            hosts: hosts::linked_hosts(&entries),
        };
        if request.session == SessionMode::New
            && let Some(session) = &saved
        {
            session.clone().without_conversation().save(&self.dir)?;
        }
        let started = Turn::start(&*transport, &request);
        let context = reply::Context {
            identity,
            dir: self.dir.clone(),
            transport,
            request,
            text: words,
            local_time: message.local_time,
            // A reaction turn often shows nothing at all, so it says nothing about the session.
            notice: decision
                .reason
                .filter(|_| !answers_reaction)
                .and_then(|reason| reason.notice(&message.persona.name)),
            persona_name: message.persona.name,
            prompt_hash,
            saved,
            react_on,
            answers_reaction,
        };
        Ok(Reply::new(context, claim, started))
    }

    /// The newest `limit` entries of the thread, oldest first.
    pub fn history(&self, limit: usize) -> Result<Vec<ShownEntry>, MemoryError> {
        let entries = Transcript::open(&self.dir).last(limit)?;
        Ok(entries.into_iter().map(shown).collect())
    }

    /// Starts the thread over. The notes stay.
    pub fn forget(&self) -> Result<(), ConversationError> {
        let _claim = Claim::take(&self.answering).ok_or(ConversationError::Busy)?;
        Transcript::open(&self.dir).rotate(now_ms())?;
        Session::delete(&self.dir)?;
        Ok(())
    }

    pub fn notes(&self) -> Result<Notes, MemoryError> {
        Notes::load(&self.dir)
    }

    /// Saves notes the user edited. The next message starts a fresh conversation, so
    /// Claude sees them.
    pub fn save_notes(&self, notes: Notes) -> Result<Notes, MemoryError> {
        let saved = notes.save(&self.dir)?;
        if let Some(mut session) = Session::load(&self.dir)? {
            session.prompt_hash.clear();
            session.save(&self.dir)?;
        }
        Ok(saved)
    }

    /// Returns only measurements associated with the selected model.
    ///
    /// # Errors
    /// Returns a memory error if the saved session cannot be read.
    pub fn context_status(&self, model: Model) -> Result<crate::chat::ContextStatus, MemoryError> {
        let session = Session::load(&self.dir)?.unwrap_or_default();
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
        }
    }

    /// A conversation in a scratch folder, talking to a scripted Claude.
    pub(super) struct Chat {
        pub conversation: Conversation,
        pub dir: DataDir,
        transport: Arc<Scripted>,
    }

    impl Chat {
        /// One scripted reply for each session id, in order.
        pub fn new<const N: usize>(name: &str, sessions: [&str; N]) -> Chat {
            let scripted = sessions.iter().fold(Scripted::new(), |scripted, id| {
                scripted.then(Script::lines(reply_lines(id, "mood: neutral\nHi")))
            });
            Chat::with_transport(name, scripted)
        }

        pub fn with_transport(name: &str, scripted: Scripted) -> Chat {
            Chat::in_dir(DataDir::scratch(name), scripted)
        }

        pub fn in_dir(dir: DataDir, scripted: Scripted) -> Chat {
            Chat {
                conversation: Conversation::new(dir.clone()),
                dir,
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
            Session::load(&self.dir)
                .unwrap()
                .expect("a session was saved")
        }

        pub fn edit_session(&self, change: impl FnOnce(&mut Session)) {
            let mut session = self.saved_session();
            change(&mut session);
            session.save(&self.dir).unwrap();
        }
    }
}
