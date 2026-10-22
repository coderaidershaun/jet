//! Contract tests for the shared servers: the real `SharedServers`,
//! with the `fake-mcp` program standing in for the library programs. Each file directly in
//! `tests/` is its own test crate, so these sit flat beside the other contract tests.

use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use agent::{McpServer, McpServers, SharedServers};

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
fn a_shared_server_gets_its_own_port_and_restarts_at_the_same_address() {
    let dir = scratch("shared-restart");
    let shared = Shared::new();
    shared.configure(&only_quanty(&dir));
    let urls = shared.urls();
    let url = &urls["quanty"];
    assert!(
        url.starts_with("http://127.0.0.1:") && url.ends_with("/mcp"),
        "{url}"
    );
    assert_eq!(urls.len(), 1);
    let first = pids(&dir)[0];
    assert!(alive(first));

    let status = Command::new("/bin/kill")
        .args(["-KILL", &first.to_string()])
        .status()
        .unwrap();
    assert!(status.success());
    wait_until("the server to restart", || {
        let all = pids(&dir);
        all.len() == 2 && alive(all[1])
    });
    let second = pids(&dir)[1];
    assert!(!alive(first) && alive(second));
    assert_eq!(shared.urls(), urls);
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
    shared.shutdown();
    wait_until("polysim to be gone", || !alive(new_polysim[0]));
    assert!(moved_dir.join("got-term").exists());
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
