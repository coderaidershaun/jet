//! Save Jet's settings in the app's config folder so each launch restores the user's choices.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use agent::{Effort, McpServers, Model, Persona};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

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
    pub drawer_open: bool,
    /// Where Claude Code lives; `None` means look in the usual places.
    pub claude_path: Option<PathBuf>,
    pub codex_path: Option<PathBuf>,
    /// The library servers Jet's agent may use: the quanty library and the polysim engines.
    pub mcp: McpServers,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            reduced_motion: false,
            persona: Persona::default(),
            model: Model::default(),
            effort: Effort::default(),
            turn_budget_usd: 10.0,
            drawer_open: true,
            claude_path: None,
            codex_path: None,
            mcp: McpServers::default(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("could not find the app config folder: {0}")]
    ConfigDir(#[from] tauri::Error),
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
    std::fs::write(path, json).map_err(io)
}

pub fn settings_path(app: &AppHandle) -> Result<PathBuf, SettingsError> {
    Ok(app.path().app_config_dir()?.join(FILE_NAME))
}

#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<Settings, String> {
    settings_path(&app)
        .and_then(|path| read_from(&path))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    settings_path(&app)
        .and_then(|path| write_to(&path, &settings))
        .map_err(|error| error.to_string())
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
        assert_eq!(settings.mcp.enabled().count(), 0);
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
        assert!(settings.drawer_open);
        assert_eq!(settings.claude_path, None);
        assert_eq!(settings.mcp, Settings::default().mcp);
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
        ] {
            assert!(saved.get(key).is_none(), "removed {key} was saved");
        }
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn new_fields_round_trip() {
        let path = scratch_file("new-fields");
        let mut mcp = Settings::default().mcp;
        mcp.quanty.enabled = false;
        mcp.polysim.cwd = None;
        let settings = Settings {
            persona: Persona {
                name: "Ada".into(),
                job_title: "Co-pilot".into(),
                notes: "Short answers.".into(),
            },
            model: Model::Opus,
            effort: Effort::High,
            turn_budget_usd: 2.5,
            drawer_open: false,
            claude_path: Some(PathBuf::from("/opt/tools/claude")),
            mcp,
            ..Settings::default()
        };
        write_to(&path, &settings).unwrap();
        assert_eq!(read_from(&path).unwrap(), settings);

        let json = std::fs::read_to_string(&path).unwrap();
        for key in [
            "jobTitle",
            "turnBudgetUsd",
            "drawerOpen",
            "claudePath",
            "mcp",
        ] {
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
