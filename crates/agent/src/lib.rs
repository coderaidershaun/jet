//! Keep Jet's conversations, provider processes and library connections independent of the window.

pub mod apps;
mod chat;
mod child;
mod conversation;
mod feeling;
mod markdown;
pub mod mcp;
mod memory;
mod turn;

pub use chat::{
    Effort, Entry, EntryId, EntryStatus, Event, FACADE_TOOLS, Failure, MEMORY_LIMIT, McpConnection,
    McpStatus, Model, Mood, Notes, Persona, RECENT_LIMIT, Role, SessionId, ShownEntry, ToolCall,
    TurnIdentity, USER_LIMIT, Usage,
};
pub use conversation::{
    CacheStatus, Conversation, ConversationError, Message, Reply, ReviewError, ReviewOutcome,
};
pub use markdown::render_markdown;
pub use memory::{DataDir, MemoryError, now_ms};
pub use turn::{
    ClaudeCli, CodexCli, Lines, Request, SessionMode, Step, Stopper, Summary, Transport,
    TransportError, Turn, TurnError,
};

pub use feeling::{Feeling, FeelingSource, Jev, JevError, classify, feel_message};
