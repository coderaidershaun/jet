//! `session.json`: which Claude Code conversation the thread continues, when it was last
//! used, and how far the notes review has read.

use serde::{Deserialize, Serialize};

use super::{DataDir, MemoryError};
use crate::chat::{EntryId, SessionId};

const FILE_NAME: &str = "session.json";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Session {
    /// Empty when Claude lost the conversation, so the next message must start a fresh one.
    pub session_id: SessionId,
    pub started_at: u64,
    pub last_request_at: u64,
    /// Tokens Claude read for the last reply: what a cold restart would have to re-read.
    pub context_tokens: u64,
    /// Fingerprint of the prompt inputs the session started with. Empty marks it stale.
    pub prompt_hash: String,
    /// The last thread entry the notes review has covered.
    pub reviewed_through: EntryId,
    /// Unix milliseconds of the last review, 0 for never.
    pub reviewed_at: u64,
}

impl Session {
    pub(crate) fn load(dir: &DataDir) -> Result<Option<Session>, MemoryError> {
        let Some(text) = dir.read(FILE_NAME)? else {
            return Ok(None);
        };
        serde_json::from_str(&text)
            .map(Some)
            .map_err(|source| MemoryError::Json {
                path: dir.path(FILE_NAME),
                line: source.line(),
                source,
            })
    }

    pub(crate) fn save(&self, dir: &DataDir) -> Result<(), MemoryError> {
        let text = serde_json::to_string_pretty(self).map_err(|source| MemoryError::Json {
            path: dir.path(FILE_NAME),
            line: 0,
            source,
        })?;
        dir.write(FILE_NAME, &text)
    }

    pub(crate) fn delete(dir: &DataDir) -> Result<(), MemoryError> {
        dir.remove(FILE_NAME)
    }

    pub(crate) fn has_conversation(&self) -> bool {
        !self.session_id.0.is_empty()
    }

    /// The same record with no conversation to resume. How far the review has read stays.
    pub(crate) fn without_conversation(self) -> Session {
        Session {
            session_id: SessionId::default(),
            ..self
        }
    }
}
