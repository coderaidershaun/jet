//! A transport that replays prepared lines, so the code above it can be tested without
//! starting Claude Code.

use std::collections::VecDeque;
use std::sync::{Mutex, mpsc};

use serde_json::{Value, json};

use super::transport::{Lines, Request, Stopper, Transport, TransportError};

/// What one `start` call does.
pub(crate) struct Script {
    outcome: Outcome,
}

enum Outcome {
    CannotStart(TransportError),
    Lines {
        items: Vec<Result<String, TransportError>>,
        hang: bool,
    },
}

impl Script {
    pub fn lines(lines: Vec<String>) -> Script {
        Script {
            outcome: Outcome::Lines {
                items: lines.into_iter().map(Ok).collect(),
                hang: false,
            },
        }
    }

    pub fn cannot_start(error: TransportError) -> Script {
        Script {
            outcome: Outcome::CannotStart(error),
        }
    }

    /// Ends the stream with a transport error.
    pub fn then_error(mut self, error: TransportError) -> Script {
        if let Outcome::Lines { items, .. } = &mut self.outcome {
            items.push(Err(error));
        }
        self
    }

    /// Keeps the stream open after the last line, like a run that has gone quiet.
    pub fn hanging(mut self) -> Script {
        if let Outcome::Lines { hang, .. } = &mut self.outcome {
            *hang = true;
        }
        self
    }
}

type Hook = Box<dyn Fn() + Send + Sync>;

#[derive(Default)]
pub(crate) struct Scripted {
    scripts: Mutex<VecDeque<Script>>,
    requests: Mutex<Vec<Request>>,
    open_ends: Mutex<Vec<mpsc::Sender<Result<String, TransportError>>>>,
    before_start: Option<Hook>,
}

impl Scripted {
    pub fn new() -> Scripted {
        Scripted::default()
    }

    /// Queues what the next unused `start` call does.
    pub fn then(self, script: Script) -> Scripted {
        self.scripts.lock().unwrap().push_back(script);
        self
    }

    /// Runs `hook` at the beginning of every `start`.
    pub fn before_start(mut self, hook: impl Fn() + Send + Sync + 'static) -> Scripted {
        self.before_start = Some(Box::new(hook));
        self
    }

    /// Every request received so far, oldest first.
    pub fn requests(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }
}

impl Transport for Scripted {
    fn start(&self, request: &Request) -> Result<Lines, TransportError> {
        if let Some(hook) = &self.before_start {
            hook();
        }
        self.requests.lock().unwrap().push(request.clone());
        let script = self
            .scripts
            .lock()
            .unwrap()
            .pop_front()
            .expect("the scripted transport has no script left for this request");
        match script.outcome {
            Outcome::CannotStart(error) => Err(error),
            Outcome::Lines { items, hang } => {
                let (sender, receiver) = mpsc::channel();
                for item in items {
                    sender.send(item).unwrap();
                }
                if hang {
                    self.open_ends.lock().unwrap().push(sender);
                }
                Ok(Lines {
                    receiver,
                    stopper: Stopper::inert(),
                })
            }
        }
    }
}

pub(crate) fn init_line(session_id: &str) -> String {
    json!({"type": "system", "subtype": "init", "session_id": session_id, "model": "claude-fake"})
        .to_string()
}

pub(crate) fn delta_line(text: &str) -> String {
    json!({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
        "delta": {"type": "text_delta", "text": text}}})
    .to_string()
}

fn result_value(subtype: &str, is_error: bool, result: &str) -> Value {
    json!({"type": "result", "subtype": subtype, "is_error": is_error, "result": result,
        "duration_ms": 1200, "total_cost_usd": 0.01,
        "usage": {"input_tokens": 10, "cache_read_input_tokens": 1000,
                  "cache_creation_input_tokens": 200,
                  "cache_creation": {"ephemeral_1h_input_tokens": 200}}})
}

pub(crate) fn result_line(result: &str) -> String {
    result_value("success", false, result).to_string()
}

pub(crate) fn error_result_line(message: &str) -> String {
    result_value("error_during_execution", true, message).to_string()
}

pub(crate) fn structured_result_line(output: &Value) -> String {
    let mut value = result_value("success", false, "");
    value["structured_output"] = output.clone();
    value.to_string()
}

/// A whole successful reply: init, one text delta, result.
pub(crate) fn reply_lines(session_id: &str, text: &str) -> Vec<String> {
    vec![init_line(session_id), delta_line(text), result_line(text)]
}
