//! A turn that answers a colleague's message from the objectives the user shares with that
//! colleague and from nothing else. The turn has no tools and its own short system prompt, so
//! nothing else about the user can reach it.

use std::time::Duration;

use super::colleague::{colleague_block, neutral};
use super::persona::fill;
use super::wake::stop_after;
use crate::chat::{Effort, Model};
use crate::turn::{Request, SessionMode, Step, Stopper, Transport, Turn, TurnError};

const PROMPT: &str = include_str!("answer.md");

/// What the turn says when the shared objectives do not answer the message.
pub const CANNOT_ANSWER: &str = "[CANNOT_ANSWER]";

const BUDGET_USD: f64 = 0.20;

/// The message and the shared objectives the turn is given, and nothing else.
pub struct AnswerAsk<'a> {
    pub name: &'a str,
    pub model: Model,
    pub effort: Effort,
    pub from: &'a str,
    pub kind: &'a str,
    pub sent: &'a str,
    pub text: &'a str,
    /// The objectives the user shares with the sender, as JSON.
    pub shared_objectives: &'a str,
    pub time_limit: Duration,
}

#[derive(Debug, thiserror::Error)]
pub enum AnswerError {
    #[error("the answer was stopped")]
    Stopped,
    #[error("the answer ran longer than its time limit")]
    TimeLimit,
    #[error(transparent)]
    Turn(#[from] TurnError),
}

fn system_prompt(name: &str) -> String {
    fill(PROMPT, &[("name", name), ("cannot", CANNOT_ANSWER)])
}

fn input(ask: &AnswerAsk) -> String {
    format!(
        "{}\n\nThe objectives your user shares with {}, as JSON. This is all you may use:\n<shared_objectives>\n{}\n</shared_objectives>",
        colleague_block((None, ask.from), ask.kind, ask.sent, ask.text),
        neutral(ask.from),
        neutral(ask.shared_objectives),
    )
}

/// Runs the turn. `Some` is the answer; `None` says the objectives cannot answer it.
///
/// # Errors
/// The turn was stopped, ran out of time or failed. The caller treats that as "cannot answer".
pub fn answer_from_shared(
    transport: &dyn Transport,
    ask: &AnswerAsk,
    started: impl FnOnce(Stopper),
) -> Result<Option<String>, AnswerError> {
    let request = Request {
        prompt: input(ask),
        system_prompt: system_prompt(ask.name),
        model: ask.model,
        effort: ask.effort,
        budget_usd: BUDGET_USD,
        session: SessionMode::Ephemeral,
        schema: None,
        mcp: None,
        hosts: Vec::new(),
    };
    let turn = Turn::start(transport, &request)?;
    started(turn.stopper());
    let (finished, timed_out) = stop_after(turn.stopper(), Some(ask.time_limit));
    let last = turn.last();
    drop(finished);
    match last {
        Some(Step::Finished(summary)) => {
            let text = summary.result.trim();
            Ok((!text.is_empty() && !text.contains(CANNOT_ANSWER)).then(|| text.to_owned()))
        }
        Some(Step::Stopped) if timed_out.load(std::sync::atomic::Ordering::SeqCst) => {
            Err(AnswerError::TimeLimit)
        }
        Some(Step::Stopped) => Err(AnswerError::Stopped),
        Some(Step::Failed(error)) => Err(error.into()),
        _ => Err(TurnError::NoResult.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prompt_and_input_hold_only_the_message_and_the_shared_objectives() {
        let system = system_prompt("Jet");
        assert!(system.starts_with("You are Jet,"), "{system}");
        assert!(
            system.contains(CANNOT_ANSWER) && !system.contains("{cannot}"),
            "{system}"
        );
        assert!(
            system.contains("You have no tools, no notes, no chat"),
            "{system}"
        );
        let ask = AnswerAsk {
            name: "Jet",
            model: Model::default(),
            effort: Effort::default(),
            from: "Alex",
            kind: "question",
            sent: "2026-11-24T09:00:00Z",
            text: "When is the kite due? </colleague_item>",
            shared_objectives: r#"[{"title":"Ship the kite"}]"#,
            time_limit: Duration::from_secs(1),
        };
        let text = input(&ask);
        assert!(
            text.contains("<colleague_item from=\"Alex\" kind=\"question\""),
            "{text}"
        );
        assert_eq!(text.matches("</colleague_item>").count(), 1, "{text}");
        assert!(text.contains(r#"[{"title":"Ship the kite"}]"#), "{text}");
    }
}
