//! Follows the tool calls of one turn: names each call's server and tool, pairs it with its
//! result, times it and sums the result up in one line. Of Claude Code's own tools only web
//! search and page reading count, as the server `web`; the rest, such as ToolSearch, are ignored.
//! The long text of Jet's own file calls is left out, since no card shows it.

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
    /// The steps for calls just written. Repeats and other tools of Claude Code give none.
    pub(super) fn start(&mut self, uses: Vec<ToolUse>) -> Vec<Step> {
        let mut steps = Vec::new();
        for ToolUse { id, name, input } in uses {
            let Some(call) = card(id.clone(), &name, input) else {
                continue;
            };
            if !self.seen.insert(id.clone()) {
                continue;
            }
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
            let mut result = result;
            if open.call.server == "jet" && open.call.tool == "files_read" {
                drop_field(&mut result, "text");
            }
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

/// The card of a call, or `None` for a tool of Claude Code that shows none.
fn card(id: String, name: &str, input: Value) -> Option<ToolStart> {
    match name {
        "WebFetch" => return Some(ToolStart::web(id, "fetch", input)),
        "WebSearch" => return Some(ToolStart::web(id, "search", input)),
        _ => {}
    }
    let (server, tool) = split_name(name)?;
    let (server, tool, input) = if server == "jet" && tool == "tools_call" {
        (
            input["appId"].as_str().unwrap_or("unknown app").to_owned(),
            input["tool"].as_str().unwrap_or("unknown tool").to_owned(),
            input["arguments"].clone(),
        )
    } else {
        (server.to_owned(), tool.to_owned(), input)
    };
    let mut input = input;
    match (server.as_str(), tool.as_str()) {
        ("jet", "files_export") => drop_field(&mut input, "markdown"),
        ("jet", "files_update") => {
            if let Some(command) = input.get_mut("command") {
                drop_field(command, "content");
            }
        }
        _ => {}
    }
    Some(ToolStart {
        id,
        server,
        tool,
        input,
    })
}

/// Leaves out a long text that the model wrote or read and no card shows, so the saved thread,
/// and the page that loads it again on every reload, do not carry it.
fn drop_field(value: &mut Value, field: &str) {
    if let Some(fields) = value.as_object_mut() {
        fields.remove(field);
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
