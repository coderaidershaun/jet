//! The data that crosses into the app or onto disk: the events a reply streams, the saved
//! thread entries, and the settings that shape the persona. The names and the JSON shapes
//! here are what the chat page reads, so change them with the page.

use serde::{Deserialize, Serialize};

/// The longest MEMORY note, in characters.
pub const MEMORY_LIMIT: usize = 2200;
/// The longest USER note, in characters.
pub const USER_LIMIT: usize = 1375;
/// The longest RECENT note, in characters.
pub const RECENT_LIMIT: usize = 1500;

/// Which Claude model answers the chat.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Model {
    Fable,
    Opus,
    #[default]
    Sonnet,
    Haiku,
}

impl Model {
    /// The name the Claude Code command line accepts.
    pub fn alias(self) -> &'static str {
        match self {
            Model::Fable => "fable",
            Model::Opus => "opus",
            Model::Sonnet => "sonnet",
            Model::Haiku => "haiku",
        }
    }
}

/// How hard Claude thinks before it answers.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    #[default]
    Medium,
    High,
}

impl Effort {
    /// The name the Claude Code command line accepts.
    pub fn alias(self) -> &'static str {
        match self {
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
        }
    }
}

/// How Jet feels in a reply. The first line of every reply names one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mood {
    Neutral,
    Happy,
    Excited,
    Thinking,
    Curious,
    Sorry,
    Alert,
    Annoyed,
    Hello,
}

impl Mood {
    pub const ALL: [Mood; 9] = [
        Mood::Neutral,
        Mood::Happy,
        Mood::Excited,
        Mood::Thinking,
        Mood::Curious,
        Mood::Sorry,
        Mood::Alert,
        Mood::Annoyed,
        Mood::Hello,
    ];

    /// The word Claude writes on the mood line.
    pub fn word(self) -> &'static str {
        match self {
            Mood::Neutral => "neutral",
            Mood::Happy => "happy",
            Mood::Excited => "excited",
            Mood::Thinking => "thinking",
            Mood::Curious => "curious",
            Mood::Sorry => "sorry",
            Mood::Alert => "alert",
            Mood::Annoyed => "annoyed",
            Mood::Hello => "hello",
        }
    }

    /// Finds the mood for a word, ignoring case. `None` for a word outside the list.
    pub fn from_word(word: &str) -> Option<Mood> {
        Mood::ALL
            .into_iter()
            .find(|mood| mood.word().eq_ignore_ascii_case(word))
    }
}

/// Who Jet is, as the user set it up.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Persona {
    pub name: String,
    pub job_title: String,
    pub notes: String,
}

impl Default for Persona {
    fn default() -> Self {
        Persona {
            name: "Jet".into(),
            job_title: "First-mate".into(),
            notes: String::new(),
        }
    }
}

/// Position on the behaviour wheel. Both axes run -1 to 1.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Tone {
    pub candid: f64,
    pub playful: f64,
}

impl Default for Tone {
    fn default() -> Self {
        Tone {
            candid: 0.55,
            playful: 0.35,
        }
    }
}

/// The three notes Jet carries between conversations.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Notes {
    pub memory: String,
    pub user: String,
    pub recent: String,
}

/// Claude Code's own name for a conversation.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(pub String);

/// Position of an entry in the thread. The first entry is 1.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EntryId(pub(crate) u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Jet,
}

/// How a Jet reply ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryStatus {
    Complete,
    Stopped,
    Failed,
}

/// One message in the saved thread. `at` is Unix milliseconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: EntryId,
    pub role: Role,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mood: Option<Mood>,
    pub status: EntryStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub at: u64,
}

/// An entry plus its text rendered as HTML (empty for the user's own entries).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ShownEntry {
    #[serde(flatten)]
    pub entry: Entry,
    pub html: String,
}

/// Token counts of one request, as Claude Code reports them. They show whether the
/// prompt cache was warm.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_creation_1h_tokens: u64,
}

/// Why a reply failed. The message is written for the user and shown as it stands.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Failure {
    ClaudeMissing { message: String },
    ClaudeFailed { message: String },
    Timeout { message: String },
    Io { message: String },
}

impl Failure {
    pub fn message(&self) -> &str {
        match self {
            Failure::ClaudeMissing { message }
            | Failure::ClaudeFailed { message }
            | Failure::Timeout { message }
            | Failure::Io { message } => message,
        }
    }
}

