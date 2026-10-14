//! The chat as the app sees it: send a message and read the streamed answer, show and
//! forget the thread, edit the notes, and let the review keep them current.

mod persona;
mod reply;
mod review;
mod session_policy;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

pub use reply::Reply;
pub use review::{ReviewError, ReviewOutcome};
use session_policy::decide;

use crate::chat::{Effort, Entry, Model, Notes, Persona, Role, ShownEntry, Tone};
use crate::markdown::render_markdown;
use crate::memory::{DataDir, MemoryError, NewEntry, Session, Transcript, now_ms};
use crate::turn::{Request, SessionMode, Transport, Turn};

/// How long Claude's prompt cache stays warm, in minutes.
const CACHE_TTL_MINUTES: u64 = 60;

/// Everything one message brings with it.
#[derive(Debug, Clone)]
pub struct Message {
    pub text: String,
    pub persona: Persona,
    pub tone: Tone,
    pub model: Model,
    pub effort: Effort,
    /// The most one answer may cost.
    pub budget_usd: f64,
    /// The user's clock, for example `Tue 14 Oct 2026, 09:16`.
    pub local_time: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ConversationError {
    #[error("Jet is still answering")]
    Busy,
    #[error(transparent)]
    Memory(#[from] MemoryError),
}

/// Whether the next reply will find Claude's prompt cache warm.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStatus {
    /// Unix milliseconds of the last request, or `None` before the first one.
    pub last_request_at: Option<u64>,
    pub ttl_minutes: u64,
    pub context_tokens: u64,
}

/// The saved thread and notes, and the right to run one answer and one review at a time.
#[derive(Debug, Clone)]
pub struct Conversation {
    dir: DataDir,
    answering: Arc<AtomicBool>,
    reviewing: Arc<AtomicBool>,
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
        }
    }

    pub fn is_busy(&self) -> bool {
        self.answering.load(Ordering::SeqCst)
    }

    /// Saves the user's message and starts the answer. The returned `Reply` streams the
    /// events; the conversation stays busy until it is dropped. Even when Claude cannot
    /// be started, the failure comes out of the `Reply`, as it does for any other.
    pub fn send(
        &self,
        transport: Arc<dyn Transport>,
        message: Message,
    ) -> Result<(ShownEntry, Reply), ConversationError> {
        let claim = Claim::take(&self.answering).ok_or(ConversationError::Busy)?;
        let now = now_ms();
        let notes = Notes::load(&self.dir)?;
        let prompt_hash = persona::prompt_hash(
            &message.persona,
            &message.tone,
            message.model,
            message.effort,
        );
        let saved = Session::load(&self.dir)?;
        let decision = decide(saved.as_ref(), &prompt_hash, now);

        let user_entry = Transcript::open(&self.dir).append(NewEntry::user(&message.text), now)?;
        let prompt = match decision.mode {
            SessionMode::New => reply::first_message(&message.local_time, &message.text),
            _ => message.text.clone(),
        };
        let request = Request {
            prompt,
            system_prompt: persona::compose(&message.persona, &message.tone, &notes),
            model: message.model,
            effort: message.effort,
            budget_usd: message.budget_usd,
            session: decision.mode,
            schema: None,
        };
        let started = Turn::start(&*transport, &request);
        let context = reply::Context {
            dir: self.dir.clone(),
            transport,
            request,
            text: message.text,
            local_time: message.local_time,
            notice: decision
                .reason
                .and_then(|reason| reason.notice(&message.persona.name)),
            persona_name: message.persona.name,
            prompt_hash,
            saved,
        };
        Ok((shown(user_entry), Reply::new(context, claim, started)))
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

    pub fn cache_status(&self) -> Result<CacheStatus, MemoryError> {
        let session = Session::load(&self.dir)?.unwrap_or_default();
        Ok(CacheStatus {
            last_request_at: Some(session.last_request_at).filter(|&at| at > 0),
            ttl_minutes: CACHE_TTL_MINUTES,
            context_tokens: session.context_tokens,
        })
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
            persona: Persona::default(),
            tone: Tone::default(),
            model: Model::Sonnet,
            effort: Effort::Medium,
            budget_usd: 1.0,
            local_time: "Tue 14 Oct 2026, 11:20".to_owned(),
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
                .send(self.transport.clone(), message)
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn cache_status_json_matches_the_ui_contract() {
        let conversation = Conversation::new(DataDir::scratch("cache-never"));
        let never = serde_json::to_value(conversation.cache_status().unwrap()).unwrap();
        let expected = json!({"lastRequestAt": null, "ttlMinutes": 60, "contextTokens": 0});
        assert_eq!(never, expected);
    }
}
