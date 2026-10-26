//! Reads one line of Claude Code's stream-json output. Lines are read by path from
//! `serde_json::Value`, so a field Claude Code adds later cannot break a turn.

use serde_json::Value;

use crate::chat::{SessionId, content_value};

/// What one stdout line means for a turn.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Line {
    Init {
        session_id: SessionId,
        model: String,
    },
    /// A new call to the model begins.
    MessageStart,
    TextDelta(String),
    /// Calls Claude has finished writing; each starts running now.
    ToolUses(Vec<ToolUse>),
    /// What the tools gave back.
    ToolResults(Vec<ToolResult>),
    Result(ResultLine),
    Other,
}

/// A tool call as Claude wrote it.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct ToolUse {
    pub id: String,
    pub name: String,
    pub input: Value,
}

/// What came back for one tool call.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct ToolResult {
    pub id: String,
    pub is_error: bool,
    /// The structured result when the tool sent one, else its text as JSON, else the text.
    pub result: Value,
}

/// The closing line of a request.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct ResultLine {
    pub subtype: String,
    pub is_error: bool,
    pub result: Option<String>,
    pub errors: Vec<String>,
    pub structured_output: Option<Value>,
    /// Input, cache read and cache creation tokens of the request.
    pub context_tokens: u64,
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

