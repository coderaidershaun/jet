//! Starts the libraries' shared servers and brings them in line with the saved settings.

use agent::SharedServers;
use tauri::{AppHandle, State};

use super::error::BridgeError;
use crate::settings;

/// Starts the shared servers the saved settings ask for. When the settings cannot be read
/// no server is shared, and every reply starts its own copies.
pub fn start(app: &AppHandle) -> SharedServers {
    let libraries = SharedServers::new();
    match settings::settings_path(app).and_then(|path| settings::read_from(&path)) {
        Ok(saved) => libraries.configure(&saved.mcp),
        Err(error) => eprintln!("jet: the libraries could not start: {error}"),
    }
    libraries
}

/// Reads the saved settings again and brings the shared servers in line with them: a server
/// that changed or was switched off is stopped, and a new or changed one is started.
#[tauri::command]
pub async fn mcp_reload(
    app: AppHandle,
    libraries: State<'_, SharedServers>,
) -> Result<(), BridgeError> {
    let servers = settings::read_from(&settings::settings_path(&app)?)?.mcp;
    let libraries = libraries.inner().clone();
    tauri::async_runtime::spawn_blocking(move || libraries.configure(&servers))
        .await
        .map_err(|error| BridgeError::Io(error.to_string()))
}
