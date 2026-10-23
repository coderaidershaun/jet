//! A stand-in for the Claude Code program, for tests. It reads its instruction from the
//! first line of standard input that starts with a known keyword, so the local time line
//! that precedes a first message is ignored.

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
    if support::run(&args, &input, false) {
        return Ok(ExitCode::SUCCESS);
    }
    let Some(instruction) = input.lines().find(|line| is_instruction(line)) else {
        eprintln!("fake-claude: no instruction on standard input");
        return Ok(ExitCode::from(2));
    };

    if let Some(name) = instruction.strip_prefix("fixture:") {
        print_fixture(name.trim())?;
    } else if instruction == "hang" {
        hang()?;
    } else if instruction == "fail" {
        eprintln!("fake-claude: simulated failure");
        return Ok(ExitCode::from(1));
    } else if let Some(id) = args
        .iter()
        .position(|arg| arg == "--resume")
        .and_then(|at| args.get(at + 1))
    {
        eprintln!("No conversation found with session ID: {id}");
        return Ok(ExitCode::from(1));
    } else {
        print_fixture("sonnet-mood-reply")?;
    }
    Ok(ExitCode::SUCCESS)
}

fn is_instruction(line: &str) -> bool {
    line.starts_with("fixture:") || ["hang", "fail", "no-session"].contains(&line)
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

/// Starts a reply and then goes quiet, so a test can stop it halfway.
fn hang() -> io::Result<()> {
    std::fs::write(PID_FILE, std::process::id().to_string())?;
    let delta = |text: &str| {
        json!({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
            "delta": {"type": "text_delta", "text": text}}})
    };
    let mut out = io::stdout().lock();
    let init = json!({"type": "system", "subtype": "init", "session_id": "fake-session-hang",
        "model": "claude-fake"});
    for line in [init, delta("mood: neutral\n"), delta("Partial")] {
        writeln!(out, "{line}")?;
        out.flush()?;
    }
    std::thread::sleep(Duration::from_secs(30));
    Ok(())
}
