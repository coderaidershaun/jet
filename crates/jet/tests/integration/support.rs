//! Run the actual host binary with a free provider stand-in and an isolated data directory.
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

/// Longest a request to the host may take before the test fails instead of hanging.
const REQUEST_LIMIT: Duration = Duration::from_secs(30);

pub const OWNER: &str = "shaunsurfing@gmail.com";
pub const PASSWORD: &str = "000111";

pub struct Host {
    pub child: Child,
    pub url: String,
    pub dir: tempfile::TempDir,
    /// The `Cookie` header of the owner's sign-in, made when the host starts.
    pub cookie: String,
    /// The origin Jet's page has: the public origin when one is given, else `url`.
    pub origin: String,
}
impl Host {
    pub fn start() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("provider.py");
        std::fs::write(&program, include_str!("provider.py")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        std::fs::write(
            dir.path().join("settings.json"),
            json!({"model":"sonnet","claudePath":program}).to_string(),
        )
        .unwrap();
        Self::launch(dir)
    }
    fn launch(dir: tempfile::TempDir) -> Self {
        Self::launch_with(dir, &[])
    }
    /// Starts the host with extra flags and signs the owner in.
    pub fn launch_with(dir: tempfile::TempDir, flags: &[&str]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_jet"))
            .args(["--listen", "127.0.0.1:0", "--data-dir"])
            .arg(dir.path())
            .arg("--disable-feelings")
            .arg("--disable-voice")
            .args(flags)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert!(
            line.starts_with("Jet listening on "),
            "server did not start: {line}"
        );
        let url: String = line
            .trim()
            .strip_prefix("Jet listening on ")
            .unwrap()
            .into();
        let origin = flags
            .iter()
            .position(|flag| *flag == "--public-origin")
            .map_or(url.clone(), |at| flags[at + 1].to_owned());
        let response = sign_in(&url, &origin, OWNER, PASSWORD);
        assert_eq!(response.status(), 200, "the owner could not sign in");
        Self {
            child,
            cookie: cookie_header(&response),
            origin,
            url,
            dir,
        }
    }
    /// Adds the owner's sign-in to a request, with the `Origin` that a request from Jet's page has.
    pub fn signed<B>(&self, request: ureq::RequestBuilder<B>) -> ureq::RequestBuilder<B> {
        request
            .header("cookie", &self.cookie)
            .header("origin", &self.origin)
    }
    /// The same headers as `signed`, for a request written straight to a socket.
    pub fn signed_lines(&self) -> String {
        format!("Cookie: {}\r\nOrigin: {}\r\n", self.cookie, self.origin)
    }
    pub fn restart(mut self) -> Self {
        self.child.kill().unwrap();
        self.child.wait().unwrap();
        let dir = std::mem::replace(&mut self.dir, tempfile::tempdir().unwrap());
        Self::launch(dir)
    }
    pub fn get(&self, path: &str) -> Value {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(REQUEST_LIMIT))
            .build()
            .into();
        let text = self
            .signed(agent.get(format!("{}{path}", self.url)))
            .call()
            .unwrap()
            .body_mut()
            .read_to_string()
            .unwrap();
        serde_json::from_str(&text).unwrap()
    }
    pub fn post(&self, path: &str, value: Value) -> (u16, Value) {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(REQUEST_LIMIT))
            .build()
            .into();
        let mut response = self
            .signed(agent.post(format!("{}{path}", self.url)))
            .header("content-type", "application/json")
            .send(value.to_string())
            .unwrap();
        let status = response.status().as_u16();
        (
            status,
            serde_json::from_str(&response.body_mut().read_to_string().unwrap()).unwrap(),
        )
    }
    /// Posts raw bytes, the way the page posts a clip of audio.
    pub fn post_bytes(&self, path: &str, bytes: &[u8]) -> (u16, Value) {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(REQUEST_LIMIT))
            .build()
            .into();
        let mut response = self
            .signed(agent.post(format!("{}{path}", self.url)))
            .header("content-type", "audio/L16;rate=16000;channels=1")
            .send(bytes)
            .unwrap();
        let status = response.status().as_u16();
        (
            status,
            serde_json::from_str(&response.body_mut().read_to_string().unwrap()).unwrap(),
        )
    }
    /// Uploads a file as the raw request body, the way the page does. The name travels in the
    /// query, percent-encoded.
    pub fn upload(&self, name: &str, bytes: &[u8]) -> (u16, Value) {
        let name: String = url::form_urlencoded::byte_serialize(name.as_bytes()).collect();
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(REQUEST_LIMIT))
            .build()
            .into();
        let mut response = self
            .signed(agent.post(format!("{}/api/files?name={name}", self.url)))
            .header("content-type", "application/octet-stream")
            .send(bytes)
            .unwrap();
        let status = response.status().as_u16();
        (
            status,
            serde_json::from_str(&response.body_mut().read_to_string().unwrap()).unwrap(),
        )
    }
    pub fn delete(&self, path: &str) -> u16 {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(REQUEST_LIMIT))
            .build()
            .into();
        self.signed(agent.delete(format!("{}{path}", self.url)))
            .call()
            .unwrap()
            .status()
            .as_u16()
    }
    pub fn until(&self, condition: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            let snapshot = self.get("/api/snapshot");
            if condition(&snapshot) {
                return snapshot;
            }
            assert!(Instant::now() < deadline, "snapshot timed out: {snapshot}");
            std::thread::sleep(Duration::from_millis(15));
        }
    }
    pub fn send_without_ack(&self, request: &Value) -> std::net::TcpStream {
        let mut socket =
            std::net::TcpStream::connect(self.url.trim_start_matches("http://")).unwrap();
        let body = request.to_string();
        write!(socket, "POST /api/chat/send HTTP/1.1\r\nHost: {}\r\n{}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", self.url.trim_start_matches("http://"), self.signed_lines(), body.len()).unwrap();
        socket
    }
    /// Opens the event stream. A read that stalls fails the test instead of hanging it.
    pub fn events(&self, epoch: &str, cursor: u64) -> ureq::http::Response<ureq::Body> {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(REQUEST_LIMIT))
            .build()
            .into();
        self.signed(agent.get(format!(
            "{}/api/events?epoch={epoch}&cursor={cursor}",
            self.url
        )))
        .call()
        .unwrap()
    }
    pub fn invocations(&self) -> usize {
        std::fs::read_to_string(self.dir.path().join("calls"))
            .unwrap_or_default()
            .lines()
            .count()
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Posts a sign-in with the given `Origin` and returns the whole answer, cookies included.
pub fn sign_in(
    url: &str,
    origin: &str,
    email: &str,
    password: &str,
) -> ureq::http::Response<ureq::Body> {
    agent()
        .post(format!("{url}/api/auth/signin"))
        .header("origin", origin)
        .header("content-type", "application/json")
        .send(json!({"email": email, "password": password}).to_string())
        .unwrap()
}
/// A client that reports every status instead of failing, and follows no redirect.
pub fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .timeout_global(Some(REQUEST_LIMIT))
        .build()
        .into()
}
/// The `Cookie` header a browser would send after this answer.
pub fn cookie_header<B>(response: &ureq::http::Response<B>) -> String {
    response
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|value| value.to_str().ok()?.split(';').next())
        .collect::<Vec<_>>()
        .join("; ")
}

