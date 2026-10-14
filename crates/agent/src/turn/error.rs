//! What can go wrong in a turn, and the words the user is shown for each failure.

use std::time::Duration;

use super::transport::TransportError;
use crate::chat::Failure;

/// How much of Claude's error output the user is shown.
const STDERR_SHOWN: usize = 300;

#[derive(Debug, thiserror::Error)]
pub enum TurnError {
    #[error(transparent)]
    Transport(#[from] TransportError),
    #[error("no output from Claude Code for {} seconds", idle.as_secs())]
    Timeout { idle: Duration },
    #[error("Claude Code reported {subtype}: {message}")]
    Reported { subtype: String, message: String },
    #[error("Claude Code ended without a result")]
    NoResult,
}

impl From<&TurnError> for Failure {
    /// The message is written for the user and shown as it stands.
    fn from(error: &TurnError) -> Failure {
        match error {
            TurnError::Transport(TransportError::ClaudeMissing { searched }) => {
                Failure::ClaudeMissing {
                    message: format!(
                        "I couldn't find Claude Code. I looked in: {}",
                        searched.join(", ")
                    ),
                }
            }
            TurnError::Transport(TransportError::Exited { code, stderr }) => {
                let tail = last_chars(stderr.trim(), STDERR_SHOWN);
                let message = if tail.is_empty() {
                    match code {
                        Some(code) => format!("Claude Code exited with code {code}"),
                        None => "Claude Code exited without a status code".to_owned(),
                    }
                } else {
                    tail.to_owned()
                };
                Failure::ClaudeFailed { message }
            }
            TurnError::Transport(other) => Failure::Io {
                message: other.to_string(),
            },
            TurnError::Timeout { .. } => Failure::Timeout {
                message: "Claude stopped responding after 2 minutes.".to_owned(),
            },
            TurnError::Reported { message, .. } => Failure::ClaudeFailed {
                message: message.clone(),
            },
            TurnError::NoResult => Failure::ClaudeFailed {
                message: "Claude Code ended without a reply.".to_owned(),
            },
        }
    }
}

fn last_chars(text: &str, count: usize) -> &str {
    match text.char_indices().rev().nth(count.saturating_sub(1)) {
        Some((start, _)) => &text[start..],
        None => text,
    }
}
