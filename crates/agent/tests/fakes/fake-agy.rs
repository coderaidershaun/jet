//! A stand-in for Google's agy program, built only so tests can run it. Like agy, it takes its
//! agent, its hook and Jet's tool server from the files of the folder it runs in, asks the hook
//! before each tool call, and writes agy's stream events.
mod support;

use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, ExitCode, Stdio};
use std::sync::Mutex;

const AGENTS: &str = ".agents";

fn emit(value: Value) {
    println!("{value}");
    std::io::stdout().flush().unwrap();
}

/// One run, as far as the files of the folder and the arguments describe it.
struct Agy {
    conversation: String,
    /// The hooks file the agent names, beside the agents folder.
    hooks_file: String,
    inherits_mcp: bool,
    prompt: String,
    /// The id, name and arguments of each call of the script. A call's place gives its step
    /// number.
    calls: Mutex<Vec<(String, String, Value)>>,
}

impl Agy {
    fn step(&self, index: usize, state: &str, kind: &str, more: Value) {
        let mut step = json!({"conversation_id": self.conversation, "step_index": index,
            "state": state, "step_type": kind});
        for (key, value) in more.as_object().into_iter().flatten() {
            step[key] = value.clone();
        }
        emit(json!({"event": "step_update", "step_update": step}));
    }

    fn text(&self, index: usize, state: &str, delta: Option<&str>, usage: Option<[u64; 3]>) {
        let mut more = json!({});
        if let Some(delta) = delta {
            more["text_delta"] = json!(delta);
        }
        if let Some([input, cached, output]) = usage {
            more["usage"] = json!({"input_tokens": input, "output_tokens": output,
                "thinking_tokens": 0, "cache_read_tokens": cached, "total_tokens": input + output});
        }
        self.step(index, state, "agent_response", more);
    }

    fn tool(&self, index: usize, state: &str, name: &str, arguments: &Value, more: Value) {
        let mut info = json!({"name": name});
        // agy leaves the parameters out when a call has none.
        if arguments
            .as_object()
            .is_some_and(|fields| !fields.is_empty())
        {
            info["parameters"] = arguments.clone();
        }
        for (key, value) in more.as_object().into_iter().flatten() {
            info[key] = value.clone();
        }
        self.step(
            index,
            state,
            "tool",
            json!({"tool_name": name, "tool_info": info}),
        );
    }

    /// Writes the call as started, and as refused when the hook refuses it.
    fn start_call(&self, index: usize, name: &str, arguments: &Value) -> Option<String> {
        self.tool(index, "ACTIVE", name, arguments, json!({}));
        let refusal = self.refused(index, name, arguments)?;
        let error = json!({"error": {"type": "TOOL_ERROR", "message": refusal}});
        self.tool(index, "ERROR", name, arguments, error);
        Some(refusal)
    }

    /// Asks the hook the agent names, the way agy does: the command runs through `sh -c` in the
    /// folder of the hooks file, with the call on standard input. A hooks file that is missing
    /// or not JSON means no hook at all.
    fn refused(&self, index: usize, name: &str, arguments: &Value) -> Option<String> {
        let hooks: Value = std::fs::read_to_string(Path::new(AGENTS).join(&self.hooks_file))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())?;
        let cwd = std::env::current_dir().unwrap();
        let input = json!({
            "conversationId": self.conversation,
            "cwd": cwd,
            "hookEventName": "PreToolUse",
            "lastUserInput": self.prompt,
            "modelName": "gemini-4-neon-low",
            "stepIdx": index,
            "toolCall": {"args": arguments, "id": format!("call_{index}"), "name": name},
            "workspacePaths": [cwd],
        });
        let commands = hooks
            .as_object()?
            .values()
            .flat_map(|hook| hook["PreToolUse"].as_array().into_iter().flatten())
            .flat_map(|group| group["hooks"].as_array().into_iter().flatten())
            .filter_map(|hook| hook["command"].as_str());
        for command in commands {
            let mut child = Command::new("sh")
                .args(["-c", command])
                .current_dir(AGENTS)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            let mut stdin = child.stdin.take().unwrap();
            stdin.write_all(input.to_string().as_bytes()).unwrap();
            drop(stdin);
            let output = child.wait_with_output().unwrap();
            let answer = serde_json::from_slice::<Value>(&output.stdout).unwrap_or_default();
            match answer["decision"].as_str() {
                Some("allow") if output.status.success() => {}
                Some("deny") => {
                    let reason = answer["reason"].as_str().unwrap_or_default();
                    return Some(format!("tool call denied by pre-tool hook: {reason}"));
                }
                _ => {
                    return Some(format!(
                        "JSON hook failed: command failed: {}",
                        output.status
                    ));
                }
            }
        }
        None
    }

    fn finish_call(&self, index: usize, name: &str, arguments: &Value, text: &str) {
        let output =
            format!("Created At: 2026-11-24T08:36:30Z\nCompleted At: 2026-11-24T08:36:31Z\n{text}");
        self.tool(index, "DONE", name, arguments, json!({"output": output}));
    }

    /// The closing line. Like agy's, its usage counts the whole conversation, not this turn.
    fn result(&self, response: &str, structured: Value) {
        emit(
            json!({"event": "result", "result": {"conversation_id": self.conversation,
            "status": "SUCCESS", "response": response, "duration_seconds": 1.5, "num_turns": 2,
            "structured_output": structured,
            "usage": {"input_tokens": 9155, "output_tokens": 392, "thinking_tokens": 297,
                "cache_read_tokens": 520, "total_tokens": 9547}}}),
        );
    }

    /// The step number, name and arguments of a call of the script.
    fn call_of(&self, id: &str) -> (usize, String, Value) {
        let calls = self.calls.lock().unwrap();
        let at = calls.iter().position(|(known, ..)| known == id).unwrap();
        (at + 2, calls[at].1.clone(), calls[at].2.clone())
    }
}

