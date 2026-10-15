//! The workstation page's way to polysim-bridge: start it from the settings, stream its lines to
//! the page, pass the page's commands to it, and stop it.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use agent::{BridgeFeed, BridgeLaunch, BridgeStatus, RESTART_DELAYS};
use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::chat::BridgeError;
use crate::settings;

/// The running polysim-bridge, if the workstation page started one.
#[derive(Default)]
pub struct WorkstationState {
    running: Mutex<Option<Running>>,
}

/// A bridge that is kept running, and the settings it was started from.
struct Running {
    feed: BridgeFeed,
    settings: settings::Workstation,
}

impl WorkstationState {
    /// Called when the app closes: ends polysim-bridge before anything else is waited for.
    pub fn shutdown(&self) {
        let running = lock(&self.running).take();
        if let Some(running) = running {
            running.feed.stop();
        }
    }
}

/// A lock that still opens after another thread panicked while holding it.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The folder polysim-bridge runs in: the one that is set, or else the one that holds the program.
fn working_folder(configured: Option<PathBuf>, program: &Path) -> PathBuf {
    configured
        .or_else(|| program.parent().map(Path::to_path_buf))
        .filter(|folder| !folder.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from("."))
}

/// What carries each line of the bridge to the page, as the JSON object it is. A page that went
/// away is not an error.
fn to_page(events: Channel<InvokeResponseBody>) -> impl FnMut(String) + Send + 'static {
    move |line| {
        events.send(InvokeResponseBody::Json(line)).ok();
    }
}

/// Streams the lines of polysim-bridge over `events`, started from the page's workstation
/// settings. When the bridge runs from the same settings, a page that reloaded gets that bridge
/// back, so its link to the engine is not dropped; otherwise a bridge that runs is stopped first.
#[tauri::command]
pub async fn workstation_start(
    state: State<'_, WorkstationState>,
    workstation: settings::Workstation,
    events: Channel<InvokeResponseBody>,
) -> Result<(), BridgeError> {
    // Held while the new channel is sent the lines it missed and the old channel is dropped, so no
    // other start can take this bridge away in between. Sending and dropping a channel only post
    // to the webview; they must never wait for the main thread, which takes this lock when the
    // app closes.
    {
        let slot = lock(&state.running);
        if let Some(running) = slot.as_ref()
            && running.settings == workstation
            && running.feed.reattach(to_page(events.clone()))
        {
            return Ok(());
        }
    }
    // Stopped with no lock held: stopping can take a second.
    let old = lock(&state.running).take();
    if let Some(old) = old {
        old.feed.stop();
    }
    let settings = workstation.clone();
    let Some(program) = workstation.bridge_path else {
        let mut tell_page = to_page(events);
        tell_page(BridgeStatus::Missing.line("No polysim-bridge is set in Settings."));
        return Ok(());
    };
    let launch = BridgeLaunch {
        cwd: working_folder(workstation.polysim_dir, &program),
        program,
        strategy_id: workstation.strategy_id,
        links: workstation.links,
        token: workstation.token,
        restart_delays: RESTART_DELAYS.to_vec(),
    };
    let feed = BridgeFeed::start(launch, to_page(events));
    // Another start may have stored a bridge since the one above; it is stopped here, where no
    // lock is held.
    let replaced = lock(&state.running).replace(Running { feed, settings });
    if let Some(replaced) = replaced {
        replaced.feed.stop();
    }
    Ok(())
}

/// Sends one command object to polysim-bridge.
#[tauri::command]
pub async fn workstation_command(
    state: State<'_, WorkstationState>,
    command: serde_json::Value,
) -> Result<(), BridgeError> {
    if !command.is_object() {
        return Err(BridgeError::Io(
            "a workstation command is a JSON object".into(),
        ));
    }
    // Printed without line breaks, so it is one line on the bridge's input.
    let line = command.to_string();
    let slot = lock(&state.running);
    let Some(running) = slot.as_ref() else {
        return Err(BridgeError::Io(agent::FeedError::NotRunning.to_string()));
    };
    running
        .feed
        .send(&line)
        .map_err(|error| BridgeError::Io(error.to_string()))
}

/// Stops polysim-bridge. Nothing happens when it is not running.
#[tauri::command]
pub async fn workstation_stop(state: State<'_, WorkstationState>) -> Result<(), BridgeError> {
    let running = lock(&state.running).take();
    if let Some(running) = running {
        running.feed.stop();
    }
    Ok(())
}
