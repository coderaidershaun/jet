//! Phonon-2, a speech model that runs on the server itself, so Jet can hear without a Google key.
//! Opening the model takes a moment and close to a gigabyte, so one session is kept open and hears
//! one clip at a time.

use crate::env_file;
use crate::voice::local::{self, Attempt};
use crate::voice::{VoiceError, checked_clip};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

const MODEL_VARIABLE: &str = "PHONON2_MODEL";
/// Where Jet looks for the model when `PHONON2_MODEL` is not set, from the folder it runs in.
const DEFAULT_MODEL: &str = "models/phonon2-q8_0.gguf";

/// How Phonon-2 decodes a clip.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PhononMode {
    /// Greedy decoding, with the model on the GPU of a Mac. Other servers use the CPU.
    #[default]
    Fast,
    /// A beam search that keeps four guesses alive: a little slower, a little surer.
    Exact,
    /// Greedy decoding with no GPU at all.
    #[serde(rename = "cpu")]
    CpuOnly,
}

/// The model file and the session opened from it, kept between clips.
#[derive(Default)]
pub struct Phonon2 {
    opened: Mutex<Option<Attempt<engine::Session>>>,
}

impl Phonon2 {
    /// The model file in use, read from the environment or the nearest `.env` each time.
    pub fn model() -> PathBuf {
        env_file::read(MODEL_VARIABLE).map_or_else(|| PathBuf::from(DEFAULT_MODEL), PathBuf::from)
    }

    /// Whether Phonon-2 can hear: the model file is there, and it did not fail to open last time.
    /// It never opens the model, so it is quick.
    /// # Errors
    /// Returns [`VoiceError::Phonon2NotBuilt`], [`VoiceError::ModelMissing`] or
    /// [`VoiceError::ModelLoad`].
    pub fn status(&self) -> Result<(), VoiceError> {
        engine::built()?;
        let model = Self::model();
        check_file(&model)?;
        match local::last_failure(&self.opened, &model) {
            Some(reason) => Err(VoiceError::ModelLoad {
                path: model,
                reason,
            }),
            None => Ok(()),
        }
    }

    /// The words in a clip of raw 16 kHz 16-bit little-endian mono audio, as [`crate::voice::hear`] takes
    /// it. The session opens on the first clip, and again when the file or the CPU only mode changes.
    /// An empty clip only opens it, so the page can open it before the user speaks.
    /// # Errors
    /// Returns [`VoiceError::AudioTooLong`] past 20 seconds, the errors of [`Phonon2::status`],
    /// and [`VoiceError::Phonon2Failed`] when the model cannot hear the clip.
    pub fn hear(&self, pcm: &[u8], mode: PhononMode) -> Result<String, VoiceError> {
        let pcm = checked_clip(pcm)?;
        engine::built()?;
        let model = Self::model();
        check_file(&model)?;
        let mut opened = self.opened.lock().unwrap_or_else(PoisonError::into_inner);
        engine::hear(&mut opened, &model, pcm, mode)
    }
}

/// The quick check: the path is a file that starts as every GGUF model does.
fn check_file(model: &Path) -> Result<(), VoiceError> {
    match local::is_gguf(model) {
        Some(true) => Ok(()),
        Some(false) => Err(VoiceError::ModelLoad {
            path: model.to_owned(),
            reason: "it is not a GGUF model".into(),
        }),
        None => Err(VoiceError::ModelMissing {
            path: model.to_owned(),
        }),
    }
}

#[cfg(feature = "phonon2")]
mod engine {
    use super::{Attempt, PhononMode, VoiceError, local};
    pub(super) use crispasr::Session;
    use crispasr::SessionOptions;
    use std::path::Path;

    /// The CrispASR backend that runs Phonon-2, which is a Parakeet model.
    const BACKEND: &str = "parakeet";
    const EXACT_BEAM: i32 = 4;

    pub(super) fn built() -> Result<(), VoiceError> {
        Ok(())
    }

    pub(super) fn hear(
        opened: &mut Option<Attempt<Session>>,
        model: &Path,
        pcm: &[u8],
        mode: PhononMode,
    ) -> Result<String, VoiceError> {
        let cpu_only = mode == PhononMode::CpuOnly;
        let session = local::load(opened, model, cpu_only, || {
            let options = SessionOptions {
                use_gpu: !cpu_only,
                n_threads: threads(),
                ..SessionOptions::default()
            };
            Session::open_with_options(&model.to_string_lossy(), Some(BACKEND), &options)
        })
        .map_err(|reason| VoiceError::ModelLoad {
            path: model.to_owned(),
            reason,
        })?;
        if pcm.is_empty() {
            return Ok(String::new());
        }
        let beam = if mode == PhononMode::Exact {
            EXACT_BEAM
        } else {
            1
        };
        session
            .set_beam_size(beam)
            .map_err(VoiceError::Phonon2Failed)?;
        let samples: Vec<f32> = pcm
            .chunks_exact(2)
            .map(|pair| f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32_768.0)
            .collect();
        let segments = session
            .transcribe(&samples)
            .map_err(VoiceError::Phonon2Failed)?;
        let words: Vec<&str> = segments
            .iter()
            .map(|segment| segment.text.trim())
            .filter(|text| !text.is_empty())
            .collect();
        Ok(words.join(" "))
    }

    fn threads() -> i32 {
        std::thread::available_parallelism()
            .map_or(4, |count| i32::try_from(count.get()).unwrap_or(4))
    }
}

#[cfg(not(feature = "phonon2"))]
mod engine {
    use super::{Attempt, PhononMode, VoiceError};
    use std::path::Path;

    /// No session can exist in a Jet built without Phonon-2.
    pub(super) enum Session {}

    pub(super) fn built() -> Result<(), VoiceError> {
        Err(VoiceError::Phonon2NotBuilt)
    }

    pub(super) fn hear(
        _: &mut Option<Attempt<Session>>,
        _: &Path,
        _: &[u8],
        _: PhononMode,
    ) -> Result<String, VoiceError> {
        Err(VoiceError::Phonon2NotBuilt)
    }
}

#[cfg(all(test, feature = "phonon2"))]
mod tests {
    use super::*;

    /// The model and a 16 kHz mono WAV of "Please remind me to call Ada about the kite festival on
    /// Saturday at nine thirty." beside it, in the ignored `models` folder at the repo root.
    fn model_and_clip() -> Option<(PathBuf, Vec<u8>)> {
        let model = std::env::var_os(MODEL_VARIABLE).map_or_else(
            || {
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../..")
                    .join(DEFAULT_MODEL)
            },
            PathBuf::from,
        );
        let wav = std::fs::read(model.with_file_name("sample.wav")).ok()?;
        model.is_file().then_some(())?;
        let data = wav.windows(4).position(|window| window == b"data")?;
        Some((model, wav[data + 8..].to_vec()))
    }

    #[test]
    fn phonon2_hears_a_sentence_in_every_mode() {
        let Some((model, pcm)) = model_and_clip() else {
            eprintln!("skipped: no Phonon-2 model and sample.wav in the models folder");
            return;
        };
        let mut opened = None;
        for mode in [PhononMode::Fast, PhononMode::Exact, PhononMode::CpuOnly] {
            let text = engine::hear(&mut opened, &model, &pcm, mode).unwrap();
            for word in ["remind", "call", "Ada", "Saturday"] {
                assert!(text.contains(word), "{mode:?} heard {text:?}");
            }
        }
    }
}
