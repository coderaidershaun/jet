use super::support::{Host, request};
use std::time::{Duration, Instant};

#[test]
fn shutdown_bounds_provider_and_review_cleanup() {
    let mut host = Host::start();
    host.post("/api/chat/send", request("shutdown"));
    host.until(|snapshot| snapshot["active"]["text"] == "Partial browser reply");
    host.post(
        "/api/chat/stop",
        serde_json::json!({"requestId":"shutdown"}),
    );
    host.until(|snapshot| snapshot["active"].is_null());
    let sleeper = host.dir.path().join("no-read.py");
    std::fs::write(
        &sleeper,
        "#!/usr/bin/env python3\nimport time\ntime.sleep(120)\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&sleeper, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let mut settings = host.get("/api/settings");
    settings["claudePath"] = sleeper.to_str().unwrap().into();
    ureq::put(format!("{}/api/settings", host.url))
        .header("content-type", "application/json")
        .send(settings.to_string())
        .unwrap();
    let mut blocked = request("no-stdin-reader");
    blocked["text"] = "x".repeat(100_000).into();
    let client: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(3)))
        .build()
        .into();
    let response = client
        .post(format!("{}/api/chat/send", host.url))
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
        assert!(began.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(20));
    }
    let host = host.restart();
    let snapshot = host.get("/api/snapshot");
    assert_eq!(snapshot["history"][1]["text"], "Partial browser reply");
    assert_eq!(snapshot["history"][1]["status"], "stopped");
    assert_eq!(
        host.invocations(),
        1,
        "shutdown must not start an unbounded exit review"
    );
    let conversation = agent::Conversation::new(agent::DataDir::new(host.dir.path()));
    let review = conversation.clone();
    let transport = agent::ClaudeCli::at(
        host.dir.path().join("provider.py"),
        host.dir.path().to_path_buf(),
    );
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || sender.send(review.review_notes(&transport, "Jet")).unwrap());
    let deadline = Instant::now() + Duration::from_secs(3);
    while host.invocations() < 2 {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    conversation.stop_review();
    assert!(
        receiver
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .is_err()
    );
    assert_eq!(
        conversation
            .review_notes(
                &agent::ClaudeCli::at(
                    host.dir.path().join("provider.py"),
                    host.dir.path().to_path_buf()
                ),
                "Jet"
            )
            .unwrap(),
        agent::ReviewOutcome::Skipped
    );
    assert_eq!(host.invocations(), 2);
}
