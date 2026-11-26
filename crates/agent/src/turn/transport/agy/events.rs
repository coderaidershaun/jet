//! agy writes its own stream events, so translate them into the lines the shared turn reader
//! takes. A tool outside Jet's own that has run, or a line this code does not know, ends the
//! translation, because the limit to Jet's tools is then no longer certain.

use serde_json::{Value, json};

use super::super::TransportError;

/// How agy names a tool of Jet's tool server.
const JET_TOOL: &str = "mcp_jet_";

/// How much of a line that is not known the error shows.
const LINE_SHOWN: usize = 200;

/// How agy's error for a call begins when the hook refused it. Any other error of a tool outside
/// the list means the tool itself ran and failed.
const REFUSED_BY_HOOK: &str = "tool call denied by pre-tool hook:";

/// Why a line ends the translation.
enum Fault {
    /// The line, or a part of it, has a form that agy at the proven version does not write.
    Unknown,
    /// A tool that is not one of the allowed ones has run.
    Ran(String),
}

pub(super) struct Events {
    /// The only tool names the turn may run, as agy writes them.
    allowed: Vec<String>,
    /// Empty until agy has named the conversation.
    conversation: String,
    /// The step of the model call whose text is being read.
    response_step: Option<u64>,
    input_tokens: u64,
    cached_tokens: u64,
    output_tokens: u64,
    /// What the conversation held after the last model call.
    context_tokens: Option<u64>,
    /// True once agy has said that the turn ended well.
    succeeded: bool,
}

impl Events {
    pub(super) fn new(allowed: Vec<String>) -> Self {
        Self {
            allowed,
            conversation: String::new(),
            response_step: None,
            input_tokens: 0,
            cached_tokens: 0,
            output_tokens: 0,
            context_tokens: None,
            succeeded: false,
        }
    }

    pub(super) fn has_succeeded(&self) -> bool {
        self.succeeded
    }

    /// The line itself and what it means for the turn reader.
    ///
    /// # Errors
    /// `AgyTool` when a tool that is not one of the allowed ones has run, and `AgyLine` when the
    /// line is not one that agy at the proven version writes.
    pub(super) fn translate(&mut self, line: &str) -> Result<Vec<String>, TransportError> {
        self.read(line).map_err(|fault| match fault {
            Fault::Ran(tool) => TransportError::AgyTool { tool },
            Fault::Unknown => TransportError::AgyLine {
                line: line.chars().take(LINE_SHOWN).collect(),
            },
        })
    }

    fn read(&mut self, line: &str) -> Result<Vec<String>, Fault> {
        let event: Value = serde_json::from_str(line).map_err(|_| Fault::Unknown)?;
        let mapped = match event["event"].as_str() {
            Some("init") => {
                let id = event["conversation_id"].as_str().unwrap_or_default();
                self.conversation = id.to_owned();
                vec![json!({
                    "type": "system",
                    "subtype": "init",
                    "session_id": id,
                    "model": event["init"]["model"],
                })]
            }
            Some("step_update") => self.step(&event["step_update"])?,
            Some("result") => {
                self.succeeded = event["result"]["status"] == "SUCCESS";
                self.result(&event["result"]).into_iter().collect()
            }
            _ => return Err(Fault::Unknown),
        };
        let mut lines = vec![line.to_owned()];
        lines.extend(mapped.iter().map(Value::to_string));
        Ok(lines)
    }

    fn step(&mut self, step: &Value) -> Result<Vec<Value>, Fault> {
        let index = step["step_index"].as_u64().ok_or(Fault::Unknown)?;
        let state = step["state"].as_str().ok_or(Fault::Unknown)?;
        match step["step_type"].as_str() {
            Some("agent_response") => Ok(self.response(index, step)),
            // agy writes some tool calls with the type `unknown` and no name.
            Some("tool" | "unknown") => self.tool(index, state, step),
            Some("user_input" | "system_message" | "finish") => Ok(Vec::new()),
            _ => Err(Fault::Unknown),
        }
    }

