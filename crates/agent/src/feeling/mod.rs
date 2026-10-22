//! Reads how a message makes Jet feel before the reply starts.

mod jev;
mod key;

use crate::Mood;
pub use jev::Jev;
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
    #[error("no JEV key found in CONVERTER_JEV_API_KEY or a parent .env")]
    MissingKey,
    #[error("JEV request failed or exceeded its two-second timeout")]
    Http,
    #[error("JEV rejected the request with status {status}")]
    Rejected { status: u16 },
    #[error("JEV response did not contain valid answers for both emotions")]
    Decode,
}

/// The classifier's only outside dependency.
pub trait FeelingSource {
    /// # Errors
    /// Returns a safe error when classification could not complete.
    fn scores(&self, text: &str) -> Result<BTreeMap<String, f64>, JevError>;
}

/// Classifies a message using the supplied source.
/// # Errors
/// Returns the source's classification error.
pub fn classify(source: &impl FeelingSource, text: &str) -> Result<Feeling, JevError> {
    source.scores(text).map(Feeling::from_scores)
}

/// Reads the key anew for this call. With no key, classification is immediate.
/// # Errors
/// Returns a safe request or decoding error when JEV is unavailable.
pub fn feel_message(text: &str) -> Result<Feeling, JevError> {
    let environment = std::env::var(key::VARIABLE)
        .ok()
        .filter(|key| !key.trim().is_empty());
    let key = if environment.is_some() {
        environment
    } else {
        std::env::current_dir()
            .ok()
            .and_then(|directory| key::discover(None, &directory))
    };
    let Some(key) = key else {
        return Ok(Feeling::neutral());
    };
    classify(&Jev::new(key), text)
}

#[cfg(test)]
struct FakeJev(Result<BTreeMap<String, f64>, JevError>);

#[cfg(test)]
impl FeelingSource for FakeJev {
    fn scores(&self, _text: &str) -> Result<BTreeMap<String, f64>, JevError> {
        self.0.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification_uses_supported_scores_threshold_and_vocabulary_order() {
        for (scores, expected) in [
            (vec![("hello", 0.5), ("insulted", 0.5)], Mood::Hello),
            (vec![("hello", 0.49), ("insulted", 0.8)], Mood::Insulted),
            (
                vec![("hello", f64::NAN), ("insulted", 1.1), ("other", 1.0)],
                Mood::Neutral,
            ),
            (
                vec![("hello", -0.1), ("insulted", f64::INFINITY)],
                Mood::Neutral,
            ),
        ] {
            let scores = scores
                .into_iter()
                .map(|(word, score)| (word.into(), score))
                .collect();
            assert_eq!(Feeling::from_scores(scores).mood, expected);
        }
        let moods: Vec<_> = QUESTIONS.iter().map(|(mood, _)| *mood).collect();
        assert_eq!(moods, Mood::ALL[1..]);
        assert_eq!(
            classify(&FakeJev(Err(JevError::Http)), "hi"),
            Err(JevError::Http)
        );
        assert_eq!(
            classify(&FakeJev(Ok(BTreeMap::from([("hello".into(), 0.9)]))), "hi")
                .unwrap()
                .mood,
            Mood::Hello
        );
    }
}
