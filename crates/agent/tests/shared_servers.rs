//! Contract tests for the shared servers: the real `SharedServers` and the real MCP client,
//! with the `fake-mcp` program standing in for the library programs. Each file directly in
//! `tests/` is its own test crate, so these sit flat beside the other contract tests.

use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use agent::{McpError, McpServer, McpServers, SharedServers};
use serde_json::{Value, json};

/// A new empty folder for one test, which is also the folder its fake server runs in.
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("agent-shared-{}-{name}", std::process::id()));
    std::fs::remove_dir_all(&dir).ok();
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The shared servers of one test. They are stopped when the test ends, even by a failed
/// assertion, so no fake server is left running.
struct Shared {
    servers: SharedServers,
    _one_at_a_time: MutexGuard<'static, ()>,
}

/// The tests run one at a time: a program one test starts can inherit the socket another
/// test uses to find a free port, and then that test's server cannot bind it.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

impl Shared {
    fn new() -> Shared {
        Shared {
            _one_at_a_time: ONE_AT_A_TIME.lock().unwrap_or_else(PoisonError::into_inner),
            servers: SharedServers::new(),
        }
    }
}

impl Deref for Shared {
    type Target = SharedServers;

    fn deref(&self) -> &SharedServers {
        &self.servers
    }
}

impl Drop for Shared {
    fn drop(&mut self) {
        self.servers.shutdown();
    }
}

fn fake(dir: &Path) -> McpServer {
    McpServer {
        enabled: true,
        command: PathBuf::from(env!("CARGO_BIN_EXE_fake-mcp")),
        cwd: Some(dir.to_owned()),
    }
}

fn only_quanty(dir: &Path) -> McpServers {
    McpServers {
        quanty: fake(dir),
        ..McpServers::default()
    }
}

/// The lines of a file the fake server appends to, or none when it was never written.
fn lines(dir: &Path, file: &str) -> Vec<String> {
    let text = std::fs::read_to_string(dir.join(file)).unwrap_or_default();
    text.lines().map(str::to_owned).collect()
}

fn pids(dir: &Path) -> Vec<u32> {
    lines(dir, "fake-mcp-pids")
        .iter()
        .map(|line| line.parse().unwrap())
        .collect()
}

