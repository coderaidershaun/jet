//! Desktop entry point: starts the Jet window and turns a start-up failure into an exit code.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(error) = jet::run() {
        eprintln!("jet: {error}");
        std::process::exit(1);
    }
}
