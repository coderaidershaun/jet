//! One exchange with Claude: start a request and read it back as steps. A turn always ends
//! in exactly one of finished, stopped or failed, so the caller never waits for nothing.

mod claude;
mod error;
mod mood;
#[cfg(test)]
pub(crate) mod scripted;
mod stream;
mod transport;

use std::collections::VecDeque;
use std::sync::mpsc::{self, RecvTimeoutError, TryRecvError};
use std::time::Duration;

use serde_json::Value;

use crate::chat::{Mood, SessionId, Usage};
pub use claude::ClaudeCli;
pub use error::TurnError;
use mood::{MoodSplitter, Split};
use stream::{Line, ResultLine};
pub use transport::{Lines, Request, SessionMode, Stopper, Transport, TransportError};

/// How long Claude may stay silent before the turn gives up.
const IDLE_LIMIT: Duration = Duration::from_secs(120);

/// One thing that happened during a turn. The last step is always `Finished`, `Stopped`
/// or `Failed`, and there is never more than one of them.
#[derive(Debug)]
pub enum Step {
    /// A stdout line, untouched, before the steps made from it.
    Raw(String),
    Init {
        session_id: SessionId,
        model: String,
    },
    Mood(Mood),
    Text(String),
    Finished(Summary),
    Stopped,
    Failed(TurnError),
}

/// How a successful turn went.
#[derive(Debug)]
pub struct Summary {
    pub duration_ms: u64,
    pub cost_usd: f64,
    pub usage: Usage,
    /// Claude's final answer as plain text.
    pub result: String,
    /// The answer as data, when the request asked for a schema.
    pub structured_output: Option<Value>,
}

enum Arrival {
    Line(String),
    Error(TransportError),
    Stopped,
    Silent,
    Closed,
}

impl From<Result<String, TransportError>> for Arrival {
    fn from(item: Result<String, TransportError>) -> Arrival {
        match item {
            Ok(line) => Arrival::Line(line),
            Err(error) => Arrival::Error(error),
        }
    }
}

/// A running request, read one step at a time. Reading blocks until the next step.
pub struct Turn {
    receiver: mpsc::Receiver<Result<String, TransportError>>,
    stopper: Stopper,
    idle: Duration,
    splitter: MoodSplitter,
    queued: VecDeque<Step>,
    text: String,
    mood: Option<Mood>,
    init_model: String,
    saw_delta: bool,
    ended: bool,
}

impl Turn {
    /// Starts the request. Fails when nothing could be started at all.
    pub fn start(transport: &dyn Transport, request: &Request) -> Result<Turn, TurnError> {
        Turn::start_with_idle(transport, request, IDLE_LIMIT)
    }

    pub(crate) fn start_with_idle(
        transport: &dyn Transport,
        request: &Request,
        idle: Duration,
    ) -> Result<Turn, TurnError> {
        let Lines { receiver, stopper } = transport.start(request)?;
        Ok(Turn {
            receiver,
            stopper,
            idle,
            splitter: MoodSplitter::new(),
            queued: VecDeque::new(),
            text: String::new(),
            mood: None,
            init_model: String::new(),
            saw_delta: false,
            ended: false,
        })
    }

    pub fn stopper(&self) -> Stopper {
        self.stopper.clone()
    }

    /// The reply text read so far, without the mood line.
    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn mood(&self) -> Option<Mood> {
        self.mood
    }

    fn advance(&mut self) {
        match self.next_arrival() {
            Arrival::Line(line) => self.take_line(line),
            Arrival::Error(error) => self.end(Step::Failed(error.into())),
            Arrival::Stopped => self.end(Step::Stopped),
            Arrival::Silent => {
                self.stopper.stop();
                self.end(Step::Failed(TurnError::Timeout { idle: self.idle }));
            }
            Arrival::Closed => self.end(Step::Failed(TurnError::NoResult)),
        }
    }

    /// Waits for the transport. A line already queued is read even after a stop, so no
    /// text that arrived before the stop is lost.
    fn next_arrival(&self) -> Arrival {
        match self.receiver.try_recv() {
            Ok(item) => return Arrival::from(item),
            Err(TryRecvError::Empty) if self.stopper.is_stopped() => return Arrival::Stopped,
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => return self.closed(),
        }
        match self.receiver.recv_timeout(self.idle) {
            Ok(item) => Arrival::from(item),
            Err(RecvTimeoutError::Timeout) => Arrival::Silent,
            Err(RecvTimeoutError::Disconnected) => self.closed(),
        }
    }

    fn closed(&self) -> Arrival {
        if self.stopper.is_stopped() {
            Arrival::Stopped
        } else {
            Arrival::Closed
        }
    }

    fn take_line(&mut self, line: String) {
        let parsed = stream::parse(&line);
        self.queued.push_back(Step::Raw(line));
        match parsed {
            Line::Init { session_id, model } => {
                self.init_model.clone_from(&model);
                self.queued.push_back(Step::Init { session_id, model });
            }
            Line::TextDelta(delta) => {
                self.saw_delta = true;
                let split = self.splitter.push(&delta);
                self.release(split);
            }
            Line::Result(result) => self.take_result(result),
            Line::Other => {}
        }
    }

