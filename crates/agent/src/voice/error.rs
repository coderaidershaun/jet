//! Why a spoken clip could not be made. The messages are shown to the user, so none of them can
//! hold the key.

/// What went wrong while turning words into speech.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VoiceError {
    #[error("Voice needs {missing} in .env")]
    NotConfigured { missing: String },
    #[error("That is {length} characters, and a spoken piece can hold at most {limit}")]
    TooLong { length: usize, limit: usize },
    #[error("The voice request failed or ran out of time")]
    Http,
    #[error("Google's voice quota is used up")]
    RateLimited,
    #[error("Google refused the voice request with status {status}: {message}")]
    Rejected { status: u16, message: String },
    #[error("Google's voice answer held no audio that could be read")]
    Decode,
}
