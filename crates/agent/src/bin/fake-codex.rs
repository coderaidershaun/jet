//! Codex process stand-in for protocol and cancellation tests.
mod support;
use serde_json::{Value, json};
use std::io::{Read, Write};
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::fs::write("fake-codex-args.json", json!(args).to_string()).unwrap();
    let mut prompt = String::new();
    std::io::stdin().read_to_string(&mut prompt).unwrap();
    if support::run(&args, &prompt, true) {
        return;
    }
    if prompt == "exit" {
        eprintln!("Codex is not signed in");
        std::process::exit(1);
    }
    let emit = |v: Value| {
        println!("{v}");
        std::io::stdout().flush().unwrap();
    };
    emit(json!({"type":"thread.started","thread_id":"codex-session"}));
    if prompt == "hang" {
        std::thread::sleep(std::time::Duration::from_secs(30));
        return;
    }
    if prompt == "fail" {
        emit(json!({"type":"turn.failed","error":{"message":"usage limit"}}));
        return;
    }
    emit(
        json!({"type":"item.started","item":{"type":"mcp_tool_call","id":"tool1","server":"quanty","tool":"search","arguments":{"question":"vega"}}}),
    );
    if prompt == "tool-fail" {
        emit(
            json!({"type":"item.completed","item":{"type":"mcp_tool_call","id":"tool1","status":"failed","result":null,"error":{"message":"tool unavailable"}}}),
        );
    } else {
        emit(
            json!({"type":"item.completed","item":{"type":"mcp_tool_call","id":"tool1","status":"completed","result":{"content":[{"type":"text","text":"found"}],"structured_content":{"results":[]}}}}),
        );
    }
    let text = if let Some(at) = args.iter().position(|a| a == "--output-schema") {
        let schema: Value =
            serde_json::from_str(&std::fs::read_to_string(&args[at + 1]).unwrap()).unwrap();
        assert_eq!(schema["type"], "object");
        r#"{"ok":true}"#
    } else {
        "mood: happy\nHello from Codex."
    };
    emit(json!({"type":"item.completed","item":{"type":"agent_message","text":text}}));
    emit(
        json!({"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":12,"reasoning_output_tokens":4}}),
    );
}
