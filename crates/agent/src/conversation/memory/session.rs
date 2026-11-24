//! Which provider conversation the thread continues, when it was last used, and how far the
//! notes review has read.

use serde::{Deserialize, Serialize};

use crate::chat::{EntryId, SessionId};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    /// Empty when Claude lost the conversation, so the next message must start a fresh one.
    pub session_id: SessionId,
    pub last_request_at: u64,
    /// Tokens Claude read for the last reply: what a cold restart would have to re-read.
    pub context_tokens: u64,
    pub context: crate::chat::ContextStatus,
    /// Fingerprint of the prompt inputs the session started with. Empty marks it stale.
    pub prompt_hash: String,
    /// The last thread entry the notes review has covered.
    pub reviewed_through: EntryId,
    /// Unix milliseconds of the last review, 0 for never.
    pub reviewed_at: u64,
}

impl Session {
    pub(crate) fn has_conversation(&self) -> bool {
        !self.session_id.0.is_empty()
    }

    /// The same record with no conversation to resume. How far the review has read stays.
    pub(crate) fn without_conversation(self) -> Session {
        Session {
            session_id: SessionId::default(),
            context: crate::chat::ContextStatus::default(),
            ..self
        }
    }
}
