//! Keep Jet's conversations, provider processes and library connections independent of the window.
//! Tests stand in for a provider with `crate::turn::scripted`.

pub mod apps;
mod chat;
mod conversation;
mod env_file;
mod feeling;
mod markdown;
pub mod mcp;
#[cfg(test)]
mod test_server;
mod turn;
pub mod voice;

pub use chat::{
    Attachment, ContextStatus, Effort, Entry, EntryId, EntryStatus, Event, FACADE_TOOLS, Failure,
    MEMORY_LIMIT, McpConnection, Model, Mood, Notes, Persona, RECENT_LIMIT, Role, SessionId,
    ShownEntry, TOOL_USE_META, TURN_HEADER, ToolCall, ToolStart, TurnIdentity, USER_LIMIT,
};
pub use conversation::{
    Conversation, ConversationError, DataDir, MemoryError, Message, REVIEW_QUIET, Reply,
    ReviewError, ReviewOutcome, now_ms,
};
pub use feeling::{Feeling, JevError, feel_message};
pub use markdown::{CUES, Cue, dollar_math, render_markdown};
pub use turn::{
    ClaudeCli, CodexCli, Lines, Request, SessionMode, Step, Stopper, Summary, Transport,
    TransportError, Turn, TurnError,
};

/// Locks `mutex`. A lock that a panic poisoned is still usable: none of ours guards a value that a
/// panic can leave half written.
fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
