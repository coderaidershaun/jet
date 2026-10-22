//! The desktop home of Jet: opens the window, remembers the user's settings, and connects
//! the chat and workstation pages to the agent crate.

mod chat;
mod settings;
mod workstation;

use tauri::Manager;

/// Why the app could not start.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("the window could not start: {0}")]
    Window(#[from] tauri::Error),
}

/// Runs the window until it closes.
pub fn run() -> Result<(), Error> {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            app.manage(chat::ChatState::new(data_dir));
            app.manage(chat::libraries::start(app.handle()));
            app.manage(workstation::WorkstationState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::load_settings,
            settings::save_settings,
            chat::provider::agent_status,
            chat::load_history,
            chat::send_message,
            chat::feel::feel_message,
            chat::stop_reply,
            chat::forget_conversation,
            chat::load_memory,
            chat::save_memory,
            chat::render_markdown,
            chat::read_library_image,
            chat::open_link,
            chat::libraries::mcp_call,
            chat::libraries::mcp_reload,
            workstation::workstation_start,
            workstation::workstation_command,
            workstation::workstation_stop
        ])
        .build(tauri::generate_context!())?;
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<workstation::WorkstationState>() {
                state.shutdown();
            }
            if let Some(state) = handle.try_state::<chat::ChatState>() {
                state.shutdown(handle);
            }
            // The reply stops before the libraries go, so Claude is not in the middle of a call when they do.
            if let Some(libraries) = handle.try_state::<agent::SharedServers>() {
                libraries.shutdown();
            }
        }
    });
    Ok(())
}
