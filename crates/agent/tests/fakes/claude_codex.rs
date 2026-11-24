//! The stand-ins for Claude Code and Codex write the calls of a `facade:` script in their own
//! provider's event format.
use crate::support::{self, Provider};
use agent::TURN_HEADER;
use serde_json::{Value, json};
use std::io::Write;

pub fn run(args: &[String], input: &str, codex: bool) -> bool {
    support::run_as(&BuiltIn { codex }, args, input)
}
fn emit(value: Value) {
    println!("{value}");
    std::io::stdout().flush().unwrap();
}

/// Claude Code or Codex.
struct BuiltIn {
    codex: bool,
}
impl Provider for BuiltIn {
    fn connection(&self, args: &[String]) -> (String, String) {
        if self.codex {
            let value = |key: &str| -> String {
                serde_json::from_str(args.iter().find_map(|arg| arg.strip_prefix(key)).unwrap())
                    .unwrap()
            };
            return (
                value("mcp_servers.jet.url="),
                value(&format!("mcp_servers.jet.http_headers.{TURN_HEADER}=")),
            );
        }
        let at = args.iter().position(|arg| arg == "--mcp-config").unwrap();
        let config: Value = serde_json::from_str(&args[at + 1]).unwrap();
        let server = &config["mcpServers"]["jet"];
        (
            server["url"].as_str().unwrap().into(),
            server["headers"][TURN_HEADER].as_str().unwrap().into(),
        )
    }
    fn start(&self) {
        start(self.codex);
    }
    fn call(&self, id: &str, tool: &str, arguments: &Value) -> Option<String> {
        call(self.codex, id, tool, arguments);
        None
    }
    fn result(&self, id: &str, result: Value) {
        result_line(self.codex, id, result);
    }
    fn finish(&self) {
        finish(self.codex, "mood: neutral\nFixture app answered.");
    }
    fn finish_saying(&self, text: &str) {
        finish(self.codex, text);
    }
    fn names_tool_use(&self) -> bool {
        !self.codex
    }
}
fn start(codex: bool) {
    if codex {
        emit(json!({"type":"thread.started","thread_id":"facade-codex-session"}));
    } else {
        emit(
            json!({"type":"system","subtype":"init","session_id":"facade-claude-session","model":"claude-fake","mcp_servers":[{"name":"jet","status":"connected"}]}),
        );
    }
}
fn call(codex: bool, id: &str, tool: &str, arguments: &Value) {
    if codex {
        emit(
            json!({"type":"item.started","item":{"type":"mcp_tool_call","id":id,"server":"jet","tool":tool,"arguments":arguments}}),
        );
    } else {
        emit(
            json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":format!("mcp__jet__{tool}"),"input":arguments}]}}),
        );
    }
}
fn result_line(codex: bool, id: &str, result: Value) {
    if codex {
        emit(
            json!({"type":"item.completed","item":{"type":"mcp_tool_call","id":id,"status":if result["isError"] == true {"failed"} else {"completed"},"result":{"content":result["content"],"structured_content":result["structuredContent"]}}}),
        );
    } else {
        emit(
            json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":id,"is_error":result["isError"],"content":result["content"]}]},"tool_use_result":{"structuredContent":result["structuredContent"]}}),
        );
    }
}
fn finish(codex: bool, text: &str) {
    if codex {
        emit(json!({"type":"item.completed","item":{"type":"agent_message","text":text}}));
        emit(
            json!({"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}),
        );
    } else {
        emit(
            json!({"type":"result","subtype":"success","result":text,"duration_ms":1,"usage":{"input_tokens":10,"output_tokens":5}}),
        );
    }
}
