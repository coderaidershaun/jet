//! Phonon 31m, Gradium's text-to-speech model run by the server itself, so Jet can speak without a
//! Google key. The model loads in a moment and is kept loaded, and it speaks one piece at a time.

use super::local::{self, Attempt};
use super::{SAMPLE_RATE, VoiceError, words_to_speak};
use crate::env_file;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

const MODEL_VARIABLE: &str = "PHONON_TTS_MODEL";
const VOICE_VARIABLE: &str = "PHONON_TTS_VOICE";
/// Where Jet looks for the model folder when `PHONON_TTS_MODEL` is not set, from the folder it runs in.
const DEFAULT_MODEL: &str = "models/phonon-31m-en";
const WEIGHTS: &str = "model.q8.gguf";
const PARTS: [&str; 3] = ["config.json", "tokenizer.json", "default-voice.safetensors"];
/// The voice of the model's own `default-voice.safetensors`.
const DEFAULT_VOICE: &str = "default";

/// The model folder and the voice loaded from it, kept between pieces.
#[derive(Default)]
pub struct Phonon {
    loaded: Mutex<Option<Attempt<engine::Synth>>>,
}

impl Phonon {
    /// The model folder in use, read from the environment or the nearest `.env` each time.
    pub fn model() -> PathBuf {
        env_file::read(MODEL_VARIABLE).map_or_else(|| PathBuf::from(DEFAULT_MODEL), PathBuf::from)
    }

    /// Whether Phonon can speak: the model files and the voice are there, and they did not fail to
    /// load last time. It never loads the model, so it is quick.
    /// # Errors
    /// Returns [`VoiceError::PhononNotBuilt`], [`VoiceError::PhononMissing`] or
    /// [`VoiceError::PhononLoad`].
    pub fn status(&self) -> Result<(), VoiceError> {
        engine::built()?;
        let model = Self::model();
        check_folder(&model)?;
        let failure = voice()
            .filter(|voice| voice != DEFAULT_VOICE)
            .filter(|voice| !model.join(format!("voices/{voice}.safetensors")).is_file())
            .map(|voice| format!("it has no voices/{voice}.safetensors for PHONON_TTS_VOICE"))
            .or_else(|| local::last_failure(&self.loaded, &model.join(WEIGHTS)));
        match failure {
            Some(reason) => Err(VoiceError::PhononLoad {
                path: model,
                reason,
            }),
            None => Ok(()),
        }
    }

    /// The words of a piece of a reply as raw 24 kHz PCM, as [`super::speak`] gives them. The voice
    /// is `PHONON_TTS_VOICE`, or the model's own when that is not set.
    /// # Errors
    /// Returns [`VoiceError::TooLong`] past 2,000 characters, the errors of [`Phonon::status`],
    /// and [`VoiceError::PhononFailed`] when the model cannot say the words.
    pub fn speak(&self, markdown: &str) -> Result<Vec<u8>, VoiceError> {
        // Phonon cannot perform a cue such as `<laugh>` and would read it out.
        let words = words_to_speak(markdown, false)?;
        if words.is_empty() {
            return Ok(Vec::new());
        }
        engine::built()?;
        let model = Self::model();
        check_folder(&model)?;
        let mut loaded = self.loaded.lock().unwrap_or_else(PoisonError::into_inner);
        let (rate, samples) = engine::say(&mut loaded, &model, &words, voice().as_deref())?;
        if rate != SAMPLE_RATE {
            return Err(VoiceError::PhononFailed(format!(
                "it spoke at {rate} Hz, and Jet plays {SAMPLE_RATE} Hz"
            )));
        }
        // The model's own rule for writing its samples as 16-bit audio.
        let pcm = samples
            .iter()
            .flat_map(|sample| ((sample.clamp(-1.0, 1.0) * 32_767.0) as i16).to_le_bytes())
            .collect();
        Ok(pcm)
    }
}

/// The voice that `PHONON_TTS_VOICE` names, if any.
fn voice() -> Option<String> {
    env_file::read(VOICE_VARIABLE)
}