impl support::Provider for Agy {
    fn connection(&self, _args: &[String]) -> (String, String) {
        assert!(self.inherits_mcp, "the agent does not take the tool server");
        let text = std::fs::read_to_string(Path::new(AGENTS).join("mcp_config.json")).unwrap();
        let config: Value = serde_json::from_str(&text).unwrap();
        let server = &config["mcpServers"]["jet"];
        let eager = agent::FACADE_TOOLS.map(|tool| server["tools"][tool]["eager"] == true);
        assert_eq!(server["enabledTools"], json!(agent::FACADE_TOOLS));
        assert!(eager.iter().all(|eager| *eager), "{server}");
        (
            server["url"].as_str().unwrap().into(),
            server["headers"][agent::TURN_HEADER]
                .as_str()
                .unwrap()
                .into(),
        )
    }
    fn start(&self) {}
    fn call(&self, id: &str, tool: &str, arguments: &Value) -> Option<String> {
        let name = format!("mcp_jet_{tool}");
        let call = (id.to_owned(), name.clone(), arguments.clone());
        self.calls.lock().unwrap().push(call);
        self.start_call(self.call_of(id).0, &name, arguments)
    }
    fn result(&self, id: &str, result: Value) {
        let (index, name, arguments) = self.call_of(id);
        let text = result["content"][0]["text"].as_str().unwrap_or_default();
        if result["isError"] == true {
            let error = json!({"error": {"type": "TOOL_ERROR", "message": text}});
            return self.tool(index, "ERROR", &name, &arguments, error);
        }
        self.finish_call(index, &name, &arguments, text);
    }
    fn finish(&self) {
        let last = self.calls.lock().unwrap().len() + 2;
        self.text(last, "ACTIVE", Some("mood: neutral\nFixture app"), None);
        self.text(last, "DONE", Some(" answered.\n"), Some([20, 0, 5]));
        self.result("mood: neutral\nFixture app answered.\n", Value::Null);
    }
    fn names_tool_use(&self) -> bool {
        false
    }
}

