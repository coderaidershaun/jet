//! Follows the MCP tool calls of one turn: names each call's server and tool, pairs it with
//! its result, times it and sums the result up in one line. Claude Code's own tools, such
//! as ToolSearch, are ignored.

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use serde_json::Value;

use super::Step;
use super::stream::{ToolResult, ToolUse};
use crate::chat::{ToolCall, ToolStart};

/// A call that has started and not come back yet.
struct Open {
    call: ToolStart,
    started: Instant,
}

impl Open {
    /// One line for people, such as `quanty · search · 5 results`.
    fn summary(&self, ok: bool, result: &Value) -> String {
        let outcome = if ok {
            count_line(result).unwrap_or_else(|| "done".to_owned())
        } else {
            "failed".to_owned()
        };
        format!("{} · {} · {outcome}", self.call.server, self.call.tool)
    }
}

#[derive(Default)]
pub(super) struct ToolCalls {
    open: HashMap<String, Open>,
    /// Every id that started, so a call written out twice starts once.
    seen: HashSet<String>,
    done: Vec<ToolCall>,
}

impl ToolCalls {
    /// The steps for calls just written. Repeats and tools of Claude Code give none.
    pub(super) fn start(&mut self, uses: Vec<ToolUse>) -> Vec<Step> {
        let mut steps = Vec::new();
        for ToolUse { id, name, input } in uses {
            let Some((server, tool)) = split_name(&name) else {
                continue;
            };
            if !self.seen.insert(id.clone()) {
                continue;
            }
            let (server, tool, input) = if server == "jet" && tool == "tools_call" {
                (
                    input["appId"].as_str().unwrap_or("unknown app").to_owned(),
                    input["tool"].as_str().unwrap_or("unknown tool").to_owned(),
                    input["arguments"].clone(),
                )
            } else {
                (server.to_owned(), tool.to_owned(), input)
            };
            let call = ToolStart {
                id: id.clone(),
                server,
                tool,
                input,
            };
            steps.push(Step::ToolStarted(call.clone()));
            let started = Instant::now();
            self.open.insert(id, Open { call, started });
        }
        steps
    }

    /// The steps for results of open calls. Results of other calls give none.
    pub(super) fn finish(&mut self, results: Vec<ToolResult>) -> Vec<Step> {
        let mut steps = Vec::new();
        for ToolResult {
            id,
            is_error,
            result,
        } in results
        {
            let Some(open) = self.open.remove(&id) else {
                continue;
            };
            let (result, nested_error) =
                if result.get("requestId").is_some() && result.get("content").is_some() {
                    (
                        result
                            .get("structuredContent")
                            .filter(|value| !value.is_null())
                            .cloned()
                            .unwrap_or_else(|| crate::chat::content_value(&result["content"])),
                        result["isError"] == true,
                    )
                } else {
                    (result, false)
                };
            let ok = !is_error && !nested_error;
            let summary = open.summary(ok, &result);
            let duration_ms = u64::try_from(open.started.elapsed().as_millis()).unwrap_or(u64::MAX);
            let call = ToolCall {
                id: open.call.id,
                server: open.call.server,
                tool: open.call.tool,
                input: open.call.input,
                ok,
                result,
                summary,
                duration_ms,
            };
            self.done.push(call.clone());
            steps.push(Step::ToolFinished(call));
        }
        steps
    }

    /// The calls that came back, in the order they did.
    pub(super) fn done(&self) -> &[ToolCall] {
        &self.done
    }

    /// Whether a call has started and not come back.
    pub(super) fn running(&self) -> bool {
        !self.open.is_empty()
    }
}

/// `mcp__quanty__search` is the tool `search` of the server `quanty`.
fn split_name(name: &str) -> Option<(&str, &str)> {
    name.strip_prefix("mcp__")?.split_once("__")
}

/// How many things a result holds: in an object, the list whose field name comes first
/// alphabetically, leaving out `usage` (quanty reports its spend there, not answers); or the
/// result itself when it is a list.
fn count_line(result: &Value) -> Option<String> {
    match result {
        Value::Object(fields) => fields
            .iter()
            .filter(|(name, value)| name.as_str() != "usage" && value.is_array())
            .min_by_key(|&(name, _)| name)
            .map(|(name, value)| {
                let count = value.as_array().map_or(0, Vec::len);
                let noun = name.replace('_', " ");
                let noun = if count == 1 {
                    noun.strip_suffix('s').unwrap_or(&noun)
                } else {
                    &noun
                };
                format!("{count} {noun}")
            }),
        Value::Array(items) => {
            let noun = if items.len() == 1 { "item" } else { "items" };
            Some(format!("{} {noun}", items.len()))
        }
        _ => None,
    }
}