/// The quick check: every file is there, and the weights start as every GGUF model does.
fn check_folder(model: &Path) -> Result<(), VoiceError> {
    let parts_there = PARTS.iter().all(|part| model.join(part).is_file());
    match local::is_gguf(&model.join(WEIGHTS)) {
        Some(true) if parts_there => Ok(()),
        Some(false) if parts_there => Err(VoiceError::PhononLoad {
            path: model.to_owned(),
            reason: format!("{WEIGHTS} is not a GGUF model"),
        }),
        _ => Err(VoiceError::PhononMissing {
            path: model.to_owned(),
        }),
    }
}

#[cfg(feature = "phonon-tts")]
mod engine {
    use super::{Attempt, VoiceError, WEIGHTS, local};
    use ptts::checkpoint::{Checkpoint, ResolveOptions};
    use ptts::preprocess::Lang;
    pub(super) use ptts::synth::Synth;
    use ptts::synth::{DeviceKind, Quant, SpeechOptions};
    use std::path::Path;

    pub(super) fn built() -> Result<(), VoiceError> {
        Ok(())
    }

    fn load(model: &Path) -> Result<Synth, String> {
        let options = ResolveOptions {
            quant: Quant::Q80,
            weights: None,
        };
        let checkpoint = Checkpoint::resolve(model, options).map_err(|error| error.to_string())?;
        let mut synth = checkpoint
            .builder(Lang::En)
            .device(DeviceKind::Cpu)
            .build()
            .map_err(|error| error.to_string())?;
        checkpoint.register_voices(&mut synth);
        Ok(synth)
    }

    /// The sample rate and the samples of the words, loading the model first when it is not.
    pub(super) fn say(
        loaded: &mut Option<Attempt<Synth>>,
        model: &Path,
        words: &str,
        voice: Option<&str>,
    ) -> Result<(u32, Vec<f32>), VoiceError> {
        let synth =
            local::load(loaded, &model.join(WEIGHTS), true, || load(model)).map_err(|reason| {
                VoiceError::PhononLoad {
                    path: model.to_owned(),
                    reason,
                }
            })?;
        let mut options = SpeechOptions::default();
        if let Some(voice) = voice {
            options = options.voice(voice);
        }
        let samples = synth
            .say_with(words, &options)
            .map_err(|error| VoiceError::PhononFailed(error.to_string()))?;
        Ok((synth.sample_rate(), samples))
    }
}

#[cfg(not(feature = "phonon-tts"))]
mod engine {
    use super::{Attempt, VoiceError};
    use std::path::Path;

    /// No model can be loaded in a Jet built without Phonon.
    pub(super) enum Synth {}

    pub(super) fn built() -> Result<(), VoiceError> {
        Err(VoiceError::PhononNotBuilt)
    }

    pub(super) fn say(
        _: &mut Option<Attempt<Synth>>,
        _: &Path,
        _: &str,
        _: Option<&str>,
    ) -> Result<(u32, Vec<f32>), VoiceError> {
        Err(VoiceError::PhononNotBuilt)
    }
}

#[cfg(all(test, feature = "phonon-tts"))]
mod tests {
    use super::*;

    #[test]
    fn phonon_speaks_a_sentence_at_24_khz() {
        let model = std::env::var_os(MODEL_VARIABLE).map_or_else(
            || {
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../..")
                    .join(DEFAULT_MODEL)
            },
            PathBuf::from,
        );
        if check_folder(&model).is_err() {
            eprintln!("skipped: no Phonon 31m model in the models folder");
            return;
        }
        let sentence =
            "Please remind me to call Ada about the kite festival on Saturday at nine thirty.";
        let (rate, samples) = engine::say(&mut None, &model, sentence, None).unwrap();
        assert_eq!(rate, SAMPLE_RATE);
        let seconds = samples.len() as f32 / rate as f32;
        assert!((3.0..8.0).contains(&seconds), "{seconds} seconds of speech");
    }
}
