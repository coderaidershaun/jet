//! Contract tests for the workstation's door to polysim-bridge: the real `BridgeFeed`, with the
//! `fake-bridge` program standing in for polysim-bridge itself.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use agent::{BridgeFeed, BridgeLaunch, FeedError};
use serde_json::{Value, json};

/// Long enough for a loaded machine to start a freshly built program.
const PATIENCE: Duration = Duration::from_secs(20);

/// What a test hears from the feed: each line the sink was given, and when.
struct Heard {
    lines: Receiver<(Instant, String)>,
    seen: Vec<(Instant, String)>,
}

impl Heard {
    /// Waits for the next line the test has not looked at yet.
    fn next(&mut self) -> String {
        let (at, line) = self
            .lines
            .recv_timeout(PATIENCE)
            .expect("the feed should have sent another line");
        self.seen.push((at, line.clone()));
        line
    }

    fn next_json(&mut self) -> Value {
        serde_json::from_str(&self.next()).expect("every line the feed sends is JSON")
    }

    /// Reads lines until one has the given `kind` (and `status`, for Jet's own lines). A feed
    /// that keeps ticking never lets `next` time out, so this gives up on its own.
    fn next_of(&mut self, kind: &str, status: Option<&str>) -> Value {
        let deadline = Instant::now() + PATIENCE;
        while Instant::now() < deadline {
            let line = self.next_json();
            if line["kind"] == kind && status.is_none_or(|status| line["status"] == status) {
                return line;
            }
        }
        panic!("no {kind} line arrived within {PATIENCE:?}");
    }

    /// Every line that has already arrived, without waiting for more.
    fn drain(&mut self) -> Vec<String> {
        while let Ok(item) = self.lines.try_recv() {
            self.seen.push(item);
        }
        self.seen.iter().map(|(_, line)| line.clone()).collect()
    }

    /// True when nothing arrives within `quiet`.
    fn is_silent_for(&mut self, quiet: Duration) -> bool {
        matches!(
            self.lines.recv_timeout(quiet),
            Err(RecvTimeoutError::Timeout)
        )
    }
}

fn scratch_folder(name: &str) -> PathBuf {
    let folder = std::env::temp_dir().join(format!("agent-feed-{}-{name}", std::process::id()));
    std::fs::remove_dir_all(&folder).ok();
    std::fs::create_dir_all(&folder).unwrap();
    folder
}

fn launch(cwd: &Path, strategy_id: &str) -> BridgeLaunch {
    BridgeLaunch {
        program: PathBuf::from(env!("CARGO_BIN_EXE_fake-bridge")),
        cwd: cwd.to_path_buf(),
        strategy_id: strategy_id.to_owned(),
        links: vec![],
        token: None,
        restart_delays: vec![Duration::from_millis(100)],
    }
}

/// A sink for the feed, and the `Heard` that collects what it is given.
fn listen() -> (impl FnMut(String) + Send + 'static, Heard) {
    let (sender, lines) = mpsc::channel();
    let sink = move |line| {
        sender.send((Instant::now(), line)).ok();
    };
    (
        sink,
        Heard {
            lines,
            seen: Vec::new(),
        },
    )
}

fn start(launch: BridgeLaunch) -> (BridgeFeed, Heard) {
    let (sink, heard) = listen();
    (BridgeFeed::start(launch, sink), heard)
}

