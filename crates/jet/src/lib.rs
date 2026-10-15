//! This crate is the desktop home of Jet, the first-mate character: it ships the character
//! definition inside the binary, opens the window that animates it, remembers how the
//! user dialled Jet in between launches, and connects the chat page and the workstation page to
//! the agent crate.

mod chat;
mod rig;
mod settings;
mod workstation;

use tauri::Manager;

/// Why the app could not start.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Rig(#[from] rig::RigError),
    #[error("the window could not start: {0}")]
    Window(#[from] tauri::Error),
}

/// Checks the embedded character definition, then runs the window until it closes.
pub fn run() -> Result<(), Error> {
    rig::Rig::embedded()?;
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            app.manage(chat::ChatState::new(data_dir));
            app.manage(workstation::WorkstationState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rig::rig,
            settings::load_settings,
            settings::save_settings,
            chat::agent_status,
            chat::load_history,
            chat::send_message,
            chat::stop_reply,
            chat::forget_conversation,
            chat::load_memory,
            chat::save_memory,
            chat::render_markdown,
            chat::open_link,
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
        }
    });
    Ok(())
}
