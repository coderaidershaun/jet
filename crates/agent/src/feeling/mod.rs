//! Reads how a message makes Jet feel before the reply starts.

mod jev;
mod key;

use crate::Mood;
use jev::Jev;
use serde::Serialize;
use std::collections::BTreeMap;

pub(crate) const QUESTIONS: [(Mood, &str); 2] = [
    (
        Mood::Hello,
        "Is the user greeting you or saying goodbye in this message?",
    ),
    (
        Mood::Insulted,
        "Is this message insulting you or expressing contempt for you?",
    ),
];

/// The chosen emotion and the confidence scores returned for this message.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Feeling {
    pub mood: Mood,
    pub scores: BTreeMap<String, f64>,
}

impl Feeling {
    /// Invalid and unsupported scores cannot choose an animation.
    pub fn from_scores(scores: BTreeMap<String, f64>) -> Self {
        let mut mood = Mood::Neutral;
        let mut highest = 0.5;
        for candidate in Mood::ALL.into_iter().skip(1) {
            if let Some(&score) = scores.get(candidate.word())
                && score.is_finite()
                && (0.5..=1.0).contains(&score)
                && (mood == Mood::Neutral || score > highest)
            {
                mood = candidate;
                highest = score;
            }
        }
        Self { mood, scores }
    }

    pub fn neutral() -> Self {
        Self::from_scores(BTreeMap::new())
    }
}

/// Failures contain no server body or credential-bearing transport error.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum JevError {
    #[error("JEV request failed or exceeded its two-second timeout")]
    Http,
    #[error("JEV rejected the request with status {status}")]
    Rejected { status: u16 },
    #[error("JEV response did not contain valid answers for both emotions")]
    Decode,
}

/// Reads the key anew for this call. With no key, classification is immediate.
/// # Errors
/// Returns a safe request or decoding error when JEV is unavailable.
pub fn feel_message(text: &str) -> Result<Feeling, JevError> {
    let directory = std::env::current_dir().unwrap_or_default();
    let Some(key) = key::discover(std::env::var(key::VARIABLE).ok(), &directory) else {
        return Ok(Feeling::neutral());
    };
    Jev::new(key).classify(text)
}
