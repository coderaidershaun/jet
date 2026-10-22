//! The app and saved conversations share these data types so event and file formats stay consistent.

mod event;
mod model;
mod tools;
mod usage;

use serde::{Deserialize, Serialize};

pub use event::{Event, Failure};
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
    Hello,
    Insulted,
    #[serde(other)]
    Neutral,
}

impl Mood {
    pub const ALL: [Mood; 3] = [Mood::Neutral, Mood::Hello, Mood::Insulted];

    /// The word the model writes on the mood line.
    pub fn word(self) -> &'static str {
        match self {
            Mood::Neutral => "neutral",
            Mood::Hello => "hello",
            Mood::Insulted => "insulted",
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
