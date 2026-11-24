//! A stand-in for the Claude Code program, built only so tests can run it. It reads its instruction from the
//! first line of standard input that starts with a known keyword, so the local time line
//! that precedes a first message is ignored. A turn that answers a reaction gets no instruction
//! from the user, so it decides that nothing is needed, or hangs without words for ⏳.

mod claude_codex;
mod support;

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::process::ExitCode;
use std::time::Duration;

use serde_json::json;

const ARGS_FILE: &str = "fake-claude-args.json";
const ENV_FILE: &str = "fake-claude-env.json";
const PID_FILE: &str = "fake-claude-pid";
/// One line for each run, the way the Python stand-in counts them.
const CALLS_FILE: &str = "calls";
/// How a turn that answers the user's reaction begins.
const REACTED: &str = "[The user just put ";

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("fake-claude: {error}");
            ExitCode::from(2)
        }
    }
}

fn run() -> io::Result<ExitCode> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::fs::write(ARGS_FILE, json!(args).to_string())?;
    let claude_vars: BTreeMap<String, String> = std::env::vars_os()
        .map(|(name, value)| {
            let text = |os: OsString| os.to_string_lossy().into_owned();
            (text(name), text(value))
        })
        .filter(|(name, _)| name.starts_with("CLAUDE"))
        .collect();
    std::fs::write(ENV_FILE, json!(claude_vars).to_string())?;

    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let call = if args.iter().any(|arg| arg == "--json-schema") {
        "review\n"
    } else {
        "reply\n"
    };
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(CALLS_FILE)?
        .write_all(call.as_bytes())?;
    if claude_codex::run(&args, &input, false) {
        return Ok(ExitCode::SUCCESS);
    }
    let Some(instruction) = input.lines().find(|line| is_instruction(line)) else {
        eprintln!("fake-claude: no instruction on standard input");
        return Ok(ExitCode::from(2));
    };

    if let Some(name) = instruction.strip_prefix("fixture:") {
        print_fixture(name.trim())?;
    } else if let Some(script) = instruction.strip_prefix("say:") {
        let script: serde_json::Value = serde_json::from_str(script)?;
        let parts: Vec<&str> = script["parts"]
            .as_array()
            .map(|parts| parts.iter().filter_map(serde_json::Value::as_str).collect())
            .unwrap_or_default();
        say(&parts, script["wait"].as_str())?;
    } else if instruction.starts_with(REACTED) && instruction.contains('⏳') {
        hang(&["mood: neutral\n"])?;
    } else if instruction.starts_with(REACTED) {
        say(&["mood: neutral\nreact: none\n"], None)?;
    } else {
        hang(&["mood: neutral\n", "Partial"])?;
    }
    Ok(ExitCode::SUCCESS)
}

fn is_instruction(line: &str) -> bool {
    ["fixture:", "say:", REACTED]
        .iter()
        .any(|keyword| line.starts_with(keyword))
        || line == "hang"
}

/// Streams each part of a reply. With `wait`, the last part waits until a file of that name
/// exists, so a test can act while the reply is still running.
fn say(parts: &[&str], wait: Option<&str>) -> io::Result<()> {
    let mut out = io::stdout().lock();
    let init = json!({"type": "system", "subtype": "init", "session_id": "fake-session-say",
        "model": "claude-fake"});
    writeln!(out, "{init}")?;
    for (index, part) in parts.iter().enumerate() {
        if let Some(gate) = wait.filter(|_| index + 1 == parts.len()) {
            while !std::path::Path::new(gate).exists() {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        let delta = json!({"type": "stream_event", "event": {"type": "content_block_delta",
            "index": 0, "delta": {"type": "text_delta", "text": part}}});
        writeln!(out, "{delta}")?;
        out.flush()?;
    }
    let result = json!({"type": "result", "subtype": "success", "result": parts.concat(),
        "duration_ms": 1, "usage": {"input_tokens": 10, "output_tokens": 5}});
    writeln!(out, "{result}")?;
    out.flush()
}

fn print_fixture(name: &str) -> io::Result<()> {
    if name.is_empty() || name.contains(['/', '\\']) || name.contains("..") {
        return Err(io::Error::other(format!("not a fixture name: {name}")));
    }
    let path = format!("{}/tests/fixtures/{name}.jsonl", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path)
        .map_err(|error| io::Error::new(error.kind(), format!("{path}: {error}")))?;
    let mut out = io::stdout().lock();
    for line in text.lines() {
        writeln!(out, "{line}")?;
        out.flush()?;
    }
    Ok(())
}

/// Starts a reply with these parts and then goes quiet, so a test can stop it halfway.
fn hang(parts: &[&str]) -> io::Result<()> {
    std::fs::write(PID_FILE, std::process::id().to_string())?;
    let delta = |text: &str| {
        json!({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
            "delta": {"type": "text_delta", "text": text}}})
    };
    let mut out = io::stdout().lock();
    let init = json!({"type": "system", "subtype": "init", "session_id": "fake-session-hang",
        "model": "claude-fake"});
    for line in std::iter::once(init).chain(parts.iter().map(|part| delta(part))) {
        writeln!(out, "{line}")?;
        out.flush()?;
    }
    std::thread::sleep(Duration::from_secs(30));
    Ok(())
}
