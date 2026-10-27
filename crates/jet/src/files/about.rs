//! What Jet knows about a file without reading it: its name, size and a few details such as
//! pages or rows. Uploads get their details once, when they arrive, and keep them beside the file.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::kind::FileKind;

/// Where a file came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Origin {
    /// The user attached it to a message.
    Upload,
    /// Jet wrote it for the user.
    Export,
}

/// A file, as the page and Jet are told about it. It is also what is saved beside an upload.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct About {
    pub id: Uuid,
    pub name: String,
    pub kind: FileKind,
    pub bytes: u64,
    /// Pages, sheets, rows or pixel size. Empty for a file Jet wrote.
    pub details: String,
    pub origin: Origin,
    /// Whether the message that carries it was sent. Jet sees a file only after that.
    pub attached: bool,
    /// Unix milliseconds.
    pub at: u64,
}

impl About {
    /// The part of this that goes into a message.
    pub fn attachment(&self) -> agent::Attachment {
        agent::Attachment {
            id: self.id.to_string(),
            name: self.name.clone(),
            kind: self.kind.word().to_owned(),
            bytes: self.bytes,
            details: self.details.clone(),
        }
    }
}