    fn response(&mut self, index: u64, step: &Value) -> Vec<Value> {
        let mut mapped = Vec::new();
        if self.response_step.replace(index) != Some(index) {
            mapped.push(json!({"type": "stream_event", "event": {"type": "message_start"}}));
        }
        if let Some(text) = step["text_delta"].as_str() {
            mapped.push(json!({
                "type": "stream_event",
                "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": text}},
            }));
        }
        // The usage comes once, on the last line of the model call. Its input tokens leave out
        // the ones read from the cache.
        let usage = &step["usage"];
        if let Some(input) = usage["input_tokens"].as_u64() {
            let cached = usage["cache_read_tokens"].as_u64().unwrap_or(0);
            let output = usage["output_tokens"].as_u64().unwrap_or(0);
            self.input_tokens += input;
            self.cached_tokens += cached;
            self.output_tokens += output;
            self.context_tokens = Some(input + cached + output);
        }
        mapped
    }

    /// A tool of Jet's becomes a card. Any other tool that agy's hook refused is passed over, and
    /// one that ran means the limit did not hold. agy writes a refused call as started first, so
    /// only the end of a call tells the two apart.
    fn tool(&self, index: u64, state: &str, step: &Value) -> Result<Vec<Value>, Fault> {
        let name = step["tool_name"].as_str().unwrap_or_default();
        let info = &step["tool_info"];
        let error = info["error"]["message"].as_str().unwrap_or_default();
        if !self.allowed.iter().any(|allowed| allowed == name) {
            let ran = || {
                let tool = if name.is_empty() {
                    "an unnamed tool"
                } else {
                    name
                };
                Fault::Ran(tool.to_owned())
            };
            return match state {
                "ACTIVE" => Ok(Vec::new()),
                "ERROR" if error.starts_with(REFUSED_BY_HOOK) => Ok(Vec::new()),
                "DONE" | "ERROR" => Err(ran()),
                _ => Err(Fault::Unknown),
            };
        }
        let Some(tool) = name.strip_prefix(JET_TOOL) else {
            return Ok(Vec::new());
        };
        // agy names no id for a call, so the step number stands in for one.
        let id = format!("{}:{index}", self.conversation);
        let input = match &info["parameters"] {
            Value::Null => json!({}),
            parameters => parameters.clone(),
        };
        let mut mapped = vec![json!({
            "type": "assistant",
            "message": {"content": [{
                "type": "tool_use",
                "id": id,
                "name": format!("mcp__jet__{tool}"),
                "input": input,
            }]},
        })];
        let content = match state {
            "ACTIVE" => None,
            "DONE" => Some(tool_text(info["output"].as_str().unwrap_or_default())),
            "ERROR" => Some(error),
            _ => return Err(Fault::Unknown),
        };
        if let Some(content) = content {
            mapped.push(json!({
                "type": "user",
                "message": {"content": [{
                    "type": "tool_result",
                    "tool_use_id": id,
                    "is_error": state == "ERROR",
                    "content": content,
                }]},
            }));
        }
        Ok(mapped)
    }

    fn result(&self, result: &Value) -> Option<Value> {
        if result["status"] != "SUCCESS" {
            // A run that fails before its turn begins also says why on its error output and
            // exits with a failure, and that is what tells a lost conversation from other faults.
            if self.conversation.is_empty() {
                return None;
            }
            let said = [&result["error"], &result["status"]];
            return Some(json!({
                "type": "result",
                "subtype": "agy_failed",
                "is_error": true,
                "result": said.into_iter().find_map(Value::as_str).unwrap_or_default(),
            }));
        }
        // The result line counts the whole conversation, so the turn's own tokens are the sum
        // of its model calls.
        Some(json!({
            "type": "result",
            "subtype": "success",
            "result": result["response"],
            "structured_output": result["structured_output"],
            "context": {"usedTokens": self.context_tokens},
            "usage": {
                "input_tokens": self.input_tokens,
                "cache_read_input_tokens": self.cached_tokens,
                "output_tokens": self.output_tokens,
            },
        }))
    }
}

/// A tool's own text. agy puts two lines with the times of the call before it.
fn tool_text(output: &str) -> &str {
    let mut text = output;
    for label in ["Created At: ", "Completed At: "] {
        if text.starts_with(label) {
            text = text.split_once('\n').map_or("", |(_, rest)| rest);
        }
    }
    text
}
