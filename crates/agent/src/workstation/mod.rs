//! Keeps the workstation's polysim-bridge program running and passes what it says to the page.

mod line;
mod sink;
mod supervisor;

use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

pub use line::BridgeStatus;
use supervisor::Shared;

/// The delays between restarts of a bridge that keeps failing; the last one repeats.
pub const RESTART_DELAYS: [Duration; 4] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
];

/// How to run polysim-bridge. Printing it with `Debug` hides the token.
#[derive(Clone)]
pub struct BridgeLaunch {
    pub program: PathBuf,
    /// The folder the program runs in.
    pub cwd: PathBuf,
    pub strategy_id: String,
    /// `host:port` of each trading engine it may attach to, in order.
    pub links: Vec<String>,
    pub token: Option<String>,
    /// The waits between runs that fail. Jet passes `RESTART_DELAYS`; an empty list means the same.
    pub restart_delays: Vec<Duration>,
}

impl fmt::Debug for BridgeLaunch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BridgeLaunch")
            .field("program", &self.program)
            .field("cwd", &self.cwd)
            .field("strategy_id", &self.strategy_id)
            .field("links", &self.links)
            .field("token", &self.token.as_ref().map(|_| "<hidden>"))
            .field("restart_delays", &self.restart_delays)
            .finish()
    }
}

/// The running polysim-bridge, started again when it fails. Dropping it stops it.
///
/// The arguments are `--strategy <id>`, then `--link <host:port>` for each link, then
/// `--token <token>` when there is one.
pub struct BridgeFeed {
    shared: Arc<Shared>,
}

impl BridgeFeed {
    /// Starts the supervisor thread and returns at once. Every line for the page, each line of
    /// the bridge's standard output and Jet's own `bridge` status lines, goes to `sink` as one
    /// JSON object in a string, in order and one call at a time. Only lines that are a whole
    /// JSON object with a string `kind` are passed on.
    ///
    /// `sink` must not wait for the main thread and must not call back into this feed.
    pub fn start(launch: BridgeLaunch, sink: impl FnMut(String) + Send + 'static) -> BridgeFeed {
        let shared = Arc::new(Shared::new(Box::new(sink)));
        let supervisor = Arc::clone(&shared);
        // Never joined: a bridge stuck on a pipe must not keep the app from quitting. The thread
        // ends by itself once the bridge's output closes.
        thread::spawn(move || supervisor::supervise(&supervisor, &launch));
        BridgeFeed { shared }
    }

    /// Queues one command for the bridge's input; a newline is added. Never waits.
    ///
    /// # Errors
    /// [`FeedError::NotRunning`] when the bridge is not running right now.
    pub fn send(&self, command: &str) -> Result<(), FeedError> {
        self.shared.send(command)
    }

    /// Gives the running bridge to a new sink, for a page that reloaded and lost the old one.
    /// The bridge keeps running. The new sink is first given the lines it missed: Jet's newest
    /// `bridge` line, then the newest `hello`, `link`, `lifecycle` and `catalog` of the current
    /// run, word for word. Then the bridge is asked to say everything again with a `resync`
    /// command, and the old sink is never called again. Never waits. The new sink follows the
    /// same rules as the one given to `start`.
    ///
    /// Returns `false`, and drops `sink`, when the feed is over: it was stopped, the program was
    /// missing, it spoke another protocol, or it kept failing at once. The caller then starts a
    /// new feed.
    pub fn reattach(&self, sink: impl FnMut(String) + Send + 'static) -> bool {
        self.shared.reattach(Box::new(sink))
    }

    /// Ends the bridge for good: closes its input, gives it one second to leave, then kills it.
    /// After `stop` returns the sink is never called again. Calling it twice is fine.
    ///
    /// Two short windows exist in which a process outlives this call. A bridge that was just
    /// being started is killed by the supervisor right after. A bridge that the supervisor is
    /// already ending, because it speaks the wrong protocol or closed its output, is in its own
    /// second of grace. Both end within a second, and polysim-bridge also exits by itself when
    /// its input closes, which happens when Jet's process ends.
    pub fn stop(&self) {
        self.shared.stop();
    }
}

impl Drop for BridgeFeed {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Debug, thiserror::Error)]
pub enum FeedError {
    #[error("polysim-bridge is not running")]
    NotRunning,
}
