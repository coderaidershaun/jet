//! The error every chat command fails with, sent to the page as a kind and a message.

use agent::{ConversationError, Failure, MemoryError, TransportError, TurnError};
use serde::Serialize;

use super::image::ImageError;
use crate::settings;

/// Why a command failed. The page reads `kind` to decide what to show.
#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    #[error("Jet is still answering")]
    Busy,
    #[error("{0}")]
    ClaudeMissing(String),
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    BadLink(String),
}

impl BridgeError {
    fn kind(&self) -> &'static str {
        match self {
            BridgeError::Busy => "busy",
            BridgeError::ClaudeMissing(_) => "claudeMissing",
            BridgeError::Io(_) => "io",
            BridgeError::BadLink(_) => "badLink",
        }
    }
}

impl Serialize for BridgeError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("BridgeError", 2)?;
        state.serialize_field("kind", self.kind())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

impl From<ConversationError> for BridgeError {
    fn from(error: ConversationError) -> BridgeError {
        match error {
            ConversationError::Busy => BridgeError::Busy,
            ConversationError::Memory(error) => error.into(),
        }
    }
}

impl From<MemoryError> for BridgeError {
    fn from(error: MemoryError) -> BridgeError {
        BridgeError::Io(error.to_string())
    }
}

impl From<ImageError> for BridgeError {
    fn from(error: ImageError) -> BridgeError {
        BridgeError::Io(error.to_string())
    }
}

impl From<settings::SettingsError> for BridgeError {
    fn from(error: settings::SettingsError) -> BridgeError {
        BridgeError::Io(error.to_string())
    }
}

impl From<TransportError> for BridgeError {
    fn from(error: TransportError) -> BridgeError {
        let failure = Failure::from(&TurnError::from(error));
        match failure {
            Failure::ClaudeMissing { message } => BridgeError::ClaudeMissing(message),
            other => BridgeError::Io(other.message().to_owned()),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn bridge_error_serialises_as_kind_and_message() {
        let cases = [
            (
                BridgeError::Busy,
                json!({"kind": "busy", "message": "Jet is still answering"}),
            ),
            (
                BridgeError::ClaudeMissing("not found".into()),
                json!({"kind": "claudeMissing", "message": "not found"}),
            ),
            (
                BridgeError::Io("disk full".into()),
                json!({"kind": "io", "message": "disk full"}),
            ),
            (
                BridgeError::BadLink("nope".into()),
                json!({"kind": "badLink", "message": "nope"}),
            ),
        ];
        for (error, expected) in cases {
            assert_eq!(serde_json::to_value(&error).unwrap(), expected);
        }
        let from_agent = BridgeError::from(ConversationError::Busy);
        assert_eq!(serde_json::to_value(&from_agent).unwrap()["kind"], "busy");
    }
}
