//! Keep Jet's conversations, provider processes and library connections independent of the window.

mod chat;
mod child;
mod conversation;
mod feeling;
mod markdown;
mod mcp;
mod memory;
mod turn;

pub use chat::{
    Effort, Entry, EntryId, EntryStatus, Event, Failure, MEMORY_LIMIT, McpServer, McpServers,
    McpStatus, Model, Mood, Notes, Persona, RECENT_LIMIT, Role, SessionId, ShownEntry, ToolCall,
    USER_LIMIT, Usage,
};
pub use conversation::{
    CacheStatus, Conversation, ConversationError, Message, Reply, ReviewError, ReviewOutcome,
};
pub use markdown::render_markdown;
pub use mcp::SharedServers;
pub use memory::{DataDir, MemoryError, now_ms};
pub use turn::{
    ClaudeCli, CodexCli, Lines, Request, SessionMode, Step, Stopper, Summary, Transport,
    TransportError, Turn, TurnError,
};

pub use feeling::{Feeling, FeelingSource, Jev, JevError, classify, feel_message};
