//! Jet's voice, both ways: the words of a reply as Gemini speech, and a clip of the user's speech
//! as words. The key, the voice and the models are read from the environment or the nearest
//! `.env` on every call, never from the settings.

mod configuration;
mod error;
mod gemini;
mod wav;

use crate::conversation::spoken_words;
use configuration::{Hearing, Speaking};
pub use error::VoiceError;
use gemini::Gemini;

/// The most characters of Markdown one call speaks.
const MAX_CHARACTERS: usize = 2_000;

/// The longest vocabulary word, in characters, that a hearing call sends. Longer ones are left out.
const MAX_VOCABULARY_CHARACTERS: usize = 40;

/// The most vocabulary words that a hearing call uses.
const MAX_VOCABULARY_WORDS: usize = 20;

/// Raw 16-bit little-endian mono audio comes back at this many samples a second.
pub const SAMPLE_RATE: u32 = 24_000;

/// Clips to hear are raw 16-bit little-endian mono audio at this many samples a second.
pub const HEAR_SAMPLE_RATE: u32 = 16_000;

/// The longest clip, in seconds, that Jet hears.
pub const MAX_CLIP_SECONDS: u32 = 20;

/// Whether Jet can speak right now. It reads the configuration and calls no one.
/// # Errors
/// Returns [`VoiceError::NotConfigured`] naming what `.env` lacks.
pub fn status() -> Result<(), VoiceError> {
    Speaking::read().map(drop)
}

/// Whether Jet can hear right now. It reads the configuration and calls no one.
/// # Errors
/// Returns [`VoiceError::HearingNotConfigured`] naming what `.env` lacks.
pub fn hearing_status() -> Result<(), VoiceError> {
    Hearing::read().map(drop)
}

/// The minutes of audio the server may hear in one day: `GEMINI_HEAR_DAILY_MINUTES`, or 60.
pub fn hearing_daily_minutes() -> u32 {
    configuration::daily_minutes()
}

/// How many seconds of audio `pcm` holds, rounded up.
pub fn clip_seconds(pcm: &[u8]) -> u32 {
    let samples = u32::try_from(pcm.len() / 2).unwrap_or(u32::MAX);
    samples.div_ceil(HEAR_SAMPLE_RATE)
}

/// The words of a piece of a reply as raw 24 kHz PCM. A piece with nothing to say aloud, such
/// as code alone, gives empty audio and makes no request. A `style` such as "warm and bright"
/// tells the voice how to say the words.
/// # Errors
/// Returns [`VoiceError::TooLong`] past 2,000 characters, [`VoiceError::NotConfigured`] when
/// `.env` lacks the key or the voice, and the other errors when Gemini fails.
pub fn speak(markdown: &str, style: Option<&str>) -> Result<Vec<u8>, VoiceError> {
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
    let Speaking { key, voice, model } = Speaking::read()?;
    Gemini::new(key, voice, model).speak(&words, style)
}

/// The words in a clip of raw 16 kHz 16-bit little-endian mono audio, empty when the clip holds
/// no speech. A last odd byte is dropped. `vocabulary` lists names that the words may hold; the
/// first 20 distinct values of 40 characters or fewer are used.
/// # Errors
/// Returns [`VoiceError::AudioTooLong`] past 20 seconds, [`VoiceError::HearingNotConfigured`]
/// when `.env` lacks the key, and the other errors when Gemini fails.
pub fn hear(pcm: &[u8], vocabulary: &[String]) -> Result<String, VoiceError> {
    let pcm = &pcm[..pcm.len() & !1];
    let seconds = clip_seconds(pcm);
    if seconds > MAX_CLIP_SECONDS {
        return Err(VoiceError::AudioTooLong {
            seconds,
            limit: MAX_CLIP_SECONDS,
        });
    }
    if pcm.is_empty() {
        return Ok(String::new());
    }
    let Hearing { key, model } = Hearing::read()?;
    Gemini::hearing(key, model).hear(&wav::with_header(pcm, HEAR_SAMPLE_RATE), &clamp(vocabulary))
}

/// The vocabulary a call may send: trimmed, without empty, repeated or overlong values, and at
/// most 20 of them.
fn clamp(vocabulary: &[String]) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    for word in vocabulary.iter().map(|word| word.trim()) {
        if !word.is_empty()
            && word.chars().count() <= MAX_VOCABULARY_CHARACTERS
            && !kept.iter().any(|seen| seen == word)
        {
            kept.push(word.to_owned());
        }
    }
    kept.truncate(MAX_VOCABULARY_WORDS);
    kept
}
