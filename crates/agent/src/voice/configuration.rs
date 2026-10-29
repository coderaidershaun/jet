//! What a request to Gemini needs: the key, the voice and the model, read from the environment or
//! the nearest `.env` each time, so that an edited `.env` needs no restart.

use super::VoiceError;
use crate::env_file;

const KEY_VARIABLE: &str = "GEMINI_API_KEY";
const VOICE_VARIABLE: &str = "GEMINI_VOICE_ID";
const MODEL_VARIABLE: &str = "GEMINI_TTS_MODEL";
const DEFAULT_MODEL: &str = "gemini-3.8-flash-tts";

pub(super) struct Configuration {
    pub(super) key: String,
    pub(super) voice: String,
    pub(super) model: String,
}

impl Configuration {
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
