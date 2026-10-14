//! Talks to Claude Code for Jet's chat: runs a turn, keeps the thread and notes, composes
//! who Jet is, and renders replies. It knows nothing about the window around it.

mod chat;
mod conversation;
mod markdown;
mod memory;
mod turn;

pub use chat::{
    Effort, Entry, EntryId, EntryStatus, Event, Failure, MEMORY_LIMIT, Model, Mood, Notes, Persona,
    RECENT_LIMIT, Role, SessionId, ShownEntry, Tone, USER_LIMIT, Usage,
};
pub use conversation::{
    CacheStatus, Conversation, ConversationError, Message, Reply, ReviewError, ReviewOutcome,
};
pub use markdown::render_markdown;
pub use memory::{DataDir, MemoryError, now_ms};
pub use turn::{
    ClaudeCli, Lines, Request, SessionMode, Step, Stopper, Summary, Transport, TransportError,
    Turn, TurnError,
};
