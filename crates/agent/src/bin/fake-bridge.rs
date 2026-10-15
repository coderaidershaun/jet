//! A stand-in for polysim-bridge, for tests. It writes the arguments it was given and its process
//! number to files in its working folder, then acts out the strategy it was asked for: a crash, a
//! bridge on another protocol, a bridge that rejects its arguments, or a well-behaved one that
//! echoes every command it is sent.

use std::io::{self, BufRead, Write};
use std::process::ExitCode;
use std::time::Duration;

use serde_json::{Value, json};

const ARGS_FILE: &str = "fake-bridge-args.json";
const PID_FILE: &str = "fake-bridge-pid";
const TICK_EVERY: Duration = Duration::from_millis(16);
/// How long it takes to leave once its input has closed, so a caller that does not wait notices.
const GOODBYE_TAKES: Duration = Duration::from_millis(150);
const HELLO: &str = r#"{"kind":"hello","protocol":1,"bridge":"fake-bridge"}"#;

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("fake-bridge: {error}");
            ExitCode::from(2)
        }
    }
}

/// What the arguments asked for. The token is only recorded, never used.
struct Arguments {
    strategy: String,
    links: Vec<String>,
}

fn parse(args: &[String]) -> io::Result<Arguments> {
    let mut strategy = None;
    let mut links = Vec::new();
    let mut words = args.iter();
    while let Some(flag) = words.next() {
        let value = words
            .next()
            .ok_or_else(|| io::Error::other(format!("{flag} needs a value")))?;
        match flag.as_str() {
            "--strategy" => strategy = Some(value.clone()),
            "--link" => links.push(value.clone()),
            "--token" => {}
            other => return Err(io::Error::other(format!("unknown argument {other}"))),
        }
    }
    let strategy = strategy.ok_or_else(|| io::Error::other("--strategy is required"))?;
    Ok(Arguments { strategy, links })
}

fn run() -> io::Result<ExitCode> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::fs::write(ARGS_FILE, json!(args).to_string())?;
    std::fs::write(PID_FILE, std::process::id().to_string())?;
    let arguments = parse(&args)?;

    match arguments.strategy.as_str() {
        "crash" => {
            print_line(HELLO)?;
            // The quotes must reach the page escaped, inside Jet's own line.
            eprintln!(r#"fake-bridge: simulated "crash""#);
            Ok(ExitCode::from(3))
        }
        "usage" => {
            // Like a real bridge given arguments it does not know: nothing on standard output.
            eprintln!("error: unexpected argument '--bogus' found");
            Ok(ExitCode::from(2))
        }
        "protocol-2" => {
            print_line(r#"{"kind":"hello","protocol":2,"bridge":"fake-bridge"}"#)?;
            // Ignores its input, so the caller has to kill it.
            std::thread::sleep(Duration::from_secs(30));
            Ok(ExitCode::SUCCESS)
        }
        _ => behave(&arguments),
    }
}

/// Four lines a page must never see first (plain text, half a line of JSON, a JSON array, and a
/// whole object with script after it), then hello, the first link and a tick every 16 ms. Every
/// command line is echoed back; when the input closes, it says bye and exits.
fn behave(arguments: &Arguments) -> io::Result<ExitCode> {
    print_line("fake-bridge is starting")?;
    print_line(r#"{"kind":"half a line""#)?;
    print_line(r#"["kind","array"]"#)?;
    print_line(r#"{"kind":"tick"}); alert("not a bridge line"); ({"kind":"tick"}"#)?;
    print_line(HELLO)?;
    let peer = arguments.links.first().map_or("", String::as_str);
    print_line(&format!(r#"{{"kind":"link","peer":{}}}"#, json!(peer)))?;
    std::thread::spawn(|| {
        for seq in 1_u64.. {
            let line = format!(r#"{{"kind":"tick","session":1,"seq":{seq}}}"#);
            if print_line(&line).is_err() {
                break;
            }
            std::thread::sleep(TICK_EVERY);
        }
    });
    for line in io::stdin().lock().lines() {
        let line = line?;
        let command = serde_json::from_str::<Value>(&line).unwrap_or(Value::String(line));
        print_line(&format!(r#"{{"kind":"echo","command":{command}}}"#))?;
    }
    std::thread::sleep(GOODBYE_TAKES);
    print_line(r#"{"kind":"bye","reason":"stdin closed"}"#)?;
    Ok(ExitCode::SUCCESS)
}

/// Writes one whole line while holding the lock on standard output, so two threads never mix
/// their lines.
fn print_line(line: &str) -> io::Result<()> {
    let mut out = io::stdout().lock();
    writeln!(out, "{line}")?;
    out.flush()
}
