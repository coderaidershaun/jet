//! One exchange with an agent: start a request and read it back as steps. A turn always ends
//! in exactly one of finished, stopped or failed, so the caller never waits for nothing.

mod context;
mod error;
mod mood;
mod stream;
mod tools;
mod transport;

use std::collections::VecDeque;
use std::sync::mpsc::{self, RecvTimeoutError, TryRecvError};
use std::time::Duration;

use serde_json::Value;

use crate::chat::{McpStatus, Mood, SessionId, ToolCall, Usage};
pub use error::TurnError;
use mood::{MoodSplitter, Split};
use stream::{Line, ResultLine};
use tools::ToolCalls;
#[cfg(test)]
pub(crate) use transport::scripted;
pub use transport::{
    ClaudeCli, CodexCli, Lines, Request, SessionMode, Stopper, Transport, TransportError,
};

/// How long the agent may stay silent before the turn gives up.
const IDLE_LIMIT: Duration = Duration::from_secs(120);

/// While a tool runs, the agent may stay silent this many times as long, because a library
/// answer can take minutes.
const TOOL_IDLE_FACTOR: u32 = 3;

/// One thing that happened during a turn. The last step is always `Finished`, `Stopped`
/// or `Failed`, and there is never more than one of them.
#[derive(Debug)]
pub enum Step {
    /// A transport line before the steps made from it.
    Raw(String),
    Init {
        session_id: SessionId,
        model: String,
        mcp: Vec<McpStatus>,
    },
    Mood(Mood),
    Text(String),
    /// An MCP tool call has started.
    ToolStarted {
        id: String,
        server: String,
        tool: String,
        input: Value,
    },
    /// An MCP tool call came back.
    ToolFinished(ToolCall),
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
    pub context: crate::chat::ContextStatus,
    /// The model's final answer as plain text.
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
    tools: ToolCalls,
    text: String,
    mood: Option<Mood>,
    init_model: String,
    context: context::ContextReader,
    saw_delta: bool,
    needs_paragraph_break: bool,
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
            tools: ToolCalls::new(),
            text: String::new(),
            mood: None,
            init_model: String::new(),
            context: context::ContextReader::default(),
            saw_delta: false,
            needs_paragraph_break: false,
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

    /// The MCP tool calls that have come back so far, in the order they did.
    pub fn tools(&self) -> &[ToolCall] {
        self.tools.done()
    }

