//! Each user's settings, and the server-wide places of the provider programs that only an admin
//! reads or changes, because whoever sets them runs a program of their choice on the server.

use std::path::PathBuf;

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
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            reduced_motion: false,
            persona: Persona::default(),
            model: Model::default(),
            effort: Effort::default(),
            turn_budget_usd: 10.0,
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
