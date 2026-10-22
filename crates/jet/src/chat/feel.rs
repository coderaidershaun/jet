//! Runs classification away from the window's event thread.

use super::BridgeError;

#[tauri::command]
pub async fn feel_message(text: String) -> Result<agent::Feeling, BridgeError> {
    tauri::async_runtime::spawn_blocking(move || agent::feel_message(&text))
        .await
        .map_err(|_| BridgeError::Io("the feeling worker could not finish".into()))?
        .map_err(|error| BridgeError::Io(error.to_string()))
}