/// The version this stand-in says it is: the one after the last `-` of the name it was started
/// under, such as `agy-1.5.17`, or else the version Jet's limit was proven on.
fn version() -> String {
    let started_as = std::env::args().next().unwrap_or_default();
    let name = Path::new(&started_as).file_name().unwrap_or_default();
    let last = name
        .to_string_lossy()
        .rsplit('-')
        .next()
        .unwrap()
        .to_owned();
    match last.starts_with(|first: char| first.is_ascii_digit()) {
        true => last,
        false => "1.5.16".to_owned(),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--version"] {
        println!("{}", version());
        return ExitCode::SUCCESS;
    }
    std::fs::write("fake-agy-args.json", json!(args).to_string()).unwrap();
    let value = |flag: &str| {
        args.iter()
            .position(|arg| arg == flag)
            .map(|at| args[at + 1].clone())
    };
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    std::fs::write("fake-agy-stdin.txt", &input).unwrap();
    let message: Value = serde_json::from_str(input.trim_end()).unwrap_or_default();
    let prompt = message["message"]["content"].as_str().unwrap_or_default();
    let is_user_message = message["event"] == "user" && input.ends_with('\n');

    let agent_name = value("--agent").unwrap_or_default();
    let agent_file = Path::new(AGENTS).join(format!("agents/{agent_name}.md"));
    let failed_before_the_turn = |error: String| {
        eprintln!("error: {error}");
        emit(
            json!({"event": "result", "result": {"conversation_id": "", "status": "ERROR",
            "response": "", "error": error, "num_turns": 0, "finished_reason": "error"}}),
        );
        ExitCode::from(1)
    };
    let Ok(agent) = std::fs::read_to_string(&agent_file) else {
        return failed_before_the_turn(format!(
            "unknown agent \"{agent_name}\" (no custom agents are available)"
        ));
    };
    if !is_user_message {
        return failed_before_the_turn("standard input holds no stream-json user message".into());
    }
    if prompt == "exit" {
        return failed_before_the_turn("authentication failed or timed out".into());
    }
    if let Ok(config) = std::fs::read(Path::new(AGENTS).join("mcp_config.json")) {
        std::fs::write("fake-agy-mcp.json", config).unwrap();
    }
    let front_matter = agent.split("\n---\n").next().unwrap_or_default();
    let resumed = value("--conversation");
    let agy = Agy {
        conversation: resumed.clone().unwrap_or("fake-agy-conversation".into()),
        hooks_file: front_matter
            .lines()
            .find_map(|line| line.strip_prefix("  - ../"))
            .unwrap_or_default()
            .to_owned(),
        inherits_mcp: front_matter.contains("\ninheritMcp: true"),
        prompt: prompt.to_owned(),
        calls: Mutex::new(Vec::new()),
    };
    // The list of the first line is the same in every run of agy and is not the session's own.
    emit(
        json!({"event": "init", "conversation_id": agy.conversation, "init": {"model": value("--model"),
        "cwd": std::env::current_dir().unwrap(), "agent": agent_name,
        "tools": ["call_mcp_tool", "finish", "manage_task", "run_command", "search_web", "write_to_file"],
        "permission_mode": "always-proceed"}}),
    );
    agy.step(0, "DONE", "user_input", json!({}));
    if resumed.is_some() {
        agy.step(1, "DONE", "system_message", json!({}));
    }
    if support::run_as(&agy, &args, prompt) {
        return ExitCode::SUCCESS;
    }
    match prompt {
        "hang" => std::thread::sleep(std::time::Duration::from_secs(30)),
        "fail" => {
            eprintln!("AGY_ERROR: {{\"short_error\":\"quota\"}}");
            emit(
                json!({"event": "result", "result": {"conversation_id": agy.conversation,
                "status": "ERROR", "response": "", "error": "agent executor error: quota"}}),
            );
            return ExitCode::from(3);
        }
        // A tool of agy's own that ran, as it would with the hook gone: one that ended well, one
        // that failed by itself, and one that agy writes with no name.
        "outside" | "outside and failed" | "outside with no name" => {
            let command = json!({"CommandLine": "touch marker"});
            agy.tool(2, "ACTIVE", "run_command", &command, json!({}));
            match prompt {
                "outside" => agy.tool(2, "DONE", "run_command", &command, json!({"output": "ok"})),
                "outside with no name" => agy.step(2, "DONE", "unknown", json!({})),
                _ => {
                    let error =
                        json!({"error": {"type": "TOOL_ERROR", "message": "exit status 1"}});
                    agy.tool(2, "ERROR", "run_command", &command, error);
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
        // Lines that agy at the proven version does not write.
        "a new event" | "a new step" | "not json" => {
            match prompt {
                "a new event" => {
                    emit(json!({"event": "command_result", "command": {"name": "help"}}))
                }
                "a new step" => agy.step(2, "DONE", "browser", json!({})),
                _ => println!("Warning: something changed"),
            }
            std::io::stdout().flush().unwrap();
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
        _ if value("--json-schema").is_some() => review(&agy, &value("--json-schema").unwrap()),
        _ => reply(&agy),
    }
    ExitCode::SUCCESS
}

/// A reply with two model calls: words, a call the hook refuses, a call of Jet's tool, words.
fn reply(agy: &Agy) {
    agy.text(1, "ACTIVE", Some("mood: hel"), None);
    agy.text(1, "ACTIVE", Some("lo\nLet me look."), None);
    agy.text(1, "DONE", None, Some([2048, 0, 196]));
    let list = json!({"Action": "list"});
    if agy.start_call(2, "manage_task", &list).is_none() {
        agy.finish_call(2, "manage_task", &list, "No background tasks are running.");
    }
    let query = json!({"query": "vega"});
    if agy.start_call(3, "mcp_jet_tools_search", &query).is_none() {
        let found = r#"{"errors":[],"tools":[],"truncated":false}"#;
        agy.finish_call(3, "mcp_jet_tools_search", &query, found);
    }
    agy.text(4, "ACTIVE", Some("Hello from"), None);
    agy.text(4, "DONE", Some(" agy.\n"), Some([2368, 520, 40]));
    agy.result("mood: hello\nLet me look.Hello from agy.\n", Value::Null);
}

/// An answer in the schema, which agy gives through its `finish` tool.
fn review(agy: &Agy, schema: &str) {
    serde_json::from_str::<Value>(schema).expect("the schema is JSON text");
    let answer = json!({"ok": true});
    agy.text(1, "DONE", Some(&answer.to_string()), Some([538, 0, 220]));
    if agy.refused(2, "finish", &answer).is_some() {
        return agy.result(&answer.to_string(), Value::Null);
    }
    agy.step(2, "DONE", "finish", json!({}));
    agy.result(&answer.to_string(), answer);
}
