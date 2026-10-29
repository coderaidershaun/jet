//! Jet's spoken voice: the words of a reply as Gemini speech. The key, the voice and the model are
//! read from the environment or the nearest `.env` on every call, never from the settings.

mod configuration;
mod error;
mod gemini;

use crate::conversation::spoken_words;
use configuration::Configuration;
pub use error::VoiceError;
use gemini::Gemini;

/// The most characters of Markdown one call speaks.
const MAX_CHARACTERS: usize = 2_000;

/// Raw 16-bit little-endian mono audio comes back at this many samples a second.
pub const SAMPLE_RATE: u32 = 24_000;

/// Whether Jet can speak right now. It reads the configuration and calls no one.
/// # Errors
/// Returns [`VoiceError::NotConfigured`] naming what `.env` lacks.
pub fn status() -> Result<(), VoiceError> {
    Configuration::read().map(drop)
}

/// The words of a piece of a reply as raw 24 kHz PCM. A piece with nothing to say aloud, such
/// as code alone, gives empty audio and makes no request.
/// # Errors
/// Returns [`VoiceError::TooLong`] past 2,000 characters, [`VoiceError::NotConfigured`] when
/// `.env` lacks the key or the voice, and the other errors when Gemini fails.
pub fn speak(markdown: &str) -> Result<Vec<u8>, VoiceError> {
    let length = markdown.chars().count();
    if length > MAX_CHARACTERS {
        return Err(VoiceError::TooLong {
            length,
            limit: MAX_CHARACTERS,
        });
    }
    let words = spoken_words(markdown);
    if words.is_empty() {
        return Ok(Vec::new());
    }
    let Configuration { key, voice, model } = Configuration::read()?;
    Gemini::new(key, voice, model).speak(&words)
}