    fn take_result(&mut self, mut result: ResultLine) {
        if let Some((subtype, message)) = result.failure() {
            return self.end(Step::Failed(TurnError::Reported { subtype, message }));
        }
        if !self.saw_delta {
            let text = result.result.as_deref().unwrap_or_default();
            let split = self.splitter.push(text);
            self.release(split);
        }
        if result.usage.model.is_empty() {
            result.usage.model.clone_from(&self.init_model);
        }
        self.end(Step::Finished(Summary {
            duration_ms: result.duration_ms,
            cost_usd: result.cost_usd,
            usage: result.usage,
            result: result.result.unwrap_or_default(),
            structured_output: result.structured_output,
        }));
    }

    fn release(&mut self, split: Split) {
        if let Some(mood) = split.mood {
            self.mood = Some(mood);
            self.queued.push_back(Step::Mood(mood));
        }
        if !split.text.is_empty() {
            self.text.push_str(&split.text);
            self.queued.push_back(Step::Text(split.text));
        }
    }

    /// Queues the closing step, after any text still held back.
    fn end(&mut self, last: Step) {
        let rest = self.splitter.finish();
        self.release(rest);
        self.queued.push_back(last);
        self.ended = true;
    }
}

impl Iterator for Turn {
    type Item = Step;

    fn next(&mut self) -> Option<Step> {
        loop {
            if let Some(step) = self.queued.pop_front() {
                return Some(step);
            }
            if self.ended {
                return None;
            }
            self.advance();
        }
    }
}

impl Drop for Turn {
    fn drop(&mut self) {
        self.stopper.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::scripted::{
        Script, Scripted, delta_line, error_result_line, init_line, reply_lines, result_line,
    };
    use super::*;
    use crate::chat::{Effort, Model};

    fn request() -> Request {
        Request {
            prompt: "hi".into(),
            system_prompt: String::new(),
            model: Model::Sonnet,
            effort: Effort::Low,
            budget_usd: 1.0,
            session: SessionMode::New,
            schema: None,
        }
    }

    fn is_terminal(step: &Step) -> bool {
        matches!(step, Step::Finished(_) | Step::Stopped | Step::Failed(_))
    }

    fn drain(script: Script, idle: Duration, stop_first: bool) -> Vec<Step> {
        let transport = Scripted::new().then(script);
        let mut turn = Turn::start_with_idle(&transport, &request(), idle).unwrap();
        if stop_first {
            turn.stopper().stop();
        }
        let steps: Vec<Step> = turn.by_ref().collect();
        assert!(turn.next().is_none(), "a turn must stay ended");
        steps
    }

    #[test]
    fn every_turn_ends_with_exactly_one_terminal_event() {
        let patient = Duration::from_secs(5);
        let quick = Duration::from_millis(40);
        let broken_pipe = || TransportError::Read {
            source: std::io::Error::other("pipe broke"),
        };
        let mut lines = reply_lines("s1", "mood: happy\nHi there");
        let cases = [
            (
                "success",
                drain(Script::lines(lines.clone()), patient, false),
            ),
            (
                "reported error",
                drain(
                    Script::lines(vec![init_line("s1"), error_result_line("budget used up")]),
                    patient,
                    false,
                ),
            ),
            (
                "transport error",
                drain(
                    Script::lines(vec![init_line("s1"), delta_line("Par")])
                        .then_error(broken_pipe()),
                    patient,
                    false,
                ),
            ),
            (
                "closed without a result",
                drain(Script::lines(vec![init_line("s1")]), patient, false),
            ),
            (
                "stopped",
                drain(
                    Script::lines(vec![init_line("s1")]).hanging(),
                    patient,
                    true,
                ),
            ),
            (
                "gone quiet",
                drain(Script::lines(vec![init_line("s1")]).hanging(), quick, false),
            ),
        ];
        for (name, steps) in &cases {
            let terminal = steps.iter().filter(|step| is_terminal(step)).count();
            assert_eq!(terminal, 1, "{name}: {steps:?}");
            assert!(is_terminal(steps.last().unwrap()), "{name}: {steps:?}");
        }
        assert!(matches!(
            cases[5].1.last(),
            Some(Step::Failed(TurnError::Timeout { .. }))
        ));

        let Some(Step::Finished(summary)) = cases[0].1.last() else {
            panic!("the success case finishes");
        };
        assert_eq!(summary.usage.model, "claude-fake");

        // A result line ends the turn even if the process lingers.
        lines.push(result_line("ignored"));
        let steps = drain(Script::lines(lines).hanging(), patient, false);
        assert_eq!(steps.iter().filter(|step| is_terminal(step)).count(), 1);
        let texts: Vec<&str> = steps
            .iter()
            .filter_map(|step| match step {
                Step::Text(text) => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(texts, ["Hi there"]);
        assert!(
            steps
                .iter()
                .any(|step| matches!(step, Step::Mood(Mood::Happy)))
        );
    }
}
