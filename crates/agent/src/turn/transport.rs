//! The one door to Claude: a `Transport` takes a request and hands back the stream of
//! lines. The real one starts Claude Code; a remote one could stand in later.

use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};

use crate::chat::{Effort, Model, SessionId};

/// Starts one request to Claude and streams its output.
pub trait Transport: Send + Sync {
    /// Begins the request. Failing here means nothing was started.
    fn start(&self, request: &Request) -> Result<Lines, TransportError>;
}

/// Everything one run of Claude needs.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    /// The text sent on standard input.
    pub prompt: String,
    pub system_prompt: String,
    pub model: Model,
    pub effort: Effort,
    pub budget_usd: f64,
    pub session: SessionMode,
    /// A JSON schema the answer must follow, for requests that want structured output.
    pub schema: Option<serde_json::Value>,
    /// The MCP servers as Claude Code's config JSON; `None` for a run with no servers, such
    /// as the notes review.
    pub mcp_config: Option<String>,
}

/// How a request relates to Claude Code's saved conversations.
#[derive(Debug, Clone, PartialEq)]
pub enum SessionMode {
    New,
    Resume(SessionId),
    /// Leaves no conversation behind.
    Ephemeral,
}

/// What a started request gives back.
pub struct Lines {
    /// Each line of standard output, or the reason the run ended badly. The channel
    /// closes when the run is over.
    pub receiver: mpsc::Receiver<Result<String, TransportError>>,
    pub stopper: Stopper,
}

/// Ends a run early. Cloning it shares the same run.
#[derive(Clone)]
pub struct Stopper {
    stopped: Arc<AtomicBool>,
    kill: Arc<dyn Fn() + Send + Sync>,
}

impl Stopper {
    /// `kill` runs the first time `stop` is called.
    pub fn new(kill: impl Fn() + Send + Sync + 'static) -> Stopper {
        Stopper {
            stopped: Arc::new(AtomicBool::new(false)),
            kill: Arc::new(kill),
        }
    }

    /// A stopper for a run that never started: stopping it only sets the flag.
    pub(crate) fn inert() -> Stopper {
        Stopper::new(|| {})
    }

    pub fn stop(&self) {
        if !self.stopped.swap(true, Ordering::SeqCst) {
            (self.kill)();
        }
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("Claude Code was not found; looked in {}", searched.join(", "))]
    ClaudeMissing { searched: Vec<String> },
    #[error("could not start {program}: {source}")]
    Spawn {
        program: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("could not send the prompt to Claude Code: {source}")]
    Stdin {
        #[source]
        source: io::Error,
    },
    #[error("Claude Code exited with {}", describe_exit(*code))]
    Exited { code: Option<i32>, stderr: String },
    #[error("could not read Claude Code's output: {source}")]
    Read {
        #[source]
        source: io::Error,
    },
}

fn describe_exit(code: Option<i32>) -> String {
    match code {
        Some(code) => format!("code {code}"),
        None => "no exit code".to_owned(),
    }
}
