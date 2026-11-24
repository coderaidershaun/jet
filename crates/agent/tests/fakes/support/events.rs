//! Claude Code's own web tools, written the way Claude Code writes them.
use serde_json::{Value, json};
use std::io::Write;
fn emit(value: Value) {
    println!("{value}");
    std::io::stdout().flush().unwrap();
}
pub fn web_call(id: &str, tool: &str, input: Value) {
    emit(
        json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":tool,"input":input}]}}),
    );
}
pub fn web_result(id: &str, text: &str, is_error: bool) {
    emit(
        json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":id,"is_error":is_error,"content":text}]}}),
    );
}