pub fn host() -> Host {
    let host = Host::start();
    let bins = std::path::Path::new(env!("CARGO_BIN_EXE_jet"))
        .parent()
        .unwrap();
    let (claude, codex) = (bins.join("fake-claude"), bins.join("fake-codex"));
    for fake in [&claude, &codex] {
        assert!(
            fake.exists(),
            "{} is missing; run `cargo build --workspace` before these tests",
            fake.display()
        );
    }
    std::fs::write(
        host.dir.path().join("settings.json"),
        json!({"claudePath":claude,"codexPath":codex}).to_string(),
    )
    .unwrap();
    host
}
pub fn send(host: &Host, id: &str, model: &str, script: Value, active: Value) -> Value {
    let mut req = request(id);
    req["model"] = json!(model);
    req["text"] = json!(format!("facade:{script}"));
    req["activeAppId"] = active;
    let (status, value) = host.post("/api/chat/send", req);
    assert_eq!(status, 200, "{value}");
    value
}
pub fn wait_file(host: &Host, name: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if let Ok(text) = std::fs::read_to_string(host.dir.path().join(name))
            && let Ok(value) = serde_json::from_str(&text)
        {
            return value;
        }
        assert!(Instant::now() < deadline, "missing {name}");
        std::thread::sleep(Duration::from_millis(10));
    }
}
pub fn request(id: &str) -> Value {
    json!({"requestId":id,"clientId":"browser-a","text":"hang","model":"sonnet","effort":"medium","budgetUsd":1.0,"persona":{"name":"Jet","jobTitle":"First mate","notes":""},"localTime":"Friday","feeling":"neutral"})
}
pub fn replay(host: &Host) -> Vec<Value> {
    let snapshot = host.get("/api/snapshot");
    let last = snapshot["cursor"].as_u64().unwrap();
    if last == 0 {
        return Vec::new();
    }
    let mut response = host.events(snapshot["epoch"].as_str().unwrap(), 0);
    let mut reader = BufReader::new(response.body_mut().as_reader());
    let mut events = Vec::new();
    loop {
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .expect("the event stream stalled");
        assert!(read > 0, "the event stream ended before cursor {last}");
        if let Some(data) = line.strip_prefix("data: ") {
            let event: Value = serde_json::from_str(data).unwrap();
            if event["kind"] == "event" {
                events.push(event["data"]["event"].clone());
                if event["data"]["cursor"].as_u64() == Some(last) {
                    break;
                }
            }
        }
    }
    events
}
