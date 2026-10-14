//! Remembers how the user set Jet up: who Jet is, which model answers, where the behaviour
//! handle sits, how expressive each channel is, and the motion switches. Saved as JSON in
//! the app's config folder so the frontend finds Jet the way it left it.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use agent::{Effort, Model, Persona};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "settings.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub behaviour: Behaviour,
    pub expressiveness: Expressiveness,
    pub reduced_motion: bool,
    pub repeat: bool,
    pub persona: Persona,
    /// The body colour as red, green, blue; `None` keeps the rig's own colour.
    pub body_colour: Option<[u8; 3]>,
    pub model: Model,
    pub effort: Effort,
    /// The most one answer may cost, in US dollars.
    pub turn_budget_usd: f64,
    pub drawer_open: bool,
    /// Where Claude Code lives; `None` means look in the usual places.
    pub claude_path: Option<PathBuf>,
    pub workstation: Workstation,
}

/// Where polysim-bridge is, which strategy it shows and which trading engines it may attach to.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Workstation {
    /// `None` means not set up; the page then shows the setup card.
    pub bridge_path: Option<PathBuf>,
    /// The folder polysim-bridge runs in; `None` means the folder that holds the program.
    pub polysim_dir: Option<PathBuf>,
    pub strategy_id: String,
    /// `host:port` of each engine, in the order the link bar steps through them.
    pub links: Vec<String>,
    /// The link token, kept in plain text in this file.
    pub token: Option<String>,
}

// Written by hand so that logging the settings never prints the token.
impl std::fmt::Debug for Workstation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Workstation")
            .field("bridge_path", &self.bridge_path)
            .field("polysim_dir", &self.polysim_dir)
            .field("strategy_id", &self.strategy_id)
            .field("links", &self.links)
            .field("token", &self.token.as_ref().map(|_| "<hidden>"))
            .finish()
    }
}

/// Position on the behaviour wheel. Both axes run -1 to 1 and the point stays
/// inside the unit circle, so distance from the centre is the intensity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Behaviour {
    pub candid: f64,
    pub playful: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Expressiveness {
    pub master: f64,
    pub channels: Channels,
    pub follow: Follow,
}

/// Each channel runs 0 to 10.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Channels {
    pub shape: f64,
    pub eyes: f64,
    pub colour: f64,
    pub motion: f64,
}

/// A channel that follows takes the master value whenever the master moves.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Follow {
    pub shape: bool,
    pub eyes: bool,
    pub colour: bool,
    pub motion: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            behaviour: Behaviour::default(),
            expressiveness: Expressiveness::default(),
            reduced_motion: false,
            repeat: true,
            persona: Persona::default(),
            body_colour: None,
            model: Model::default(),
            effort: Effort::default(),
            turn_budget_usd: 10.0,
            drawer_open: true,
            claude_path: None,
            workstation: Workstation::default(),
        }
    }
}

impl Default for Workstation {
    fn default() -> Self {
        Workstation {
            bridge_path: Some(PathBuf::from(
                "/Users/shaun/Code/DEVELOPMENT/polysim/target/release/polysim-bridge",
            )),
            polysim_dir: Some(PathBuf::from("/Users/shaun/Code/DEVELOPMENT/polysim")),
            strategy_id: "strat-micro-recorder".into(),
            links: vec!["127.0.0.1:9310".into()],
            token: None,
        }
    }
}

impl Default for Behaviour {
    fn default() -> Self {
        Behaviour {
            candid: 0.55,
            playful: 0.35,
        }
    }
}

impl Default for Expressiveness {
    fn default() -> Self {
        Expressiveness {
            master: 6.0,
            channels: Channels::default(),
            follow: Follow::default(),
        }
    }
}

impl Default for Channels {
    fn default() -> Self {
        Channels {
            shape: 6.0,
            eyes: 4.0,
            colour: 6.0,
            motion: 6.0,
        }
    }
}

impl Default for Follow {
    fn default() -> Self {
        Follow {
            shape: true,
            eyes: false,
            colour: true,
            motion: true,
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
        assert_eq!(read_from(&path).unwrap(), Settings::default());
    }

    #[test]
    fn settings_survive_a_round_trip() {
        let path = scratch_file("roundtrip");
        let mut settings = Settings {
            behaviour: Behaviour {
                candid: -0.45,
                playful: -0.5,
            },
            reduced_motion: true,
            ..Settings::default()
        };
        settings.expressiveness.master = 2.5;
        settings.expressiveness.follow.eyes = true;
        write_to(&path, &settings).unwrap();
        assert_eq!(read_from(&path).unwrap(), settings);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn old_files_with_missing_fields_still_load() {
        let path = scratch_file("partial");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            br#"{"behaviour":{"candid":0.1},"turnBudgetUsd":1.0}"#,
        )
        .unwrap();
        let settings = read_from(&path).unwrap();
        assert_eq!(settings.behaviour.candid, 0.1);
        assert_eq!(settings.behaviour.playful, Behaviour::default().playful);
        assert_eq!(settings.expressiveness, Expressiveness::default());
        assert_eq!(settings.persona, Persona::default());
        assert_eq!(settings.body_colour, None);
        assert_eq!(settings.model, Model::Sonnet);
        assert_eq!(settings.effort, Effort::Medium);
        assert_eq!(settings.turn_budget_usd, 1.0);
        assert!(settings.drawer_open);
        assert_eq!(settings.claude_path, None);
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
            body_colour: Some([12, 200, 99]),
            model: Model::Opus,
            effort: Effort::High,
            turn_budget_usd: 2.5,
            drawer_open: false,
            claude_path: Some(PathBuf::from("/opt/tools/claude")),
            workstation: Workstation {
                bridge_path: Some(PathBuf::from("/opt/polysim/polysim-bridge")),
                polysim_dir: None,
                strategy_id: "strat-other".into(),
                links: vec!["10.0.0.5:9310".into(), "10.0.0.6:9310".into()],
                token: Some("s3cret".into()),
            },
            ..Settings::default()
        };
        write_to(&path, &settings).unwrap();
        assert_eq!(read_from(&path).unwrap(), settings);

        let json = std::fs::read_to_string(&path).unwrap();
        for key in [
            "jobTitle",
            "bodyColour",
            "turnBudgetUsd",
            "drawerOpen",
            "claudePath",
            "bridgePath",
            "polysimDir",
            "strategyId",
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
