//! The error every chat command fails with, sent to the page as a kind and a message.

use agent::{ConversationError, Failure, MemoryError, TransportError, TurnError};
use serde::Serialize;

use crate::files::FileError;
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
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Unsupported(String),
    #[error("{0}")]
    TooLarge(String),
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
            BridgeError::NotFound(_) => "notFound",
            BridgeError::Unsupported(_) => "unsupported",
            BridgeError::TooLarge(_) => "tooLarge",
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

impl From<FileError> for BridgeError {
    fn from(error: FileError) -> BridgeError {
        match error {
            FileError::NotFound(_) => BridgeError::NotFound(error.to_string()),
            FileError::Unsupported(_) | FileError::Unreadable(_) => {
                BridgeError::Unsupported(error.to_string())
            }
            FileError::TooLarge(_) | FileError::StoreFull => {
                BridgeError::TooLarge(error.to_string())
            }
            FileError::NoSuchSheet(_) => BridgeError::InvalidRequest(error.to_string()),
            other => BridgeError::Io(other.to_string()),
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
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Unsupported(_) => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Self::TooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
            Self::ShuttingDown => StatusCode::SERVICE_UNAVAILABLE,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, axum::Json(self)).into_response()
    }
}