/// One step of a streamed reply. Exactly one of `Finished`, `Failed` and `Stopped` ends it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    /// A line from Claude Code, untouched, sent before the typed events made from it.
    RawLine {
        line: String,
    },
    Started {
        session_id: SessionId,
        model: String,
        fresh: bool,
    },
    /// At most once, before the first `Text`.
    Mood {
        mood: Mood,
    },
    /// Reply text with the mood line already removed.
    Text {
        delta: String,
    },
    /// A fresh conversation began for a reason the user should hear about.
    Notice {
        message: String,
    },
    Finished {
        entry: ShownEntry,
        duration_ms: u64,
        cost_usd: f64,
        usage: Usage,
    },
    Failed {
        failure: Failure,
        entry: ShownEntry,
    },
    Stopped {
        entry: ShownEntry,
    },
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{Conversation, DataDir};

    fn jet_entry(id: u64, status: EntryStatus) -> ShownEntry {
        let entry = Entry {
            id: EntryId(id),
            role: Role::Jet,
            text: "Friday looks fine".into(),
            mood: None,
            status,
            error: None,
            at: 1_760_433_360_000,
        };
        let html = "<p>Friday looks fine</p>".into();
        ShownEntry { entry, html }
    }

    #[test]
    fn event_json_matches_the_ui_contract() {
        let text = || "m".to_owned();
        let excited = Mood::Excited;
        let mut complete = jet_entry(42, EntryStatus::Complete);
        complete.entry.mood = Some(excited);
        let stopped = jet_entry(44, EntryStatus::Stopped);
        let mut cases = vec![
            (
                Event::RawLine { line: text() },
                json!({"kind": "rawLine", "line": "m"}),
            ),
            (
                Event::Started {
                    session_id: SessionId("5b0c".into()),
                    model: "claude-sonnet-5-5".into(),
                    fresh: true,
                },
                json!({"kind": "started", "sessionId": "5b0c", "model": "claude-sonnet-5-5",
                       "fresh": true}),
            ),
            (
                Event::Notice { message: text() },
                json!({"kind": "notice", "message": "m"}),
            ),
            (
                Event::Mood { mood: excited },
                json!({"kind": "mood", "mood": "excited"}),
            ),
            (
                Event::Text { delta: text() },
                json!({"kind": "text", "delta": "m"}),
            ),
            (
                Event::Finished {
                    entry: complete,
                    duration_ms: 4210,
                    cost_usd: 0.0123,
                    usage: Usage {
                        input_tokens: 812,
                        cache_read_tokens: 40210,
                        cache_creation_tokens: 0,
                        cache_creation_1h_tokens: 7,
                    },
                },
                json!({
                    "kind": "finished",
                    "entry": {"id": 42, "role": "jet", "text": "Friday looks fine",
                              "html": "<p>Friday looks fine</p>", "mood": "excited",
                              "status": "complete", "at": 1_760_433_360_000_u64},
                    "durationMs": 4210,
                    "costUsd": 0.0123,
                    "usage": {"inputTokens": 812, "cacheReadTokens": 40210,
                              "cacheCreationTokens": 0, "cacheCreation1hTokens": 7}
                }),
            ),
            (
                Event::Stopped { entry: stopped },
                json!({
                    "kind": "stopped",
                    "entry": {"id": 44, "role": "jet", "text": "Friday looks fine",
                              "html": "<p>Friday looks fine</p>", "status": "stopped",
                              "at": 1_760_433_360_000_u64}
                }),
            ),
        ];
        let failures = [
            (Failure::ClaudeMissing { message: text() }, "claudeMissing"),
            (Failure::ClaudeFailed { message: text() }, "claudeFailed"),
            (Failure::Timeout { message: text() }, "timeout"),
            (Failure::Io { message: text() }, "io"),
        ];
        for (failure, kind) in failures {
            let mut entry = jet_entry(43, EntryStatus::Failed);
            entry.entry.error = Some(text());
            cases.push((
                Event::Failed { failure, entry },
                json!({
                    "kind": "failed",
                    "failure": {"kind": kind, "message": "m"},
                    "entry": {"id": 43, "role": "jet", "text": "Friday looks fine",
                              "html": "<p>Friday looks fine</p>", "status": "failed",
                              "error": "m", "at": 1_760_433_360_000_u64}
                }),
            ));
        }
        for (event, expected) in cases {
            assert_eq!(serde_json::to_value(&event).unwrap(), expected);
        }

        let conversation = Conversation::new(DataDir::scratch("cache-never"));
        let never = serde_json::to_value(conversation.cache_status().unwrap()).unwrap();
        let expected = json!({"lastRequestAt": null, "ttlMinutes": 60, "contextTokens": 0});
        assert_eq!(never, expected);
    }
}
