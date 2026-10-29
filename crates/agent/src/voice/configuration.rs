//! What a request to Gemini needs: the key, the voice and the models, read from the environment or
//! the nearest `.env` each time, so that an edited `.env` needs no restart.

use super::VoiceError;
use crate::env_file;

const KEY_VARIABLE: &str = "GEMINI_API_KEY";
const VOICE_VARIABLE: &str = "GEMINI_VOICE_ID";
const MODEL_VARIABLE: &str = "GEMINI_TTS_MODEL";
const DEFAULT_MODEL: &str = "gemini-3.8-flash-tts";
const HEAR_MODEL_VARIABLE: &str = "GEMINI_HEAR_MODEL";
const DEFAULT_HEAR_MODEL: &str = "gemini-3.5-transcribe";
const DAILY_MINUTES_VARIABLE: &str = "GEMINI_HEAR_DAILY_MINUTES";
const DEFAULT_DAILY_MINUTES: u32 = 60;

/// What speaking needs: the key, a voice and a model.
pub(super) struct Speaking {
    pub(super) key: String,
    pub(super) voice: String,
    pub(super) model: String,
}

impl Speaking {
    pub(super) fn read() -> Result<Self, VoiceError> {
        match (env_file::read(KEY_VARIABLE), env_file::read(VOICE_VARIABLE)) {
            (Some(key), Some(voice)) => Ok(Self {
                key,
                voice,
                model: env_file::read(MODEL_VARIABLE).unwrap_or_else(|| DEFAULT_MODEL.into()),
            }),
            (key, voice) => {
                let missing = [(KEY_VARIABLE, key), (VOICE_VARIABLE, voice)]
                    .into_iter()
                    .filter(|(_, value)| value.is_none())
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>()
                    .join(" and ");
                Err(VoiceError::NotConfigured { missing })
            }
        }
    }
}

/// What hearing needs: the key and a model. Hearing needs no voice.
pub(super) struct Hearing {
    pub(super) key: String,
    pub(super) model: String,
}

impl Hearing {
    pub(super) fn read() -> Result<Self, VoiceError> {
        let key = env_file::read(KEY_VARIABLE).ok_or_else(|| VoiceError::HearingNotConfigured {
            missing: KEY_VARIABLE.into(),
        })?;
        Ok(Self {
            key,
            model: env_file::read(HEAR_MODEL_VARIABLE).unwrap_or_else(|| DEFAULT_HEAR_MODEL.into()),
        })
    }
}

/// The minutes of audio the server may hear in one day. A value that is not a whole number
/// counts as missing.
pub(super) fn daily_minutes() -> u32 {
    env_file::read(DAILY_MINUTES_VARIABLE)
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(DEFAULT_DAILY_MINUTES)
}
