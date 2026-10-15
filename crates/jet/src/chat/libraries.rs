//! The page's way to the libraries' shared servers: calling one of the engine tools, and
//! bringing the servers in line with the saved settings.

use agent::SharedServers;
use serde_json::Value;
use tauri::{AppHandle, State};

use super::error::BridgeError;
use crate::settings;

/// The only tools the page may call: polysim's engine tools. The page has no business with
/// quanty's paid tools, so a mistake in the page can never spend money there.
const PAGE_TOOLS: [(&str, &str); 4] = [
    ("polysim", "list_strategies"),
    ("polysim", "start_strategy"),
    ("polysim", "stop_strategy"),
    ("polysim", "set_execution_mode"),
];

fn page_may_call(server: &str, tool: &str) -> bool {
    PAGE_TOOLS.contains(&(server, tool))
}

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

/// Calls one of polysim's engine tools on its shared server and returns the tool's result:
/// its structured content, else its text as JSON, else the text. Fails with the kind
/// `library` when the server is not shared, refused, or did not answer within 30 seconds.
#[tauri::command]
pub async fn mcp_call(
    libraries: State<'_, SharedServers>,
    server: String,
    tool: String,
    args: Value,
) -> Result<Value, BridgeError> {
    if !page_may_call(&server, &tool) {
        return Err(BridgeError::Library(format!(
            "the page may not call {server} {tool}"
        )));
    }
    let libraries = libraries.inner().clone();
    let called =
        tauri::async_runtime::spawn_blocking(move || libraries.call(&server, &tool, args)).await;
    called
        .map_err(|error| BridgeError::Io(error.to_string()))?
        .map_err(BridgeError::from)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_reaches_only_the_engine_tools() {
        for tool in [
            "list_strategies",
            "start_strategy",
            "stop_strategy",
            "set_execution_mode",
        ] {
            assert!(page_may_call("polysim", tool), "polysim {tool}");
        }
        assert!(!page_may_call("quanty", "ingest_pdf"));
        assert!(!page_may_call("quanty", "answer"));
        assert!(!page_may_call("quanty", "list_strategies"));
        assert!(!page_may_call("nobody", "list_strategies"));
        assert!(!page_may_call("polysim", "anything_else"));
    }
}
