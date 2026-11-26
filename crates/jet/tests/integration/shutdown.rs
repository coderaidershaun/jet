use super::support::{Host, request};
use serde_json::json;
use std::time::{Duration, Instant};

#[test]
fn shutdown_bounds_provider_and_review_cleanup() {
    let mut host = Host::start_with(&["--review-quiet-seconds", "1"]);
    host.post("/api/chat/send", request("shutdown"));
    host.until(|snapshot| snapshot["active"]["text"] == "Partial browser reply");
    host.post("/api/chat/stop", json!({"requestId":"shutdown"}));
    host.until(|snapshot| snapshot["active"].is_null());
    // The chat goes quiet, so its notes review starts. The stand-in never answers the review of a
    // thread that says "hang", so the review is still running when the server stops.
    let deadline = Instant::now() + Duration::from_secs(8);
    while host.invocations() < 2 {
        assert!(Instant::now() < deadline, "the notes review did not start");
        std::thread::sleep(Duration::from_millis(20));
    }

    let sleeper = host.dir.path().join("no-read.sh");
    std::fs::write(&sleeper, "#!/bin/sh\nexec sleep 120\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&sleeper, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    host.set_programs(json!({"claudePath": sleeper}));
    let mut blocked = request("no-stdin-reader");
    blocked["text"] = "x".repeat(100_000).into();
    let client: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(3)))
        .build()
        .into();
    let response = host
        .signed(client.post(format!("{}/api/chat/send", host.url)))
        .header("content-type", "application/json")
        .send(blocked.to_string())
        .unwrap();
    assert_eq!(
        response.status(),
        200,
        "a provider that does not read stdin must remain cancellable"
    );
    let began = Instant::now();
    assert!(
        std::process::Command::new("kill")
            .args(["-TERM", &host.child.id().to_string()])
            .status()
            .unwrap()
            .success()
    );
    loop {
        if host.child.try_wait().unwrap().is_some() {
            break;
        }
        assert!(
            began.elapsed() < Duration::from_secs(5),
            "the running reply and review kept the server up"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let host = host.restart();
    let snapshot = host.get("/api/snapshot");
    assert_eq!(snapshot["history"][1]["text"], "Partial browser reply");
    assert_eq!(snapshot["history"][1]["status"], "stopped");
    assert_eq!(
        host.invocations(),
        2,
        "shutdown and restart must not start another review"
    );
}

/// Whether a process with this id is still running.
fn running(pid: &str) -> bool {
    std::process::Command::new("kill")
        .args(["-0", pid])
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success()
}

#[test]
fn a_provider_turns_own_child_does_not_outlive_the_host() {
    let host = Host::start();
    let dir = host.dir.path();
    let program = dir.join("with-child.sh");
    let pid_file = dir.join("grandchild.pid");
    std::fs::write(
        &program,
        format!(
            "#!/bin/sh\nsleep 120 &\necho $! > {pid}.tmp\nmv {pid}.tmp {pid}\nwait\n",
            pid = pid_file.display()
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    host.set_programs(json!({"claudePath": program}));
    host.post("/api/chat/send", request("child"));
    let deadline = Instant::now() + Duration::from_secs(10);
    let grandchild = loop {
        if let Ok(pid) = std::fs::read_to_string(&pid_file) {
            break pid.trim().to_owned();
        }
        assert!(Instant::now() < deadline, "the provider did not start");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(running(&grandchild));

    let mut host = host;
    host.stop();
    let deadline = Instant::now() + Duration::from_secs(5);
    while running(&grandchild) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let left = running(&grandchild);
    if left {
        std::process::Command::new("kill")
            .args(["-KILL", &grandchild])
            .status()
            .unwrap();
    }
    assert!(
        !left,
        "the provider's own child kept running after the host stopped"
    );
}