    fn advance(&mut self) {
        match self.next_arrival() {
            Arrival::Line(line) => self.take_line(line),
            Arrival::Error(error) => self.end(Step::Failed(error.into())),
            Arrival::Stopped => self.end(Step::Stopped),
            Arrival::Silent => {
                self.stopper.stop();
                self.end(Step::Failed(TurnError::Timeout {
                    idle: self.silence_limit(),
                }));
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
        match self.receiver.recv_timeout(self.silence_limit()) {
            Ok(item) => Arrival::from(item),
            Err(RecvTimeoutError::Timeout) => Arrival::Silent,
            Err(RecvTimeoutError::Disconnected) => self.closed(),
        }
    }

    fn silence_limit(&self) -> Duration {
        if self.tools.running() {
            self.idle * TOOL_IDLE_FACTOR
        } else {
            self.idle
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
        self.context.read(&line);
        let parsed = stream::parse(&line);
        self.queued.push_back(Step::Raw(line));
        match parsed {
            Line::Init {
                session_id,
                model,
                mcp,
            } => {
                self.init_model.clone_from(&model);
                self.queued.push_back(Step::Init {
                    session_id,
                    model,
                    mcp,
                });
            }
            Line::MessageStart => self.begin_call(),
            Line::TextDelta(delta) => {
                self.saw_delta = true;
                let split = self.splitter.push(&delta);
                self.release(split);
            }
            Line::ToolUses(uses) => self.queued.extend(self.tools.start(uses)),
            Line::ToolResults(results) => self.queued.extend(self.tools.finish(results)),
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
            context: self.context.finish(),
            result: result.result.unwrap_or_default(),
            structured_output: result.structured_output,
        }));
    }

    fn begin_call(&mut self) {
        let rest = self.splitter.finish();
        self.release(rest);
        self.splitter = MoodSplitter::new();
        self.needs_paragraph_break = !self.text.is_empty();
    }

    fn release(&mut self, mut split: Split) {
        if let Some(mood) = split.mood
            && self.mood.is_none()
        {
            self.mood = Some(mood);
            self.queued.push_back(Step::Mood(mood));
        }
        if !split.text.is_empty() {
            if std::mem::take(&mut self.needs_paragraph_break) {
                split.text.insert_str(0, "\n\n");
            }
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
    use serde_json::json;

    use super::scripted::{
        Script, Scripted, delta_line, error_result_line, init_line, message_start_line,
        reply_lines, request, result_line, tool_result_line, tool_use_line,
    };
    use super::*;
    use crate::chat::Failure;

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
        let mut lines = reply_lines("s1", "mood: hello\nHi there");
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
            (
                "gone quiet during a tool",
                drain(
                    Script::lines(vec![
                        init_line("s1"),
                        tool_use_line(&[("a", "mcp__quanty__search", json!({}))]),
                    ])
                    .hanging(),
                    quick,
                    false,
                ),
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
        assert!(
            matches!(
                cases[6].1.last(),
                Some(Step::Failed(TurnError::Timeout { idle })) if *idle == quick * 3
            ),
            "a running tool gets three times the silence: {:?}",
            cases[6].1
        );
        for (idle, minutes) in [(IDLE_LIMIT, 2), (IDLE_LIMIT * TOOL_IDLE_FACTOR, 6)] {
            let failure = Failure::from(&TurnError::Timeout { idle });
            assert_eq!(
                failure.message(),
                format!("The agent stopped responding after {minutes} minutes.")
            );
        }

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
                .any(|step| matches!(step, Step::Mood(Mood::Hello)))
        );
    }

    #[test]
    fn a_mood_line_that_opens_a_later_call_is_removed_and_the_first_mood_wins() {
        let call = tool_use_line(&[("a", "mcp__polysim__start_strategy", json!({}))]);
        let cases = [
            (
                "text, then a call, then a mood line",
                vec![
                    init_line("s1"),
                    message_start_line(),
                    delta_line("Mode is sim. Starting it."),
                    call.clone(),
                    tool_result_line("a", "started"),
                    message_start_line(),
                    delta_line("mood: hello\nThe engine runs."),
                    result_line("unused"),
                ],
                "Mode is sim. Starting it.\n\nThe engine runs.",
                Mood::Hello,
            ),
            (
                "a mood line, then a call, then another mood line",
                vec![
                    init_line("s1"),
                    message_start_line(),
                    delta_line("mood: neutral\n"),
                    delta_line("Starting it."),
                    call,
                    tool_result_line("a", "started"),
                    message_start_line(),
                    delta_line("mood: hel"),
                    delta_line("lo\nThe engine runs."),
                    result_line("unused"),
                ],
                "Starting it.\n\nThe engine runs.",
                Mood::Neutral,
            ),
        ];
        for (name, lines, text, mood) in cases {
            let transport = Scripted::new().then(Script::lines(lines));
            let mut turn = Turn::start(&transport, &request()).unwrap();
            let (mut shown, mut moods) = (String::new(), Vec::new());
            for step in turn.by_ref() {
                match step {
                    Step::Text(delta) => shown.push_str(&delta),
                    Step::Mood(heard) => moods.push(heard),
                    _ => {}
                }
            }
            assert_eq!(shown, text, "{name}");
            assert_eq!(turn.text(), text, "{name}");
            assert_eq!(moods, [mood], "{name}");
            assert_eq!(turn.mood(), Some(mood), "{name}");
        }
    }
}
