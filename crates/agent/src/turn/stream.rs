//! Reads one line of Claude Code's stream-json output. Lines are read by path from
//! `serde_json::Value`, so a field Claude Code adds later cannot break a turn.

use serde_json::Value;

use crate::chat::{SessionId, Usage};

/// What one stdout line means for a turn.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Line {
    Init {
        session_id: SessionId,
        model: String,
    },
    TextDelta(String),
    Result(ResultLine),
    /// Anything else: shown in the raw log, otherwise ignored.
    Other,
}

/// The closing line of a request.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct ResultLine {
    pub subtype: String,
    pub is_error: bool,
    pub result: Option<String>,
    pub errors: Vec<String>,
    pub structured_output: Option<Value>,
    pub duration_ms: u64,
    pub cost_usd: f64,
    pub usage: Usage,
}

impl ResultLine {
    /// Claude's own words about why the request failed, or `None` when it succeeded.
    pub(super) fn failure(&self) -> Option<(String, String)> {
        if !self.is_error && self.subtype == "success" {
            return None;
        }
        let message = match self.result.as_deref().map(str::trim) {
            Some(text) if !text.is_empty() => text.to_owned(),
            _ if !self.errors.is_empty() => self.errors.join("; "),
            _ => self.subtype.clone(),
        };
        Some((self.subtype.clone(), message))
    }
}

pub(super) fn parse(line: &str) -> Line {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return Line::Other;
    };
    match value["type"].as_str() {
        Some("system") if value["subtype"] == "init" => init(&value),
        Some("stream_event") => text_delta(&value),
        Some("result") => Line::Result(result(&value)),
        _ => Line::Other,
    }
}

fn init(value: &Value) -> Line {
    match value["session_id"].as_str() {
        Some(id) => Line::Init {
            session_id: SessionId(id.to_owned()),
            model: value["model"].as_str().unwrap_or_default().to_owned(),
        },
        None => Line::Other,
    }
}

fn text_delta(value: &Value) -> Line {
    let event = &value["event"];
    match (event["type"].as_str(), event["delta"]["type"].as_str()) {
        (Some("content_block_delta"), Some("text_delta")) => event["delta"]["text"]
            .as_str()
            .map_or(Line::Other, |text| Line::TextDelta(text.to_owned())),
        _ => Line::Other,
    }
}

fn result(value: &Value) -> ResultLine {
    let usage = &value["usage"];
    let count = |node: &Value| node.as_u64().unwrap_or(0);
    ResultLine {
        subtype: value["subtype"].as_str().unwrap_or_default().to_owned(),
        is_error: value["is_error"].as_bool().unwrap_or(false),
        result: value["result"].as_str().map(str::to_owned),
        errors: value["errors"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
        structured_output: match &value["structured_output"] {
            Value::Null => None,
            other => Some(other.clone()),
        },
        duration_ms: count(&value["duration_ms"]),
        cost_usd: value["total_cost_usd"].as_f64().unwrap_or(0.0),
        usage: Usage {
            input_tokens: count(&usage["input_tokens"]),
            cache_read_tokens: count(&usage["cache_read_input_tokens"]),
            cache_creation_tokens: count(&usage["cache_creation_input_tokens"]),
            cache_creation_1h_tokens: count(&usage["cache_creation"]["ephemeral_1h_input_tokens"]),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECORDED_TURN: &str = include_str!("../../tests/fixtures/sonnet-mood-reply.jsonl");

    #[test]
    fn parses_the_recorded_sonnet_turn() {
        let lines: Vec<Line> = RECORDED_TURN.lines().map(parse).collect();

        let Some(Line::Init { session_id, model }) = lines.first() else {
            panic!("the recording starts with the init line");
        };
        assert_eq!(model, "claude-sonnet-5-5");
        assert!(!session_id.0.is_empty());

        let streamed: String = lines
            .iter()
            .filter_map(|line| match line {
                Line::TextDelta(text) => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(streamed.starts_with("mood: excited\n"), "{streamed}");

        let results: Vec<&ResultLine> = lines
            .iter()
            .filter_map(|line| match line {
                Line::Result(result) => Some(result),
                _ => None,
            })
            .collect();
        let [result] = results[..] else {
            panic!("one result line, got {}", results.len());
        };
        assert_eq!(result.failure(), None);
        assert_eq!(result.result.as_deref(), Some(streamed.as_str()));
        assert_eq!(result.cost_usd, 0.007334);
        assert_eq!(
            result.usage,
            Usage {
                input_tokens: 2,
                cache_read_tokens: 0,
                cache_creation_tokens: 1575,
                cache_creation_1h_tokens: 1575,
            }
        );
    }

    #[test]
    fn unknown_line_types_become_other() {
        for line in [
            r#"{"type":"rate_limit_event","info":{}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hm"}}}"#,
            r#"{"type":"system","subtype":"hook_started"}"#,
            "not json at all",
            "",
        ] {
            assert_eq!(parse(line), Line::Other, "line: {line}");
        }
    }
}
