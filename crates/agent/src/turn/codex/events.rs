//! Codex replies use different event names, so translate them for the shared turn reader.
//! Aggregate usage remains separate from an optional last context measurement.
use serde_json::{Value, json};
use std::time::Instant;

pub(super) struct Events {
    model: String,
    wants_structured_output: bool,
    started_at: Instant,
    result: String,
}
impl Events {
    pub(super) fn new(model: String, wants_structured_output: bool, started_at: Instant) -> Self {
        Self {
            model,
            wants_structured_output,
            started_at,
            result: String::new(),
        }
    }
    pub(super) fn translate(&mut self, line: &str) -> Vec<String> {
        let mut lines = vec![line.to_owned()];
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            return lines;
        };
        let item = &event["item"];
        let mapped = match event["type"].as_str().unwrap_or_default() {
            "thread.started" => Some(json!({
                "type": "system",
                "subtype": "init",
                "session_id": event["thread_id"],
                "model": self.model,
                "mcp_servers": [],
            })),
            "item.completed" if item["type"] == "agent_message" => {
                self.result = item["text"].as_str().unwrap_or_default().to_owned();
                lines.push(
                    json!({"type":"stream_event","event":{"type":"message_start"}}).to_string(),
                );
                Some(json!({
                    "type": "stream_event",
                    "event": {
                        "type": "content_block_delta",
                        "delta": {"type": "text_delta", "text": self.result},
                    },
                }))
            }
            "item.started" if item["type"] == "mcp_tool_call" => Some(json!({
                "type": "assistant",
                "message": {"content": [{
                    "type": "tool_use",
                    "id": item["id"],
                    "name": format!(
                        "mcp__{}__{}",
                        item["server"].as_str().unwrap_or_default(),
                        item["tool"].as_str().unwrap_or_default(),
                    ),
                    "input": item["arguments"],
                }]},
            })),
            "item.completed" if item["type"] == "mcp_tool_call" => {
                let mut content = item["result"]["content"].clone();
                if content.is_null() && !item["error"].is_null() {
                    content = Value::String(item["error"].to_string());
                }
                Some(json!({
                    "type": "user",
                    "message": {"content": [{
                        "type": "tool_result",
                        "tool_use_id": item["id"],
                        "is_error": item["status"] == "failed" || !item["error"].is_null(),
                        "content": content,
                    }]},
                    "tool_use_result": {"structuredContent": item["result"]["structured_content"]},
                }))
            }
            "turn.completed" => {
                let usage = &event["usage"];
                let input = usage["input_tokens"].as_u64().unwrap_or(0);
                let cached = usage["cached_input_tokens"].as_u64().unwrap_or(0);
                Some(json!({
                    "type": "result",
                    "subtype": "success",
                    "result": self.result,
                    "structured_output": if self.wants_structured_output {
                        serde_json::from_str::<Value>(&self.result).ok()
                    } else {
                        None
                    },
                    "context": {
                        "usedTokens": event["context"]["used_tokens"].as_u64().or_else(|| {
                            let last = &usage["last_token_usage"];
                            last["total_tokens"].as_u64().or_else(|| Some(last["input_tokens"].as_u64()?.saturating_add(last["output_tokens"].as_u64()?)))
                        }),
                        "limitTokens": event["context"]["context_window"].as_u64().or_else(|| usage["model_context_window"].as_u64()),
                    },
                    "duration_ms": self.started_at.elapsed().as_millis() as u64,
                    "usage": {
                        "input_tokens": input.saturating_sub(cached),
                        "cache_read_input_tokens": cached,
                        "output_tokens": usage["output_tokens"],
                        "output_tokens_details": {"thinking_tokens": usage["reasoning_output_tokens"]},
                    },
                }))
            }
            "turn.failed" => Some(json!({
                "type": "result",
                "subtype": "codex_failed",
                "is_error": true,
                "result": event["error"]["message"],
            })),
            // `error` can describe a retry; only turn.failed or process exit is terminal.
            _ => None,
        };
        if let Some(mapped) = mapped {
            lines.push(mapped.to_string());
        }
        lines
    }
}
