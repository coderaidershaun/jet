//! The app and saved conversations share these data types so event and file formats stay consistent.

mod model;
mod tools;
mod usage;

use serde::{Deserialize, Serialize};

pub use model::{Effort, Model};
pub use tools::{McpServer, McpServers, McpStatus, ToolCall};
pub(crate) use tools::{content_text, content_value};
pub use usage::Usage;

// SMELL: the review prompt and the chat page repeat these three numbers; change them together.
/// The longest MEMORY note, in characters.
pub const MEMORY_LIMIT: usize = 2200;
/// The longest USER note, in characters.
pub const USER_LIMIT: usize = 1375;
/// The longest RECENT note, in characters.
pub const RECENT_LIMIT: usize = 1500;

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

    /// The word the model writes on the mood line.
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

/// The provider's own name for a conversation.
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
    /// The MCP tool calls that came back during the reply. Older lines have none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolCall>,
    pub at: u64,
}

/// An entry plus its text rendered as HTML (empty for the user's own entries).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ShownEntry {
    #[serde(flatten)]
    pub entry: Entry,
    pub html: String,
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
    /// A transport line sent before the typed events made from it.
    RawLine {
        line: String,
    },
    Started {
        session_id: SessionId,
        model: String,
        fresh: bool,
        /// Each MCP server and its state when the reply started.
        mcp: Vec<McpStatus>,
    },
    /// At most once, before the first `Text`.
    Mood {
        mood: Mood,
    },
    /// Reply text with the mood line already removed.
    Text {
        delta: String,
    },
    /// The model called a library tool; it is running now. A call still running when the reply
    /// ends gets no `ToolFinished`, and the saved entry keeps only finished calls.
    ToolStarted {
        id: String,
        server: String,
        tool: String,
        input: serde_json::Value,
    },
    /// The call with this `id` came back.
    ToolFinished {
        id: String,
        server: String,
        tool: String,
        ok: bool,
        result: serde_json::Value,
        summary: String,
        duration_ms: u64,
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

    fn jet_entry(id: u64, status: EntryStatus) -> ShownEntry {
        let entry = Entry {
            id: EntryId(id),
            role: Role::Jet,
            text: "Friday looks fine".into(),
            mood: None,
            status,
            error: None,
            tools: Vec::new(),
            at: 1_760_433_360_000,
        };
        let html = "<p>Friday looks fine</p>".into();
        ShownEntry { entry, html }
    }

    fn quanty_search() -> ToolCall {
        ToolCall {
            id: "toolu_1".into(),
            server: "quanty".into(),
            tool: "search".into(),
            input: json!({"question": "What is vega?"}),
            ok: true,
            result: json!({"results": [1, 2]}),
            summary: "quanty · search · 2 results".into(),
            duration_ms: 950,
        }
    }

    #[test]
    fn event_json_matches_the_ui_contract() {
        let text = || "m".to_owned();
        let excited = Mood::Excited;
        let mut complete = jet_entry(42, EntryStatus::Complete);
        complete.entry.mood = Some(excited);
        complete.entry.tools = vec![quanty_search()];
        let call = quanty_search();
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
                    mcp: vec![McpStatus {
                        name: "quanty".into(),
                        status: "connected".into(),
                    }],
                },
                json!({"kind": "started", "sessionId": "5b0c", "model": "claude-sonnet-5-5",
                       "fresh": true, "mcp": [{"name": "quanty", "status": "connected"}]}),
            ),
            (
                Event::ToolStarted {
                    id: call.id.clone(),
                    server: call.server.clone(),
                    tool: call.tool.clone(),
                    input: call.input.clone(),
                },
                json!({"kind": "toolStarted", "id": "toolu_1", "server": "quanty",
                       "tool": "search", "input": {"question": "What is vega?"}}),
            ),
            (
                Event::ToolFinished {
                    id: call.id.clone(),
                    server: call.server.clone(),
                    tool: call.tool.clone(),
                    ok: call.ok,
                    result: call.result.clone(),
                    summary: call.summary.clone(),
                    duration_ms: call.duration_ms,
                },
                json!({"kind": "toolFinished", "id": "toolu_1", "server": "quanty",
                       "tool": "search", "ok": true, "result": {"results": [1, 2]},
                       "summary": "quanty · search · 2 results", "durationMs": 950}),
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
                        output_tokens: 391,
                        thinking_tokens: 120,
                        model: "claude-sonnet-5-5".into(),
                    },
                },
                json!({
                    "kind": "finished",
                    "entry": {"id": 42, "role": "jet", "text": "Friday looks fine",
                              "html": "<p>Friday looks fine</p>", "mood": "excited",
                              "status": "complete", "at": 1_760_433_360_000_u64,
                              "tools": [{"id": "toolu_1", "server": "quanty", "tool": "search",
                                         "input": {"question": "What is vega?"}, "ok": true,
                                         "result": {"results": [1, 2]},
                                         "summary": "quanty · search · 2 results",
                                         "durationMs": 950}]},
                    "durationMs": 4210,
                    "costUsd": 0.0123,
                    "usage": {"inputTokens": 812, "cacheReadTokens": 40210,
                              "cacheCreationTokens": 0, "cacheCreation1hTokens": 7,
                              "outputTokens": 391, "thinkingTokens": 120,
                              "model": "claude-sonnet-5-5"}
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
    }
}
