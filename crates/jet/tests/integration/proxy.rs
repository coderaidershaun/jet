//! Exercise registered forwarding through the real host and independent app servers.
use super::support::Host;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
};

struct Fixture {
    child: Child,
    url: String,
    stall: String,
}
impl Fixture {
    fn start(name: &str) -> Self {
        let mut child = Command::new("node")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/proxy.mjs"
            ))
            .env("FIXTURE_NAME", name)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let value: Value = serde_json::from_str(&line).unwrap();
        Self {
            child,
            url: value["url"].as_str().unwrap().into(),
            stall: value["stall"].as_str().unwrap().into(),
        }
    }
    fn register(&self, host: &Host) -> String {
        let (status, result) = host.post("/api/apps", json!({"action":"add","address":self.url}));
        assert_eq!(status, 200, "{result}");
        result["app"]["id"].as_str().unwrap().into()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn registered_http_proxy_preserves_streams_and_redirects() {
    let host = Host::start();
    let first = Fixture::start("First");
    let second = Fixture::start("Second");
    {
        use std::io::{Read, Write};
        let id = first.register(&host);
        let mut socket =
            std::net::TcpStream::connect(host.url.trim_start_matches("http://")).unwrap();
        socket
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        write!(socket,"POST /apps/{id}/upload HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nfirst\r\n").unwrap();
        let mut received = Vec::new();
        while !received.windows(5).any(|bytes| bytes == b"first") {
            let mut bytes = [0; 1024];
            let count = socket.read(&mut bytes).unwrap();
            assert!(count > 0);
            received.extend_from_slice(&bytes[..count]);
        }
        socket.write_all(b"4\r\nlast\r\n0\r\n\r\n").unwrap();
        socket.read_to_end(&mut received).unwrap();
        assert!(received.windows(4).any(|bytes| bytes == b"last"));
        host.post("/api/apps", json!({"action":"remove","id":id}));
    }

    for fixture in [&first, &second] {
        let id = fixture.register(&host);
        let observed = host.get(&format!("/apps/{id}/headers?q=a%20b&literal=%2520"));
        assert_eq!(observed["url"], "/notes/headers?q=a%20b&literal=%2520");
        assert_eq!(
            observed["name"],
            if fixture.url == first.url {
                "First"
            } else {
                "Second"
            }
        );
        let escaped = host.get(&format!("/apps/{id}/headers/file%20name%25-%2520"));
        assert_eq!(escaped["url"], "/notes/headers/file%20name%25-%2520");
        let status = host.get(&format!("/api/apps/{id}/ui-status"));
        assert_eq!(status["status"], "reachable");
        assert_eq!(status["httpStatus"], 405);
        let mut response = ureq::get(format!("{}/apps/{id}/binary", host.url))
            .call()
            .unwrap();
        assert_eq!(response.status(), 206);
        assert_eq!(response.headers().get_all("set-cookie").iter().count(), 2);
        assert!(response.headers().get("x-private").is_none());
        assert_eq!(
            response.body_mut().read_to_vec().unwrap(),
            [0, 1, 127, 128, 255]
        );
        let bytes = vec![157_u8; 1024 * 1024];
        let mut response = ureq::post(format!("{}/apps/{id}/upload", host.url))
            .send(bytes.as_slice())
            .unwrap();
        assert_eq!(response.status(), 201);
        assert_eq!(response.body_mut().read_to_vec().unwrap(), bytes);
        let client: ureq::Agent = ureq::Agent::config_builder()
            .max_redirects(0)
            .http_status_as_error(false)
            .build()
            .into();
        let response = client
            .get(format!("{}/apps/{id}/redirect", host.url))
            .call()
            .unwrap();
        assert_eq!(response.status(), 302);
        assert_eq!(
            response.headers()["location"],
            format!("/apps/{id}/headers?redirected=yes#part")
        );
    }
}

fn raw(host: &Host, path: &str, headers: &str) -> String {
    use std::io::{Read, Write};
    let mut socket = std::net::TcpStream::connect(host.url.trim_start_matches("http://")).unwrap();
    socket
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .unwrap();
    write!(
        socket,
        "GET {path} HTTP/1.1\r\nHost: forged.invalid\r\nConnection: close\r\n{headers}\r\n"
    )
    .unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).unwrap();
    response
}
#[test]
fn registered_proxy_rejects_unsafe_routes_and_origins() {
    let host = Host::start();
    let fixture = Fixture::start("Policy");
    let id = fixture.register(&host);
    for suffix in [
        "../headers",
        "%2e%2e/headers",
        "%252e%252e/headers",
        "a%2fb",
        "a%5cb",
        "a\\b",
        "%xy",
        "//evil.test",
        "https://evil.test",
    ] {
        let response = raw(&host, &format!("/apps/{id}/{suffix}"), "");
        assert!(response.starts_with("HTTP/1.1 400"), "{suffix}: {response}");
    }
    for origin in ["null", "http://evil.test", "http://localhost:1"] {
        assert!(
            raw(
                &host,
                &format!("/apps/{id}/headers"),
                &format!("Origin: {origin}\r\n")
            )
            .starts_with("HTTP/1.1 403")
        );
    }
    assert!(
        raw(
            &host,
            &format!("/apps/{id}/headers"),
            &format!("Origin: {}\r\nOrigin: {}\r\n", host.url, host.url)
        )
        .starts_with("HTTP/1.1 403")
    );
    let response = raw(
        &host,
        &format!("/apps/{id}/headers"),
        &format!(
            "Origin: {}\r\nForwarded: evil\r\nX-Forwarded-For: evil\r\nX-Forwarded-Host: evil\r\nX-Forwarded-Custom: evil\r\n",
            host.url
        ),
    );
    let body = response.split("\r\n\r\n").nth(1).unwrap();
    // The response can be chunked; inspect only values that the upstream returned.
    assert!(body.contains(&format!(
        "\"origin\":\"{}\"",
        fixture.url.trim_end_matches("/notes/")
    )));
    assert!(!body.contains("evil"));
    assert!(body.contains(&format!("\"x-forwarded-prefix\":\"/apps/{id}\"")));
    let client: ureq::Agent = ureq::Agent::config_builder()
        .max_redirects(0)
        .http_status_as_error(false)
        .build()
        .into();
    for location in ["https://outside.test/", "/notes-other/", host.url.as_str()] {
        let url = format!(
            "{}/apps/{id}/redirect?to={}",
            host.url,
            url::form_urlencoded::byte_serialize(location.as_bytes()).collect::<String>()
        );
        assert_eq!(client.get(url).call().unwrap().status(), 502);
    }
    let response = client
        .get(format!("{}/apps/{id}/binary", host.url))
        .call()
        .unwrap();
    assert_eq!(response.headers()["x-frame-options"], "SAMEORIGIN");
    assert_eq!(
        response.headers()["content-security-policy"],
        "frame-ancestors 'self'"
    );
    // WebSocket upgrades pass the same checks and keep their frames.
    let sockets = Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/socket-check.mjs"
        ))
        .args([&host.url, &id, &fixture.url])
        .output()
        .unwrap();
    assert!(
        sockets.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&sockets.stdout),
        String::from_utf8_lossy(&sockets.stderr)
    );
    host.post("/api/apps", json!({"action":"disable","id":id}));
    assert_eq!(host.get(&format!("/apps/{id}/headers"))["name"], "Policy");
    host.post("/api/apps", json!({"action":"remove","id":id}));
    assert!(raw(&host, &format!("/apps/{id}/headers"), "").starts_with("HTTP/1.1 404"));
    for address in [host.url.clone(), host.url.replace("127.0.0.1", "localhost")] {
        let (_, result) = host.post("/api/apps", json!({"action":"add","address":address}));
        let recursive = result["app"]["id"].as_str().unwrap();
        assert!(
            raw(&host, &format!("/apps/{recursive}/api/status"), "").starts_with("HTTP/1.1 400")
        );
    }
    let (_, result) = host.post("/api/apps", json!({"action":"add","address":fixture.stall}));
    let stalled = result["app"]["id"].as_str().unwrap();
    let started = std::time::Instant::now();
    assert!(raw(&host, &format!("/apps/{stalled}/"), "").starts_with("HTTP/1.1 502"));
    assert!(started.elapsed() < std::time::Duration::from_secs(4));
    let output = Command::new(env!("CARGO_BIN_EXE_jet"))
        .args(["--listen", "0.0.0.0:0", "--data-dir"])
        .arg(host.dir.path().join("wildcard"))
        .arg("--disable-feelings")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("--public-origin"));
    assert!(jet::ServerConfig::from_args(["--public-origin", "file:///tmp"]).is_err());
}
