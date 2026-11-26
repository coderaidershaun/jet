//! Why a clip of speech could not be made or heard. The messages are shown to the user, so none
//! of them can hold the key, and each has a form without the server's paths.

use std::path::PathBuf;

/// What went wrong while turning words into speech, or speech into words.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VoiceError {
    #[error("Voice needs {missing} in .env")]
    NotConfigured { missing: String },
    #[error("Hearing needs {missing} in .env")]
    HearingNotConfigured { missing: String },
    #[error("That is {length} characters, and a spoken piece can hold at most {limit}")]
    TooLong { length: usize, limit: usize },
    #[error("That clip is {seconds} seconds long, and Jet hears at most {limit}")]
    AudioTooLong { seconds: u32, limit: u32 },
    #[error("The voice request failed or ran out of time")]
    Http,
    #[error("Google's voice quota is used up")]
    RateLimited,
    #[error("Google refused the voice request with status {status}: {message}")]
    Rejected { status: u16, message: String },
    #[error("Google's voice answer held no audio or words that could be read")]
    Decode,
    #[error("This Jet was built without Phonon-2. Build it with --features phonon2")]
    Phonon2NotBuilt,
    #[error("Download phonon2-q8_0.gguf to {}", path.display())]
    ModelMissing { path: PathBuf },
    #[error("Phonon-2 could not open {}: {reason}", path.display())]
    ModelLoad { path: PathBuf, reason: String },
    #[error("Phonon-2 could not hear the clip: {0}")]
    Phonon2Failed(String),
    #[error("This Jet was built without Phonon. Build it with --features phonon-tts")]
    PhononNotBuilt,
    #[error("Download Phonon 31m to {}", path.display())]
    PhononMissing { path: PathBuf },
    #[error("Phonon could not load {}: {reason}", path.display())]
    PhononLoad { path: PathBuf, reason: String },
    #[error("Phonon could not speak the words: {0}")]
    PhononFailed(String),
}

impl VoiceError {
    /// The message with no path on the server in it, for a user who is not an admin.
    pub fn without_path(&self) -> String {
        match self {
            VoiceError::ModelMissing { .. } => "Phonon-2's model is not on the server".into(),
            VoiceError::ModelLoad { .. } => "Phonon-2 could not open its model".into(),
            VoiceError::PhononMissing { .. } => "The Phonon 31m model is not on the server".into(),
            VoiceError::PhononLoad { .. } => "Phonon could not load its model".into(),
            other => other.to_string(),
        }
    }
}
