//! What Jet says to the page and what may cross to it: its own status line with the sentences
//! it carries, and the check that lets only whole, well-formed lines of the bridge through.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::BridgeLaunch;

/// The one protocol this Jet reads.
const PROTOCOL: u64 = 1;

/// What Jet tells the page about the bridge program itself, as the `status` of a `bridge` line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeStatus {
    /// A run is about to start: the first one, or one after a failure.
    Starting,
    /// A run ended on its own and will be started again after a delay.
    Restarting,
    /// The bridge speaks another protocol, or keeps failing at once, so it is not started again.
    Exited,
    /// The program or its folder is not there, or no path is set.
    Missing,
}

#[derive(Serialize)]
struct StatusLine<'a> {
    kind: &'static str,
    status: &'static str,
    detail: &'a str,
}

impl BridgeStatus {
    /// `{"kind":"bridge","status":"<word>","detail":"<detail>"}`. The detail is escaped, so any
    /// text is safe to pass.
    pub fn line(self, detail: &str) -> String {
        let status = match self {
            BridgeStatus::Starting => "starting",
            BridgeStatus::Restarting => "restarting",
            BridgeStatus::Exited => "exited",
            BridgeStatus::Missing => "missing",
        };
        serde_json::to_string(&StatusLine {
            kind: "bridge",
            status,
            detail,
        })
        .expect("a status line holds only text, which always serializes")
    }
}

/// What the check made of one line of the bridge's output.
#[derive(Debug, PartialEq)]
pub(super) enum Checked {
    /// A JSON object with a string `kind`: pass it on as it is.
    Pass { kind: String },
    /// Anything else: a plain text line, half a line, an array.
    Dropped,
    /// A `hello` that does not say protocol 1; holds what it said, if anything.
    OtherProtocol(Option<Value>),
}

/// Only the start of a line is read, but all of it is checked: the webview runs what a channel
/// sends as script, so a line must be exactly one JSON object before it may go.
#[derive(Deserialize)]
struct Head {
    kind: String,
    protocol: Option<Value>,
}

pub(super) fn check(line: &str) -> Checked {
    if !line.starts_with('{') {
        return Checked::Dropped;
    }
    let Ok(head) = serde_json::from_str::<Head>(line) else {
        return Checked::Dropped;
    };
    if head.kind == "hello" && head.protocol.as_ref().and_then(Value::as_u64) != Some(PROTOCOL) {
        return Checked::OtherProtocol(head.protocol);
    }
    Checked::Pass { kind: head.kind }
}

const STDERR_LINE_CHARS: usize = 200;

/// Why a program cannot be started, in words for the page; `None` when it can be tried.
pub(super) fn missing_detail(launch: &BridgeLaunch) -> Option<String> {
    if !launch.cwd.is_dir() {
        return Some(format!(
            "the polysim folder {} does not exist; set it in Settings",
            launch.cwd.display()
        ));
    }
    if !launch.program.is_file() {
        return Some(format!(
            "polysim-bridge was not found at {}. Build it in polysim with `cargo build --release --bin polysim-bridge`, or set its path in Settings.",
            launch.program.display()
        ));
    }
    None
}

pub(super) fn protocol_detail(found: Option<&serde_json::Value>) -> String {
    let said = found.map_or_else(
        || "no protocol number".to_owned(),
        |value| format!("protocol {value}"),
    );
    format!(
        "polysim-bridge speaks {said}; this Jet reads protocol {PROTOCOL}. Rebuild one of them so they match."
    )
}

pub(super) fn restart_detail(
    launch: &BridgeLaunch,
    code: Option<i32>,
    stderr: &str,
    delay: Duration,
) -> String {
    let how = exit_words(code);
    let wait = delay_text(delay);
    match last_stderr_line(launch, stderr) {
        Some(line) => format!("polysim-bridge exited with {how}: {line}. Trying again in {wait}."),
        None => format!("polysim-bridge exited with {how}. Trying again in {wait}."),
    }
}

/// Said when runs keep failing at once, which a new try will not fix.
pub(super) fn usage_detail(launch: &BridgeLaunch, code: Option<i32>, stderr: &str) -> String {
    let how = exit_words(code);
    let said =
        last_stderr_line(launch, stderr).map_or_else(String::new, |line| format!(": {line}"));
    format!(
        "polysim-bridge stopped twice, each time within a second of starting (last time with {how}){said}. Check its settings (strategy, links, token)."
    )
}

fn exit_words(code: Option<i32>) -> String {
    code.map_or_else(|| "no exit code".to_owned(), |code| format!("code {code}"))
}

/// The last line the program wrote to its error output, with the token hidden and the end cut,
/// or `None` when it wrote nothing.
fn last_stderr_line(launch: &BridgeLaunch, stderr: &str) -> Option<String> {
    let line = stderr
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let shown = hide_token(launch, line);
    let cut: String = shown.chars().take(STDERR_LINE_CHARS).collect();
    Some(cut.trim_end_matches('.').to_owned())
}

/// `1 s` for whole seconds, `200 ms` for the rest.
fn delay_text(delay: Duration) -> String {
    if delay.subsec_millis() == 0 && !delay.is_zero() {
        format!("{} s", delay.as_secs())
    } else {
        format!("{} ms", delay.as_millis())
    }
}

/// The text with the link token replaced, in case the bridge repeats its own arguments.
pub(super) fn hide_token(launch: &BridgeLaunch, text: &str) -> String {
    match launch.token.as_deref() {
        Some(token) if !token.is_empty() => text.replace(token, "<hidden>"),
        _ => text.to_owned(),
    }
}
