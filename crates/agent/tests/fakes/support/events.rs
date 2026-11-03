//! Encode actual fixture call results in each provider's event format.
use serde_json::{Value, json};
use std::io::Write;
fn emit(value: Value) {
    println!("{value}");
    std::io::stdout().flush().unwrap();
}
pub fn start(codex: bool) {
    if codex {
        emit(json!({"type":"thread.started","thread_id":"facade-codex-session"}));
    } else {
        emit(
            json!({"type":"system","subtype":"init","session_id":"facade-claude-session","model":"claude-fake","mcp_servers":[{"name":"jet","status":"connected"}]}),
        );
    }
}
pub fn call(codex: bool, id: &str, tool: &str, arguments: &Value) {
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
pub fn result(codex: bool, id: &str, result: Value) {
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
pub fn finish(codex: bool) {
    let text = "mood: neutral\nFixture app answered.";
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
