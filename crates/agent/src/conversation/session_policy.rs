//! Decides whether a new message continues the saved Claude conversation or starts a fresh
//! one. A fresh one is started when the user changed something baked into the prompt, when
//! Claude lost the saved one, or when it has gone cold and would be expensive to read back.

use crate::memory::Session;
use crate::turn::SessionMode;

/// Claude keeps its prompt cache for an hour. A little earlier, a resume stops being cheap.
const COLD_AFTER_MS: u64 = 55 * 60 * 1000;

/// Below this size, reading a cold conversation back in costs too little to matter.
const COLD_CONTEXT_TOKENS: u64 = 30_000;

/// Why a conversation began again from nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FreshReason {
    /// There was no conversation yet. Nothing to explain.
    First,
    /// Something baked into the prompt changed, such as the persona, model, effort or libraries,
    /// or the user edited the notes.
    Stale,
    Cold,
    /// Claude Code no longer has the saved conversation.
    Vanished,
}

pub(super) struct Decision {
    pub mode: SessionMode,
    pub reason: Option<FreshReason>,
}

pub(super) fn decide(saved: Option<&Session>, prompt_hash: &str, now_ms: u64) -> Decision {
    let fresh = |reason| Decision {
        mode: SessionMode::New,
        reason: Some(reason),
    };
    let Some(saved) = saved else {
        return fresh(FreshReason::First);
    };
    let idle_ms = now_ms.saturating_sub(saved.last_request_at);
    if saved.prompt_hash != prompt_hash {
        fresh(FreshReason::Stale)
    } else if !saved.has_conversation() {
        fresh(FreshReason::Vanished)
    } else if idle_ms >= COLD_AFTER_MS && saved.context_tokens >= COLD_CONTEXT_TOKENS {
        fresh(FreshReason::Cold)
    } else {
        Decision {
            mode: SessionMode::Resume(saved.session_id.clone()),
            reason: None,
        }
    }
}

impl FreshReason {
    /// What the user is told, or `None` when there is nothing to tell.
    pub(super) fn notice(self, name: &str) -> Option<String> {
        let why = match self {
            FreshReason::First => return None,
            FreshReason::Stale => "Started a fresh conversation so your changes apply.",
            FreshReason::Cold => "Started a fresh conversation after a long break.",
            FreshReason::Vanished => "Couldn't find the last conversation, so started a fresh one.",
        };
        Some(format!("{why} {name}'s memory is kept."))
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{Chat, message};
    use super::*;
    use crate::chat::{Event, Persona, SessionId};
    use crate::memory::now_ms;

    fn notices(events: &[Event]) -> Vec<&str> {
        events
            .iter()
            .filter_map(|event| match event {
                Event::Notice { message } => Some(message.as_str()),
                _ => None,
            })
            .collect()
    }

    fn started(events: &[Event]) -> (&str, bool) {
        events
            .iter()
            .find_map(|event| match event {
                Event::Started {
                    session_id, fresh, ..
                } => Some((session_id.0.as_str(), *fresh)),
                _ => None,
            })
            .expect("a reply always starts")
    }

    #[test]
    fn stale_prompt_starts_a_fresh_session() {
        let chat = Chat::new("policy-stale", ["old-session", "new-session"]);
        let first = chat.send(message("hello"));
        assert!(
            notices(&first).is_empty(),
            "the very first session needs no notice"
        );

        let mut changed = message("hello again");
        changed.persona = Persona {
            name: "Ada".into(),
            ..Persona::default()
        };
        let events = chat.send(changed);

        assert_eq!(chat.requests()[1].session, SessionMode::New);
        assert!(chat.requests()[1].prompt.starts_with("[local time: "));
        assert_eq!(
            notices(&events),
            ["Started a fresh conversation so your changes apply. Ada's memory is kept."]
        );
        assert_eq!(started(&events), ("new-session", true));
        assert_eq!(chat.saved_session().session_id.0, "new-session");
    }

    #[test]
    fn cold_resume_starts_fresh_above_threshold() {
        let chat = Chat::new("policy-cold", ["old-session", "new-session"]);
        chat.send(message("hello"));
        chat.edit_session(|session| {
            session.last_request_at = now_ms() - COLD_AFTER_MS - 1000;
            session.context_tokens = COLD_CONTEXT_TOKENS;
        });
        let events = chat.send(message("still there?"));

        assert_eq!(chat.requests()[1].session, SessionMode::New);
        assert_eq!(
            notices(&events),
            ["Started a fresh conversation after a long break. Jet's memory is kept."]
        );
        assert_eq!(started(&events), ("new-session", true));
        assert_eq!(chat.saved_session().session_id.0, "new-session");
    }

    #[test]
    fn warm_or_small_sessions_resume() {
        let chat = Chat::new("policy-warm", ["old-session", "old-session", "old-session"]);
        chat.send(message("hello"));

        chat.edit_session(|session| {
            session.last_request_at = now_ms() - 10 * 60 * 1000;
            session.context_tokens = 200_000;
        });
        let warm = chat.send(message("warm and big"));

        chat.edit_session(|session| {
            session.last_request_at = now_ms() - 3 * 60 * 60 * 1000;
            session.context_tokens = COLD_CONTEXT_TOKENS - 1;
        });
        let cold_but_small = chat.send(message("cold and small"));

        let requests = chat.requests();
        for request in &requests[1..] {
            assert_eq!(
                request.session,
                SessionMode::Resume(SessionId("old-session".into()))
            );
            assert!(!request.prompt.contains("[local time"));
        }
        for events in [warm, cold_but_small] {
            assert!(notices(&events).is_empty());
            assert!(!started(&events).1, "a resumed session is not fresh");
        }
    }
}