/// What the fake server logged for each request, oldest first.
fn requests(dir: &Path) -> Vec<Value> {
    lines(dir, "fake-mcp-requests.jsonl")
        .iter()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn alive(pid: u32) -> bool {
    Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .output()
        .unwrap()
        .status
        .success()
}

/// Polls until the condition holds, for at most ten seconds.
fn wait_until(what: &str, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "gave up waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn a_shared_server_gets_its_own_port_and_answers_over_one_session() {
    let dir = scratch("one-session");
    let shared = Shared::new();
    shared.configure(&only_quanty(&dir));

    let urls = shared.urls();
    let url = &urls["quanty"];
    assert!(
        url.starts_with("http://127.0.0.1:") && url.ends_with("/mcp"),
        "{url}"
    );
    assert_eq!(urls.len(), 1);

    let echoed = shared.call("quanty", "echo", json!({"n": 1})).unwrap();
    assert_eq!(echoed, json!({"echo": {"n": 1}}));
    let failed = shared.call("quanty", "fail", json!({}));
    assert!(
        matches!(&failed, Err(McpError::Tool(text)) if text == "strat-x · te-y is not running"),
        "{failed:?}"
    );

    let log = requests(&dir);
    let methods: Vec<&str> = log.iter().map(|r| r["method"].as_str().unwrap()).collect();
    assert_eq!(
        methods,
        [
            "initialize",
            "notifications/initialized",
            "tools/call",
            "tools/call"
        ]
    );
    assert_eq!(log[0]["session"], Value::Null);
    let session = log[1]["session"].as_str().expect("the session id is sent");
    for request in &log[1..] {
        assert_eq!(request["session"], session);
    }
    for request in &log {
        assert_eq!(request["protocol"], "2025-06-18");
        assert_eq!(request["accept"], "application/json, text/event-stream");
    }
}

#[test]
fn an_event_stream_reply_gives_the_response_with_the_matching_id() {
    let dir = scratch("event-stream");
    std::fs::write(dir.join("sse"), "").unwrap();
    let shared = Shared::new();
    shared.configure(&only_quanty(&dir));

    let echoed = shared.call("quanty", "echo", json!({"n": 2})).unwrap();
    assert_eq!(echoed, json!({"echo": {"n": 2}}));
    let failed = shared.call("quanty", "fail", json!({}));
    assert!(matches!(failed, Err(McpError::Tool(_))), "{failed:?}");
}

#[test]
fn a_crashed_server_is_unreachable_then_comes_back_on_the_same_address_and_a_lost_session_is_opened_again()
 {
    let dir = scratch("crash");
    let shared = Shared::new();
    shared.configure(&only_quanty(&dir));
    let url = shared.urls()["quanty"].clone();
    let first = pids(&dir)[0];

    // Until the marker goes, every restart stops at once, so the server stays down for the
    // check below however slow the machine is.
    let refuse_restarts = dir.join("no-http");
    std::fs::write(&refuse_restarts, "").unwrap();
    shared.call("quanty", "crash", json!({})).unwrap();
    wait_until("the first copy to be gone", || !alive(first));
    let down = shared.call("quanty", "echo", json!({}));
    assert!(
        matches!(down, Err(McpError::Unreachable { .. })),
        "{down:?}"
    );
    std::fs::remove_file(&refuse_restarts).unwrap();

    wait_until("the server to come back", || {
        shared
            .call("quanty", "echo", json!({"again": true}))
            .is_ok()
    });
    assert_eq!(shared.urls()["quanty"], url);
    let all = pids(&dir);
    assert_eq!(all.len(), 2);
    assert!(!alive(all[0]) && alive(all[1]));

    // The server forgets every session while Jet still holds the old one.
    shared.call("quanty", "forget_sessions", json!({})).unwrap();
    let echoed = shared.call("quanty", "echo", json!({"n": 3})).unwrap();
    assert_eq!(echoed, json!({"echo": {"n": 3}}));
    let log = requests(&dir);
    let tail: Vec<(&str, i64)> = log[log.len() - 5..]
        .iter()
        .map(|r| (r["method"].as_str().unwrap(), r["status"].as_i64().unwrap()))
        .collect();
    assert_eq!(
        tail,
        [
            ("tools/call", 200),
            ("tools/call", 404),
            ("initialize", 200),
            ("notifications/initialized", 202),
            ("tools/call", 200),
        ]
    );
}

#[test]
fn a_program_without_http_is_left_to_claude() {
    let dir = scratch("no-http");
    std::fs::write(dir.join("no-http"), "").unwrap();
    let shared = Shared::new();
    let started = Instant::now();
    shared.configure(&only_quanty(&dir));

    // The exit decided it, not the two-second wait.
    assert!(started.elapsed() < Duration::from_millis(1500));
    assert!(shared.urls().is_empty());
    let refused = shared.call("quanty", "echo", json!({}));
    let Err(McpError::NotShared { reason, .. }) = &refused else {
        panic!("expected NotShared, got {refused:?}");
    };
    assert!(reason.contains("--http"), "{reason}");
    assert!(refused.unwrap_err().to_string().contains("--http"));
    assert!(pids(&dir).is_empty());
}

/// A small program that starts the fake server in the background and, when it is told to
/// stop, writes `got-term`, waits `stop_delay` seconds, writes `stopped` and stops the fake.
/// It shows that a server was asked to stop and when it was done.
///
/// It starts the fake with `--http <port>` only. The shell gives a job it starts in the
/// background an empty input, so a fake given `--watch-stdin` would stop at once.
fn stops_on_term(dir: &Path, stop_delay: &str) -> McpServer {
    use std::os::unix::fs::PermissionsExt;

    let fake = env!("CARGO_BIN_EXE_fake-mcp");
    let script = format!(
        "#!/bin/sh\n\
         trap 'echo term > got-term; sleep {stop_delay}; echo done > stopped; kill $pid; exit 0' TERM\n\
         \"{fake}\" --http \"$2\" &\n\
         pid=$!\n\
         wait $pid\n"
    );
    let program = dir.join("stops-on-term.sh");
    std::fs::write(&program, script).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    McpServer {
        enabled: true,
        command: program,
        cwd: Some(dir.to_owned()),
    }
}

fn modified(path: PathBuf) -> std::time::SystemTime {
    std::fs::metadata(path).unwrap().modified().unwrap()
}

#[test]
fn a_settings_change_stops_the_old_copy_first_restarts_only_that_server_and_switching_off_sends_sigterm()
 {
    let (polysim_dir, moved_dir, quanty_dir) = (
        scratch("change-polysim"),
        scratch("change-polysim-moved"),
        scratch("change-quanty"),
    );
    let mut servers = McpServers {
        // Slow to stop, so a new copy that started too early would show in the file times.
        polysim: stops_on_term(&polysim_dir, "0.5"),
        quanty: stops_on_term(&quanty_dir, "0"),
    };
    let shared = Shared::new();
    shared.configure(&servers);
    let urls = shared.urls();
    assert_eq!(urls.len(), 2);
    let (old_polysim, quanty) = (pids(&polysim_dir)[0], pids(&quanty_dir)[0]);

    shared.configure(&servers);
    assert_eq!(shared.urls(), urls);
    assert_eq!((pids(&polysim_dir).len(), pids(&quanty_dir).len()), (1, 1));

    // polysim moves to another folder: its old copy is gone before the new one starts.
    servers.polysim.cwd = Some(moved_dir.clone());
    shared.configure(&servers);
    assert!(polysim_dir.join("got-term").exists());
    wait_until("the old polysim to be gone", || !alive(old_polysim));
    let new_polysim = pids(&moved_dir);
    assert_eq!(new_polysim.len(), 1);
    assert!(alive(new_polysim[0]));
    assert!(
        modified(moved_dir.join("fake-mcp-pids")) > modified(polysim_dir.join("stopped")),
        "the new polysim started before the old one had stopped"
    );
    assert_eq!(shared.urls()["quanty"], urls["quanty"]);
    assert_eq!(pids(&quanty_dir), [quanty]);
    assert!(alive(quanty) && !quanty_dir.join("got-term").exists());

    // Switching quanty off asks it to stop, and it has stopped when `configure` returns.
    servers.quanty.enabled = false;
    shared.configure(&servers);
    assert!(quanty_dir.join("got-term").exists());
    wait_until("quanty to be gone", || !alive(quanty));
    assert_eq!(shared.urls().keys().collect::<Vec<_>>(), ["polysim"]);
    let off = shared.call("quanty", "echo", json!({}));
    assert!(matches!(off, Err(McpError::NotShared { .. })), "{off:?}");

    shared.shutdown();
    wait_until("polysim to be gone", || !alive(new_polysim[0]));
    assert!(moved_dir.join("got-term").exists());
    let closed = shared.call("polysim", "echo", json!({}));
    assert!(
        matches!(closed, Err(McpError::NotShared { .. })),
        "{closed:?}"
    );
}

/// A small program that ignores SIGTERM and then becomes the fake server. Nothing but a
/// kill or the end of its input can stop it.
fn ignores_term(dir: &Path) -> McpServer {
    use std::os::unix::fs::PermissionsExt;

    let fake = env!("CARGO_BIN_EXE_fake-mcp");
    let script = format!("#!/bin/sh\ntrap '' TERM\nexec \"{fake}\" \"$@\"\n");
    let program = dir.join("ignores-term.sh");
    std::fs::write(&program, script).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    McpServer {
        enabled: true,
        command: program,
        cwd: Some(dir.to_owned()),
    }
}

#[test]
fn a_shared_polysim_watches_its_input_and_stops_when_it_closes() {
    let (polysim_dir, quanty_dir) = (scratch("watch-polysim"), scratch("watch-quanty"));
    let servers = McpServers {
        polysim: ignores_term(&polysim_dir),
        quanty: fake(&quanty_dir),
    };
    let shared = Shared::new();
    shared.configure(&servers);
    assert_eq!(shared.urls().len(), 2);
    let polysim = pids(&polysim_dir)[0];

    // While Jet runs, its input stays open: a polysim whose input was closed from the start
    // would have gone within this pause.
    std::thread::sleep(Duration::from_millis(500));
    assert!(alive(polysim));
    assert!(lines(&polysim_dir, "stdin-closed").is_empty());

    // Far below the 25 seconds before a kill: only the closed input can have stopped it.
    let started = Instant::now();
    shared.shutdown();
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "polysim took {:?} to stop",
        started.elapsed()
    );
    assert_eq!(lines(&polysim_dir, "stdin-closed").len(), 1);
    assert!(!alive(polysim));
    // quanty does not know the flag, so it was not given it.
    assert!(lines(&quanty_dir, "stdin-closed").is_empty());
    assert!(!alive(pids(&quanty_dir)[0]));
}
