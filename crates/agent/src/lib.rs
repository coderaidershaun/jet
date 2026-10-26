//! Keep Jet's conversations, provider processes and library connections independent of the window.
//! Tests stand in for a provider with `crate::turn::scripted`.

pub mod apps;
mod chat;
mod conversation;
mod feeling;
pub mod mcp;
mod turn;

pub use chat::{
    ContextStatus, Effort, Entry, EntryId, EntryStatus, Event, FACADE_TOOLS, Failure, MEMORY_LIMIT,
    McpConnection, Model, Mood, Notes, Persona, RECENT_LIMIT, Role, SessionId, ShownEntry,
    ToolCall, TurnIdentity, USER_LIMIT,
};
pub use conversation::{
    Conversation, ConversationError, DataDir, MemoryError, Message, Reply, ReviewError,
    ReviewOutcome, now_ms, render_markdown,
};
pub use feeling::{Feeling, JevError, feel_message};
pub use turn::{
    ClaudeCli, CodexCli, Lines, Request, SessionMode, Step, Stopper, Summary, Transport,
    TransportError, Turn, TurnError,
};
