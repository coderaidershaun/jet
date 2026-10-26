//! Keep user settings beside the server's conversation data.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use agent::{Effort, Model, Persona};
use serde::{Deserialize, Serialize};

pub(crate) const FILE_NAME: &str = "settings.json";

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
pub fn read_from(path: &Path) -> Result<Settings, SettingsError> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|source| SettingsError::Json {
            path: path.to_path_buf(),
            source,
        }),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(Settings::default()),
        Err(source) => Err(SettingsError::Io {
            path: path.to_path_buf(),
            source,
        }),
    }
}

pub fn write_to(path: &Path, settings: &Settings) -> Result<(), SettingsError> {
    if path.exists() {
        let _ = read_from(path)?;
    }
    let io = |source| SettingsError::Io {
        path: path.to_path_buf(),
        source,
    };
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder).map_err(io)?;
    }
    let json = serde_json::to_vec_pretty(settings).map_err(|source| SettingsError::Json {
        path: path.to_path_buf(),
        source,
    })?;
    use std::io::Write;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(io)?;
    temporary.write_all(&json).map_err(io)?;
    temporary.as_file().sync_all().map_err(io)?;
    temporary.persist(path).map_err(|error| io(error.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_file(name: &str) -> PathBuf {
        let unique = format!("jet-settings-{}-{name}", std::process::id());
        std::env::temp_dir().join(unique).join(FILE_NAME)
    }

    #[test]
    fn missing_file_means_defaults() {
        let path = scratch_file("missing");
        let settings = read_from(&path).unwrap();
        assert_eq!(settings, Settings::default());
    }

    #[test]
    fn settings_survive_a_round_trip() {
        let path = scratch_file("roundtrip");
        let settings = Settings {
            reduced_motion: true,
            ..Settings::default()
        };
        write_to(&path, &settings).unwrap();
        assert_eq!(read_from(&path).unwrap(), settings);

        let saved: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(saved.get("page").is_none());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn old_files_with_missing_fields_still_load() {
        let path = scratch_file("partial");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
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
        let settings = read_from(&path).unwrap();
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
        write_to(&path, &settings).unwrap();
        assert_eq!(read_from(&path).unwrap(), settings);
        let saved: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
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
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn new_fields_round_trip() {
        let path = scratch_file("new-fields");
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
        write_to(&path, &settings).unwrap();
        assert_eq!(read_from(&path).unwrap(), settings);

        let json = std::fs::read_to_string(&path).unwrap();
        for key in ["jobTitle", "turnBudgetUsd", "claudePath"] {
            assert!(
                json.contains(&format!("\"{key}\"")),
                "missing {key} in {json}"
            );
        }
        for (effort, word) in [(Effort::XHigh, "xhigh"), (Effort::Max, "max")] {
            let settings = Settings {
                effort,
                ..settings.clone()
            };
            write_to(&path, &settings).unwrap();
            assert_eq!(read_from(&path).unwrap(), settings);
            let saved: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(saved["effort"], word);
        }
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn broken_file_names_the_path() {
        let path = scratch_file("broken");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"not json").unwrap();
        let error = read_from(&path).unwrap_err();
        assert!(matches!(error, SettingsError::Json { .. }));
        assert!(error.to_string().contains(FILE_NAME));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn default_settings_match_the_ui_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../ui/bridge/default-settings.json")).unwrap();
        assert_eq!(fixture, serde_json::to_value(Settings::default()).unwrap());
    }

    #[test]
    fn json_uses_camel_case_for_the_frontend() {
        let json = serde_json::to_string(&Settings::default()).unwrap();
        assert!(json.contains("\"reducedMotion\""));
        assert!(!json.contains("reduced_motion"));
    }
}
