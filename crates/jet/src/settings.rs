//! Each user's settings, and the server-wide places of the provider programs that only an admin
//! reads or changes, because whoever sets them runs a program of their choice on the server.

use std::path::PathBuf;

use agent::voice::PhononMode;
use agent::{Effort, Model, Persona};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Settings {
    pub reduced_motion: bool,
    pub persona: Persona,
    pub model: Model,
    pub effort: Effort,
    /// The most one Claude answer may cost, in US dollars.
    pub turn_budget_usd: f64,
    /// The engine the user chose to hear them. The page falls back to another when it cannot.
    pub hearing_engine: HearingEngine,
    pub phonon2_mode: PhononMode,
    /// The engine the user chose to speak Jet's replies. The page falls back to another when it cannot.
    pub speaking_engine: SpeakingEngine,
}

/// What turns the user's speech into words.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HearingEngine {
    /// Google's Gemini, which needs `GEMINI_API_KEY`.
    #[default]
    Gemini,
    /// The browser's own speech recognition, which runs in the page.
    Browser,
    /// The Phonon-2 model, run by this server.
    Phonon2,
}

/// What turns Jet's replies into speech.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SpeakingEngine {
    /// Google's Gemini, which needs `GEMINI_API_KEY`.
    #[default]
    Gemini,
    /// The browser's own speech synthesis, which runs in the page.
    Browser,
    /// The Phonon 31m model, run by this server.
    Phonon,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            reduced_motion: false,
            persona: Persona::default(),
            model: Model::default(),
            effort: Effort::default(),
            turn_budget_usd: 10.0,
            hearing_engine: HearingEngine::default(),
            phonon2_mode: PhononMode::default(),
            speaking_engine: SpeakingEngine::default(),
        }
    }
}

/// Where the provider programs are; `None` means look in the usual places.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ProgramPaths {
    pub claude_path: Option<PathBuf>,
    pub codex_path: Option<PathBuf>,
    pub agy_path: Option<PathBuf>,
}

impl ProgramPaths {
    /// The names the page sends them under.
    pub(crate) const FIELDS: [&str; 3] = ["claudePath", "codexPath", "agyPath"];

    /// Whether a settings body names any program path.
    pub(crate) fn named_in(body: &Value) -> bool {
        Self::FIELDS.iter().any(|field| body.get(field).is_some())
    }
}

/// What an admin reads and writes: their own settings with the program paths beside them.
#[derive(Serialize)]
pub(crate) struct AdminSettings {
    #[serde(flatten)]
    pub settings: Settings,
    #[serde(flatten)]
    pub paths: ProgramPaths,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_match_the_ui_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../ui/bridge/default-settings.json")).unwrap();
        assert_eq!(fixture, serde_json::to_value(Settings::default()).unwrap());
    }
}
