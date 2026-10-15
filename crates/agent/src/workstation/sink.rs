//! Where the feed's lines go, and the newest lines of the current run, so that a page that
//! reloads can be told again what it missed.

use std::mem;

use super::line::BridgeStatus;

/// The kinds of bridge line a page needs again after a reload, in the order they are sent.
const REPLAYED: [&str; 4] = ["hello", "link", "lifecycle", "catalog"];

pub(super) type Call = Box<dyn FnMut(String) + Send>;

pub(super) struct Sink {
    call: Call,
    /// Jet's newest `bridge` line.
    status: Option<String>,
    /// The newest line of each kind in `REPLAYED` that the current run sent.
    run_lines: [Option<String>; REPLAYED.len()],
    /// The feed cannot run again, so a page that wants one must start a new feed.
    has_ended: bool,
}

impl Sink {
    pub(super) fn new(call: Call) -> Sink {
        Sink {
            call,
            status: None,
            run_lines: Default::default(),
            has_ended: false,
        }
    }

    /// Sends one of Jet's own lines. The lines of a run that ended are out of date from then on,
    /// and a bridge that will not be started again ends the feed.
    pub(super) fn send_status(&mut self, status: BridgeStatus, line: String) {
        match status {
            BridgeStatus::Starting => {}
            BridgeStatus::Restarting => self.run_lines = Default::default(),
            BridgeStatus::Exited | BridgeStatus::Missing => self.has_ended = true,
        }
        self.status = Some(line.clone());
        (self.call)(line);
    }

    /// Sends a line the bridge wrote.
    pub(super) fn send_bridge_line(&mut self, kind: &str, line: String) {
        if let Some(index) = REPLAYED.iter().position(|replayed| *replayed == kind) {
            self.run_lines[index] = Some(line.clone());
        }
        (self.call)(line);
    }

    pub(super) fn has_ended(&self) -> bool {
        self.has_ended
    }

    /// Hands the lines to a new call from now on, and sends it first what the old one has been
    /// told: Jet's newest line, then the run's newest of each kind. Returns the old call, so that
    /// the caller drops it where no lock is held.
    pub(super) fn take_over(&mut self, call: Call) -> Call {
        let old = mem::replace(&mut self.call, call);
        for line in self.status.iter().chain(self.run_lines.iter().flatten()) {
            (self.call)(line.clone());
        }
        old
    }
}
