//! The exact command line and cache setting for a request. The flags and their order stay fixed
//! so that Claude's prompt cache keeps hitting.

use crate::turn::transport::{Request, SessionMode};

/// Keeps Claude's prompt cache alive for an hour instead of five minutes.
pub(super) const CACHE_TTL_ENV: (&str, &str) = ("CLAUDE_CODE_PROMPT_CACHE_TTL", "1h");

/// The command line for a request. One function builds both the chat and the review
/// call, so the order of the flags cannot drift between them.
pub(super) fn args(request: &Request) -> Vec<String> {
    let ephemeral = request.session == SessionMode::Ephemeral;
    let mut args: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose"]
        .map(String::from)
        .into();
    if !ephemeral {
        args.push("--include-partial-messages".into());
    }
    args.extend([
        "--model".into(),
        request.model.alias().into(),
        "--effort".into(),
        request.effort.alias().into(),
        "--system-prompt".into(),
        request.system_prompt.clone(),
    ]);
    if let Some(schema) = &request.schema {
        args.extend(["--json-schema".into(), schema.to_string()]);
    }
    args.extend(
        [
            "--tools",
            "",
            "--safe-mode",
            "--strict-mcp-config",
            "--no-chrome",
            "--permission-prompts",
            "none",
        ]
        .map(String::from),
    );
    if ephemeral {
        args.push("--no-session-persistence".into());
    } else {
        args.extend(["--autocompact".into(), "100k".into()]);
    }
    args.extend([
        "--max-budget-usd".into(),
        format!("{:.2}", request.budget_usd),
    ]);
    if let SessionMode::Resume(id) = &request.session {
        args.extend(["--resume".into(), id.0.clone()]);
    }
    args
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::chat::{Effort, Model, SessionId};

    fn chat_request(session: SessionMode) -> Request {
        Request {
            prompt: "hello".into(),
            system_prompt: "You-are-Jet.".into(),
            model: Model::Sonnet,
            effort: Effort::Medium,
            budget_usd: 1.0,
            session,
            schema: None,
        }
    }

    /// Splits a command line on spaces; `''` stands for one empty argument.
    fn words(line: &str) -> Vec<String> {
        let unquoted = |word: &str| word.trim_matches('\'').to_owned();
        line.split(' ').map(unquoted).collect()
    }

    #[test]
    fn chat_and_review_args_are_exact() {
        let new_chat = words(
            "-p --output-format stream-json --verbose --include-partial-messages \
             --model sonnet --effort medium --system-prompt You-are-Jet. \
             --tools '' --safe-mode --strict-mcp-config --no-chrome --permission-prompts none \
             --autocompact 100k --max-budget-usd 1.00",
        );
        assert_eq!(args(&chat_request(SessionMode::New)), new_chat);

        let resume = SessionMode::Resume(SessionId("abc-123".into()));
        let resumed = [new_chat, words("--resume abc-123")].concat();
        assert_eq!(args(&chat_request(resume)), resumed);

        let review = Request {
            prompt: "notes".into(),
            system_prompt: "Keep-notes.".into(),
            model: Model::Haiku,
            effort: Effort::Low,
            budget_usd: 0.2,
            session: SessionMode::Ephemeral,
            schema: Some(json!({"type": "object"})),
        };
        assert_eq!(
            args(&review),
            words(
                "-p --output-format stream-json --verbose --model haiku --effort low \
                 --system-prompt Keep-notes. --json-schema {\"type\":\"object\"} \
                 --tools '' --safe-mode --strict-mcp-config --no-chrome --permission-prompts none \
                 --no-session-persistence --max-budget-usd 0.20"
            )
        );
        assert_eq!(CACHE_TTL_ENV, ("CLAUDE_CODE_PROMPT_CACHE_TTL", "1h"));
    }
}