fn is_alive(pid: &str) -> bool {
    std::process::Command::new("kill")
        .args(["-0", pid])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[test]
fn feed_passes_bridge_lines_and_commands_until_stopped() {
    let cwd = scratch_folder("passes");
    let token = "s3cret-token-value";
    let (feed, mut heard) = start(BridgeLaunch {
        links: vec!["10.0.0.1:9310".into(), "10.0.0.2:9310".into()],
        token: Some(token.into()),
        ..launch(&cwd, "live-demo")
    });

    let starting: Value = serde_json::from_str(&heard.next()).unwrap();
    assert_eq!(starting["kind"], "bridge");
    assert_eq!(starting["status"], "starting", "Jet's own line comes first");
    assert!(starting["detail"].as_str().unwrap().contains("live-demo"));
    assert!(
        !starting.to_string().contains(token),
        "the token never shows"
    );

    assert_eq!(
        heard.next(),
        r#"{"kind":"hello","protocol":1,"bridge":"fake-bridge"}"#,
        "a bridge line passes unchanged; the plain line, the broken JSON line, the array and the object with script after it were dropped"
    );
    assert_eq!(heard.next(), r#"{"kind":"link","peer":"10.0.0.1:9310"}"#);
    let first = heard.next_of("tick", None);
    let second = heard.next_of("tick", None);
    assert!(second["seq"].as_u64() > first["seq"].as_u64());

    let args = std::fs::read_to_string(cwd.join("fake-bridge-args.json")).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&args).unwrap(),
        json!([
            "--strategy",
            "live-demo",
            "--link",
            "10.0.0.1:9310",
            "--link",
            "10.0.0.2:9310",
            "--token",
            token
        ]),
        "strategy, every link in order, then the token"
    );

    feed.send(r#"{"cmd":"select","instrument":1}"#).unwrap();
    feed.send(r#"{"cmd":"resync"}"#).unwrap();
    assert_eq!(
        heard.next_of("echo", None)["command"],
        json!({"cmd": "select", "instrument": 1})
    );
    assert_eq!(
        heard.next_of("echo", None)["command"],
        json!({"cmd": "resync"}),
        "commands reach the bridge in the order they were sent"
    );

    // A page reload: a new sink takes over the bridge that is running, and gets what it missed.
    let pid = std::fs::read_to_string(cwd.join("fake-bridge-pid")).unwrap();
    let (sink, mut reloaded) = listen();
    assert!(feed.reattach(sink));
    let heard_before_reload = heard.drain().len();
    let replayed: Vec<Value> = (0..3).map(|_| reloaded.next_json()).collect();
    assert_eq!(replayed[0]["kind"], "bridge");
    assert_eq!(replayed[0]["status"], "starting");
    assert_eq!(
        reloaded.seen[1].1, r#"{"kind":"hello","protocol":1,"bridge":"fake-bridge"}"#,
        "the bridge's own hello again, word for word"
    );
    assert_eq!(
        reloaded.seen[2].1, r#"{"kind":"link","peer":"10.0.0.1:9310"}"#,
        "and its link"
    );
    let echo = reloaded.next_of("echo", None);
    assert_eq!(
        echo["command"],
        json!({"cmd": "resync"}),
        "the bridge is asked to say everything again"
    );
    let between = &reloaded.seen[3..reloaded.seen.len() - 1];
    assert!(
        between
            .iter()
            .all(|(_, line)| line.contains(r#""kind":"tick""#)),
        "nothing but live ticks come between the replay and the resync: {between:?}"
    );
    assert_eq!(
        std::fs::read_to_string(cwd.join("fake-bridge-pid")).unwrap(),
        pid,
        "the same process keeps running"
    );

    assert!(is_alive(&pid));
    feed.stop();
    assert!(!is_alive(&pid), "stop leaves no process behind");
    let before_silence = reloaded.drain();
    assert!(
        before_silence.iter().all(|line| !line.contains("bye")
            && !line.contains("restarting")
            && !line.contains("fake-bridge is starting")),
        "the bridge's goodbye after its input closed is not passed on, and a stop is not a failure: {before_silence:?}"
    );
    assert!(
        reloaded.is_silent_for(Duration::from_millis(300)),
        "no line arrives after stop"
    );
    assert_eq!(
        heard.drain().len(),
        heard_before_reload,
        "the sink that was replaced hears nothing more"
    );
    assert!(matches!(feed.send("{}"), Err(FeedError::NotRunning)));
    assert!(
        !feed.reattach(|_| {}),
        "a stopped feed cannot be taken over"
    );
    feed.stop();
}

#[test]
fn a_crashed_bridge_restarts_after_each_delay() {
    let cwd = scratch_folder("crash");
    let delays = [Duration::from_millis(100), Duration::from_millis(200)];
    let (feed, mut heard) = start(BridgeLaunch {
        restart_delays: delays.to_vec(),
        ..launch(&cwd, "crash")
    });

    let mut runs = 0;
    while runs < 4 {
        let line = heard.next_json();
        if line["status"] == "starting" {
            runs += 1;
        }
    }
    feed.stop();

    let statuses: Vec<(Instant, Value)> = heard
        .seen
        .iter()
        .map(|(at, line)| (*at, serde_json::from_str::<Value>(line).unwrap()))
        .filter(|(_, line)| line["kind"] == "bridge")
        .collect();
    let words: Vec<&str> = statuses
        .iter()
        .map(|(_, line)| line["status"].as_str().unwrap())
        .collect();
    assert_eq!(
        words,
        [
            "starting",
            "restarting",
            "starting",
            "restarting",
            "starting",
            "restarting",
            "starting"
        ]
    );
    assert!(
        heard
            .seen
            .iter()
            .filter(|(_, line)| line.contains(r#""kind":"hello""#))
            .count()
            >= 3,
        "what a crashing bridge said before it crashed still passes"
    );

    // The delay after the first crash, then after the second, and then the last one again.
    let expected_ms = [100, 200, 200];
    for (n, expected) in expected_ms.iter().enumerate() {
        let (restarted_at, restarting) = &statuses[1 + 2 * n];
        let (starting_at, _) = &statuses[2 + 2 * n];
        let detail = restarting["detail"].as_str().unwrap();
        assert!(detail.contains("code 3"), "{detail}");
        assert!(
            detail.contains(r#"fake-bridge: simulated "crash""#),
            "the bridge's own error text arrives whole, quotes and all: {detail}"
        );
        assert!(detail.contains(&format!("in {expected} ms")), "{detail}");
        assert!(
            *starting_at - *restarted_at >= Duration::from_millis(*expected),
            "run {} started again after {:?}, sooner than {expected} ms",
            n + 2,
            *starting_at - *restarted_at
        );
    }
}

#[test]
fn a_bridge_on_another_protocol_is_stopped_and_not_restarted() {
    let cwd = scratch_folder("protocol");
    let (feed, mut heard) = start(launch(&cwd, "protocol-2"));

    assert_eq!(heard.next_json()["status"], "starting");
    let hello = heard.next_json();
    assert_eq!(hello["kind"], "hello", "the hello still reaches the page");
    assert_eq!(hello["protocol"], 2);
    let exited = heard.next_json();
    assert_eq!(exited["kind"], "bridge");
    assert_eq!(exited["status"], "exited");
    let detail = exited["detail"].as_str().unwrap();
    assert!(
        detail.contains("protocol 2") && detail.contains("protocol 1"),
        "{detail}"
    );

    // This bridge sleeps through its input closing, so Jet has to kill it.
    let pid = std::fs::read_to_string(cwd.join("fake-bridge-pid")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while is_alive(&pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!is_alive(&pid), "the process {pid} is still running");
    assert!(
        heard.is_silent_for(Duration::from_millis(700)),
        "nothing follows, and the delay is only 100 ms, so it was not started again: {:?}",
        heard.drain()
    );
    feed.stop();
}

#[test]
fn a_missing_bridge_is_reported_once() {
    let cwd = scratch_folder("missing");
    let program = cwd.join("no-such-folder").join("polysim-bridge");
    let (feed, mut heard) = start(BridgeLaunch {
        program: program.clone(),
        ..launch(&cwd, "live-demo")
    });

    assert_eq!(heard.next_json()["status"], "starting");
    let missing = heard.next_json();
    assert_eq!(missing["kind"], "bridge");
    assert_eq!(missing["status"], "missing");
    let detail = missing["detail"].as_str().unwrap();
    assert!(detail.contains(program.to_str().unwrap()), "{detail}");
    assert!(
        heard.is_silent_for(Duration::from_millis(700)),
        "nothing more is said, and no restart is tried: {:?}",
        heard.drain()
    );
    assert!(matches!(feed.send("{}"), Err(FeedError::NotRunning)));
}

#[test]
fn a_bridge_that_rejects_its_arguments_is_stopped_after_two_tries() {
    let cwd = scratch_folder("usage");
    // The first start of a freshly built program is the slow one, while the system checks it, and
    // on a busy machine it can pass the one second that marks a failure at start-up. Starting it
    // once here leaves the two runs below only their own short life.
    std::process::Command::new(env!("CARGO_BIN_EXE_fake-bridge"))
        .args(["--strategy", "usage"])
        .current_dir(&cwd)
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    let (feed, mut heard) = start(launch(&cwd, "usage"));

    let lines: Vec<Value> = (0..4).map(|_| heard.next_json()).collect();
    let words: Vec<&str> = lines
        .iter()
        .map(|line| {
            assert_eq!(line["kind"], "bridge");
            line["status"].as_str().unwrap()
        })
        .collect();
    assert_eq!(words, ["starting", "restarting", "starting", "exited"]);
    let detail = lines[3]["detail"].as_str().unwrap();
    assert!(detail.contains("code 2"), "{detail}");
    assert!(
        detail.contains("error: unexpected argument '--bogus' found"),
        "{detail}"
    );
    assert!(detail.contains("Check its settings"), "{detail}");

    assert!(
        heard.is_silent_for(Duration::from_millis(700)),
        "the delay is only 100 ms, so a third try would show by now: {:?}",
        heard.drain()
    );
    assert!(matches!(feed.send("{}"), Err(FeedError::NotRunning)));
    assert!(
        !feed.reattach(|_| {}),
        "a feed that gave up cannot be taken over"
    );
}
