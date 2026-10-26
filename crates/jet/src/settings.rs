//! Keep user settings beside the server's conversation data.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use agent::{Effort, Model, Persona};
use serde::{Deserialize, Serialize};

const FILE_NAME: &str = "settings.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub reduced_motion: bool,
    pub persona: Persona,
    pub model: Model,
    pub effort: Effort,
    /// The most one Claude answer may cost, in US dollars.
    pub turn_budget_usd: f64,
    /// Where Claude Code lives; `None` means look in the usual places.
    pub claude_path: Option<PathBuf>,
    pub codex_path: Option<PathBuf>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            reduced_motion: false,
            persona: Persona::default(),
            model: Model::default(),
            effort: Effort::default(),
            turn_budget_usd: 10.0,
            claude_path: None,
            codex_path: None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("could not read or write {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("{path} is not a valid settings file: {source}")]
    Json {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

/// Reads the saved settings, or the defaults when nothing has been saved yet.
pub fn read_from(data_dir: &Path) -> Result<Settings, SettingsError> {
    let path = data_dir.join(FILE_NAME);
    match std::fs::read(&path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|source| SettingsError::Json { path, source })
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(Settings::default()),
        Err(source) => Err(SettingsError::Io { path, source }),
    }
}

pub fn write_to(data_dir: &Path, settings: &Settings) -> Result<(), SettingsError> {
    let path = data_dir.join(FILE_NAME);
    if path.exists() {
        let _ = read_from(data_dir)?;
    }
    let io = |source| SettingsError::Io {
        path: path.clone(),
        source,
    };
    std::fs::create_dir_all(data_dir).map_err(io)?;
    let json = serde_json::to_vec_pretty(settings).map_err(|source| SettingsError::Json {
        path: path.clone(),
        source,
    })?;
    use std::io::Write;
    let mut temporary = tempfile::NamedTempFile::new_in(data_dir).map_err(io)?;
    temporary.write_all(&json).map_err(io)?;
    temporary.as_file().sync_all().map_err(io)?;
    temporary.persist(&path).map_err(|error| io(error.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(name: &str) -> PathBuf {
        let unique = format!("jet-settings-{}-{name}", std::process::id());
        std::env::temp_dir().join(unique)
    }

    fn saved_json(dir: &Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(dir.join(FILE_NAME)).unwrap()).unwrap()
    }

    #[test]
    fn old_files_with_missing_fields_still_load() {
        let dir = scratch_dir("partial");
        assert_eq!(read_from(&dir).unwrap(), Settings::default(), "no file yet");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(FILE_NAME),
            br#"{
                "behaviour":{"candid":0.1},
                "expressiveness":{"master":2.5},
                "bodyColour":[12,200,99],
                "repeat":false,
                "page":"workstation",
                "workstation":{"bridgePath":"/tmp/polysim-bridge","token":"old-secret"},
                "drawerOpen":false,
                "reducedMotion":true,
                "persona":{"name":"Ada"},
                "turnBudgetUsd":1.0
            }"#,
        )
        .unwrap();
        let settings = read_from(&dir).unwrap();
        assert!(settings.reduced_motion);
        assert_eq!(
            settings.persona,
            Persona {
                name: "Ada".into(),
                ..Persona::default()
            }
        );
        assert_eq!(settings.model, Model::Gpt61Sol);
        assert_eq!(settings.effort, Effort::Medium);
        assert_eq!(settings.turn_budget_usd, 1.0);
        assert_eq!(settings.claude_path, None);
        write_to(&dir, &settings).unwrap();
        assert_eq!(read_from(&dir).unwrap(), settings);
        let saved = saved_json(&dir);
        for key in [
            "behaviour",
            "expressiveness",
            "bodyColour",
            "repeat",
            "page",
            "workstation",
            "drawerOpen",
        ] {
            assert!(saved.get(key).is_none(), "removed {key} was saved");
        }

        // Fields added later survive a save and a load, under the names the page reads.
        let settings = Settings {
            persona: Persona {
                name: "Ada".into(),
                job_title: "Co-pilot".into(),
                notes: "Short answers.".into(),
            },
            model: Model::Opus,
            effort: Effort::High,
            turn_budget_usd: 2.5,
            claude_path: Some(PathBuf::from("/opt/tools/claude")),
            ..Settings::default()
        };
        write_to(&dir, &settings).unwrap();
        assert_eq!(read_from(&dir).unwrap(), settings);
        let text = std::fs::read_to_string(dir.join(FILE_NAME)).unwrap();
        for key in ["jobTitle", "turnBudgetUsd", "claudePath"] {
            assert!(
                text.contains(&format!("\"{key}\"")),
                "missing {key} in {text}"
            );
        }
        for (effort, word) in [(Effort::XHigh, "xhigh"), (Effort::Max, "max")] {
            let settings = Settings {
                effort,
                ..settings.clone()
            };
            write_to(&dir, &settings).unwrap();
            assert_eq!(read_from(&dir).unwrap(), settings);
            assert_eq!(saved_json(&dir)["effort"], word);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn default_settings_match_the_ui_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../ui/bridge/default-settings.json")).unwrap();
        assert_eq!(fixture, serde_json::to_value(Settings::default()).unwrap());
    }
}