pub(super) fn parse(value: &Value) -> Line {
    match value["type"].as_str() {
        Some("system") if value["subtype"] == "init" => init(value),
        Some("stream_event") => stream_event(value),
        Some("assistant") => tool_uses(value),
        Some("user") => tool_results(value),
        Some("result") => Line::Result(result(value)),
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

fn stream_event(value: &Value) -> Line {
    let event = &value["event"];
    match (event["type"].as_str(), event["delta"]["type"].as_str()) {
        (Some("message_start"), _) => Line::MessageStart,
        (Some("content_block_delta"), Some("text_delta")) => event["delta"]["text"]
            .as_str()
            .map_or(Line::Other, |text| Line::TextDelta(text.to_owned())),
        _ => Line::Other,
    }
}

/// The content blocks of a message line that have the given type.
fn blocks<'a>(value: &'a Value, kind: &'a str) -> impl Iterator<Item = &'a Value> {
    let content = value["message"]["content"].as_array();
    content
        .into_iter()
        .flatten()
        .filter(move |block| block["type"] == kind)
}

/// The finished call lines. The streamed blocks are not used because their input is empty
/// until the whole call has been written.
fn tool_uses(value: &Value) -> Line {
    let uses: Vec<ToolUse> = blocks(value, "tool_use")
        .map(|block| ToolUse {
            id: block["id"].as_str().unwrap_or_default().to_owned(),
            name: block["name"].as_str().unwrap_or_default().to_owned(),
            input: block["input"].clone(),
        })
        .collect();
    if uses.is_empty() {
        Line::Other
    } else {
        Line::ToolUses(uses)
    }
}

fn tool_results(value: &Value) -> Line {
    let blocks: Vec<&Value> = blocks(value, "tool_result").collect();
    // The structured result sits beside the message, not inside a block, so it can only be
    // tied to a call when the line holds a single result.
    let structured = &value["tool_use_result"]["structuredContent"];
    let own_structured = (blocks.len() == 1 && !structured.is_null()).then_some(structured);
    let results: Vec<ToolResult> = blocks
        .iter()
        .map(|block| ToolResult {
            id: block["tool_use_id"].as_str().unwrap_or_default().to_owned(),
            is_error: block["is_error"].as_bool().unwrap_or(false),
            result: own_structured.map_or_else(|| content_value(&block["content"]), Value::clone),
        })
        .collect();
    if results.is_empty() {
        Line::Other
    } else {
        Line::ToolResults(results)
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
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        structured_output: value
            .get("structured_output")
            .filter(|v| !v.is_null())
            .cloned(),
        context_tokens: count(&usage["input_tokens"])
            + count(&usage["cache_read_input_tokens"])
            + count(&usage["cache_creation_input_tokens"]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_line(line: &str) -> Line {
        serde_json::from_str(line).map_or(Line::Other, |value| parse(&value))
    }

    const RECORDED_TURN: &str = include_str!("../../tests/fixtures/sonnet-mood-reply.jsonl");
    const RECORDED_SEARCH: &str = include_str!("../../tests/fixtures/quanty-search-reply.jsonl");

    #[test]
    fn parses_the_recorded_sonnet_turn() {
        let lines: Vec<Line> = RECORDED_TURN.lines().map(parse_line).collect();

        let Some(Line::Init {
            session_id, model, ..
        }) = lines.first()
        else {
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
        assert_eq!(result.context_tokens, 1577);
    }

    #[test]
    fn parses_the_recorded_quanty_search() {
        const SEARCH_ID: &str = "toolu_01K3EDj1tq5Co9obfZ2yX4Nx";
        let lines: Vec<Line> = RECORDED_SEARCH.lines().map(parse_line).collect();

        let starts = lines.iter().filter(|line| **line == Line::MessageStart);
        assert_eq!(
            starts.count(),
            3,
            "one message start for each call to the model"
        );

        let uses: Vec<&ToolUse> = lines
            .iter()
            .filter_map(|line| match line {
                Line::ToolUses(uses) => Some(uses),
                _ => None,
            })
            .flatten()
            .collect();
        let [tool_search, search] = uses[..] else {
            panic!("two tool calls, got {uses:?}");
        };
        assert_eq!(tool_search.name, "ToolSearch");
        assert_eq!(search.id, SEARCH_ID);
        assert_eq!(search.name, "mcp__quanty__search");
        assert_eq!(
            search.input["question"],
            "What is vega, the sensitivity of an option price to volatility?"
        );

        let results: Vec<&ToolResult> = lines
            .iter()
            .filter_map(|line| match line {
                Line::ToolResults(results) => Some(results),
                _ => None,
            })
            .flatten()
            .collect();
        let [tool_search_result, search_result] = results[..] else {
            panic!("two tool results, got {results:?}");
        };
        assert_eq!(tool_search_result.id, tool_search.id);
        assert_eq!(search_result.id, SEARCH_ID);
        assert!(!search_result.is_error);
        assert_eq!(search_result.result["results"].as_array().unwrap().len(), 5);
        let structured = RECORDED_SEARCH
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .find(|line| line["message"]["content"][0]["tool_use_id"] == SEARCH_ID)
            .map(|line| line["tool_use_result"]["structuredContent"].clone())
            .unwrap();
        assert_eq!(search_result.result, structured);

        let search_returned = lines
            .iter()
            .position(
                |line| matches!(line, Line::ToolResults(results) if results[0].id == SEARCH_ID),
            )
            .unwrap();
        let first_text = lines
            .iter()
            .position(|line| matches!(line, Line::TextDelta(_)))
            .unwrap();
        assert!(
            search_returned < first_text,
            "the answer comes after the search"
        );

        let streamed: String = lines
            .iter()
            .filter_map(|line| match line {
                Line::TextDelta(text) => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(streamed.starts_with("mood: neutral\nVega is"), "{streamed}");
        let finished = lines.iter().filter_map(|line| match line {
            Line::Result(result) => Some(result),
            _ => None,
        });
        let [result] = finished.collect::<Vec<_>>()[..] else {
            panic!("one result line");
        };
        assert_eq!(result.failure(), None);
    }

    #[test]
    fn unknown_line_types_become_other() {
        for line in [
            r#"{"type":"rate_limit_event","info":{}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hm"}}}"#,
            r#"{"type":"user","message":{"content":"hi"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#,
            r#"{"type":"system","subtype":"hook_started"}"#,
            "not json at all",
            "",
        ] {
            assert_eq!(parse_line(line), Line::Other, "line: {line}");
        }
    }
}
