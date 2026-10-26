//! The error every chat command fails with, sent to the page as a kind and a message.

use agent::{ConversationError, Failure, MemoryError, TransportError, TurnError};
use serde::Serialize;

use crate::settings::SettingsError;

/// Why a command failed. The page reads `kind` to decide what to show.
#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    #[error("Jet is still answering")]
    Busy,
    #[error("{0}")]
    ClaudeMissing(String),
    #[error("{0}")]
    Io(String),
    #[error(transparent)]
    Memory(#[from] MemoryError),
    #[error(transparent)]
    Settings(#[from] SettingsError),
    #[error("request ID was already accepted with different content")]
    Conflict,
    #[error("request was cancelled before it started")]
    Cancelled,
    #[error("{0}")]
    InvalidRequest(String),
    #[error("server is shutting down")]
    ShuttingDown,
}

impl BridgeError {
    fn kind(&self) -> &'static str {
        match self {
            BridgeError::Busy => "busy",
            BridgeError::ClaudeMissing(_) => "claudeMissing",
            BridgeError::Io(_) | BridgeError::Memory(_) | BridgeError::Settings(_) => "io",
            BridgeError::Conflict => "conflict",
            BridgeError::Cancelled => "cancelled",
            BridgeError::InvalidRequest(_) => "invalidRequest",
            BridgeError::ShuttingDown => "shuttingDown",
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

impl From<TransportError> for BridgeError {
    fn from(error: TransportError) -> BridgeError {
        let failure = Failure::from(&TurnError::from(error));
        match failure {
            Failure::ClaudeMissing { message } => BridgeError::ClaudeMissing(message),
            other => BridgeError::Io(other.message().to_owned()),
        }
    }
}

impl axum::response::IntoResponse for BridgeError {
    fn into_response(self) -> axum::response::Response {
        use axum::http::StatusCode;
        let status = match self {
            Self::Busy | Self::Conflict | Self::Cancelled => StatusCode::CONFLICT,
            Self::InvalidRequest(_) => StatusCode::BAD_REQUEST,
            Self::ShuttingDown => StatusCode::SERVICE_UNAVAILABLE,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, axum::Json(self)).into_response()
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
        ];
        for (error, expected) in cases {
            assert_eq!(serde_json::to_value(&error).unwrap(), expected);
        }
        let from_agent = BridgeError::from(ConversationError::Busy);
        assert_eq!(serde_json::to_value(&from_agent).unwrap()["kind"], "busy");
        let unwritable = SettingsError::Io {
            path: "settings.json".into(),
            source: std::io::Error::other("disk full"),
        };
        let message = unwritable.to_string();
        assert_eq!(
            serde_json::to_value(BridgeError::from(unwritable)).unwrap(),
            json!({"kind": "io", "message": message})
        );
    }
}
