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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::scripted::{
        Script, Scripted, delta_line, init_line, message_start_line, request, result_line,
        tool_error_line, tool_result_line, tool_use_line,
    };
    use super::super::{Step, Turn};
    use crate::chat::{Mood, ToolCall, ToolStart};

    #[test]
    fn calls_are_paired_summed_up_and_set_apart_from_text() {
        let search = (
            "a",
            "mcp__jet__tools_call",
            json!({"appId":"fixture-app","tool":"search","arguments":{"question":"vega"}}),
        );
        let lines = vec![
            init_line("s1"),
            message_start_line(),
            delta_line("mood: neutral"),
            tool_use_line(&[
                search.clone(),
                ("t", "ToolSearch", json!({"query": "select:x"})),
            ]),
            tool_result_line("t", ""),
            tool_result_line(
                "a",
                r#"{"requestId":"a","content":[],"structuredContent":{"results":[1,2,3,4,5],"usage":[{}]},"isError":false}"#,
            ),
            tool_use_line(&[search]),
            message_start_line(),
            delta_line("Let me look."),
            tool_use_line(&[("b", "mcp__quanty__read_page", json!({"page": 3}))]),
            tool_error_line("b", "no such page"),
            message_start_line(),
            delta_line("Vega is…"),
            result_line("mood: neutral\nLet me look.\n\nVega is…"),
        ];
        let transport = Scripted::new().then(Script::lines(lines));
        let mut turn = Turn::start(&transport, &request()).unwrap();
        let steps: Vec<Step> = turn.by_ref().collect();

        let started: Vec<(&str, &str, &str)> = steps
            .iter()
            .filter_map(|step| match step {
                Step::ToolStarted(ToolStart {
                    id, server, tool, ..
                }) => Some((id.as_str(), server.as_str(), tool.as_str())),
                _ => None,
            })
            .collect();
        assert_eq!(
            started,
            [("a", "fixture-app", "search"), ("b", "quanty", "read_page")],
            "a call written twice starts once, and ToolSearch is left out"
        );
        let calls: Vec<&ToolCall> = steps
            .iter()
            .filter_map(|step| match step {
                Step::ToolFinished(call) => Some(call),
                _ => None,
            })
            .collect();
        let [found, missed] = calls[..] else {
            panic!("two finished calls, got {calls:?}");
        };
        assert!(found.ok);
        assert_eq!(found.summary, "fixture-app · search · 5 results");
        assert_eq!(found.input, json!({"question": "vega"}));
        assert_eq!(
            found.result,
            json!({"results": [1, 2, 3, 4, 5], "usage": [{}]})
        );
        assert!(!missed.ok);
        assert_eq!(missed.summary, "quanty · read_page · failed");
        assert_eq!(missed.result, json!("no such page"));

        let at = |id: &str, finished: bool| {
            steps.iter().position(|step| match step {
                Step::ToolStarted(call) => !finished && call.id == id,
                Step::ToolFinished(call) => finished && call.id == id,
                _ => false,
            })
        };
        for id in ["a", "b"] {
            assert!(at(id, false).unwrap() < at(id, true).unwrap(), "{id}");
        }
        let finished_calls: Vec<ToolCall> = calls.iter().map(|call| (*call).clone()).collect();
        assert_eq!(turn.tools(), finished_calls);
        assert_eq!(turn.mood(), Some(Mood::Neutral));
        assert_eq!(turn.text(), "Let me look.\n\nVega is…");
    }
}
