//! The error every chat command fails with, sent to the page as a kind and a message.

use agent::{ConversationError, Failure, McpError, MemoryError, TransportError, TurnError};
use serde::Serialize;

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
    /// A library call the page made failed, in words the page can show on the engine card.
    #[error("{0}")]
    Library(String),
}

impl BridgeError {
    fn kind(&self) -> &'static str {
        match self {
            BridgeError::Busy => "busy",
            BridgeError::ClaudeMissing(_) => "claudeMissing",
            BridgeError::Io(_) => "io",
            BridgeError::BadLink(_) => "badLink",
            BridgeError::Library(_) => "library",
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

impl From<McpError> for BridgeError {
    fn from(error: McpError) -> BridgeError {
        BridgeError::Library(error.to_string())
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
            (
                BridgeError::Library("not shared".into()),
                json!({"kind": "library", "message": "not shared"}),
            ),
        ];
        for (error, expected) in cases {
            assert_eq!(serde_json::to_value(&error).unwrap(), expected);
        }
        let from_agent = BridgeError::from(ConversationError::Busy);
        assert_eq!(serde_json::to_value(&from_agent).unwrap()["kind"], "busy");
        let from_server = BridgeError::from(McpError::Tool("strat-x is not running".into()));
        assert_eq!(
            serde_json::to_value(&from_server).unwrap(),
            json!({"kind": "library", "message": "strat-x is not running"})
        );
    }
}
