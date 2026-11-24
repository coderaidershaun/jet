//! An entry of the thread before the storage gives it its id.

use crate::chat::{Attachment, Entry, EntryId, EntryStatus, Mood, Role, ToolCall, TurnIdentity};

/// An entry before it has an id and a time.
pub struct NewEntry {
    pub turn: Option<TurnIdentity>,
    pub role: Role,
    pub text: String,
    pub attachments: Vec<Attachment>,
    pub mood: Option<Mood>,
    pub status: EntryStatus,
    pub error: Option<String>,
    pub tools: Vec<ToolCall>,
}

impl NewEntry {
    /// A message the user wrote, with nothing else on it.
    pub fn user_text(text: &str) -> NewEntry {
        NewEntry {
            turn: None,
            role: Role::User,
            text: text.to_owned(),
            attachments: Vec::new(),
            mood: None,
            status: EntryStatus::Complete,
            error: None,
            tools: Vec::new(),
        }
    }

    /// The entry as saved, once it has its place in the thread and its time.
    pub fn into_entry(self, id: u64, at: u64) -> Entry {
        Entry {
            turn: self.turn,
            id: EntryId(id),
            role: self.role,
            text: self.text,
            attachments: self.attachments,
            mood: self.mood,
            status: self.status,
            error: self.error,
            tools: self.tools,
            reactions: Vec::new(),
            at,
        }
    }
}
