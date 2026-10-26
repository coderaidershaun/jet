//! Decides whether a new message continues the saved Claude conversation or starts a fresh
//! one. A fresh one is started when the user changed something baked into the prompt, when
//! Claude lost the saved one, or when it has gone cold and would be expensive to read back.

use super::memory::Session;
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
    use super::super::Message;
    use super::super::memory::now_ms;
    use super::super::test_support::{Chat, message};
    use super::*;
    use crate::chat::{Event, McpConnection, Model, Persona, SessionId};

    const APP_ID: &str = "b5e97310-4825-4b89-ace2-e330a4ed8509";

    fn connected(text: &str, token: &str) -> Message {
        Message {
            mcp: Some(McpConnection {
                url: "http://localhost/mcp".into(),
                token: token.into(),
            }),
            ..message(text)
        }
    }

    fn notices(events: &[Event]) -> usize {
        events
            .iter()
            .filter(|event| matches!(event, Event::Notice { .. }))
            .count()
    }

    #[test]
    fn stale_prompt_starts_a_fresh_session() {
        type Case = (&'static str, fn(&mut Session), fn(&mut Message), bool);
        let cases: [Case; 6] = [
            ("only the browser connection changed", |_| {}, |_| {}, false),
            (
                "persona changed",
                |_| {},
                |message| {
                    message.persona = Persona {
                        name: "Ada".into(),
                        ..Persona::default()
                    }
                },
                true,
            ),
            (
                "model changed",
                |_| {},
                |message| message.model = Model::Opus,
                true,
            ),
            (
                "gone cold while big",
                |session| {
                    session.last_request_at = now_ms() - COLD_AFTER_MS - 1000;
                    session.context_tokens = COLD_CONTEXT_TOKENS;
                },
                |_| {},
                true,
            ),
            (
                "warm while big",
                |session| {
                    session.last_request_at = now_ms() - 10 * 60 * 1000;
                    session.context_tokens = 200_000;
                },
                |_| {},
                false,
            ),
            (
                "gone cold while small",
                |session| {
                    session.last_request_at = now_ms() - 3 * 60 * 60 * 1000;
                    session.context_tokens = COLD_CONTEXT_TOKENS - 1;
                },
                |_| {},
                false,
            ),
        ];
        for (number, (name, edit_session, edit_message, fresh)) in cases.into_iter().enumerate() {
            let chat = Chat::new(&format!("policy-{number}"), ["old-session", "new-session"]);
            let first = chat.send(connected("hello", "first"));
            assert_eq!(notices(&first), 0, "the very first session needs no notice");
            chat.edit_session(edit_session);
            let mut next = connected("hello again", "second");
            next.active_app_id = Some(APP_ID.parse().unwrap());
            edit_message(&mut next);
            let events = chat.send(next);

            let requests = chat.requests();
            let expected = if fresh {
                SessionMode::New
            } else {
                SessionMode::Resume(SessionId("old-session".into()))
            };
            assert_eq!(requests[1].session, expected, "{name}");
            assert_eq!(
                requests[1].prompt.starts_with("[local time: "),
                fresh,
                "{name}"
            );
            assert!(requests[1].prompt.contains("b5e97310"), "{name}");
            assert!(!requests[1].system_prompt.contains("[local time"), "{name}");
            if !fresh {
                assert_eq!(
                    requests[1].system_prompt, requests[0].system_prompt,
                    "{name}"
                );
            }
            let started = events.iter().find_map(|event| match event {
                Event::Started { fresh } => Some(*fresh),
                _ => None,
            });
            assert_eq!(started, Some(fresh), "{name}");
            assert_eq!(notices(&events), usize::from(fresh), "{name}");
        }
    }
}
