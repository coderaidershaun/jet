//! Jet is the first-mate character. This crate is its desktop home: it ships the
//! character definition inside the binary, opens the window that animates it, and
//! remembers how the user dialled Jet in between launches.

mod rig;
mod settings;

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
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            rig::rig,
            settings::load_settings,
            settings::save_settings
        ])
        .run(tauri::generate_context!())?;
    Ok(())
}
