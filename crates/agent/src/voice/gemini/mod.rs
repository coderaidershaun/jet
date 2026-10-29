//! The one Gemini client that speaking and hearing share, so that both send requests the same way
//! and both keep the key out of every message and every `Debug` print.

mod hear;
mod speak;

use super::VoiceError;
use serde_json::Value;
use std::fmt;
use std::time::Duration;

const ENDPOINT: &str = "https://generativelanguage.googleapis.com/v1beta/interactions";
const TIMEOUT: Duration = Duration::from_secs(20);
const MESSAGE_CHARACTERS: usize = 200;
const ERROR_BODY_BYTES: u64 = 4096;

/// One request makes one clip or one transcript, with no retries or redirects.
// SMELL: speaking and hearing share this client, so a hearing client carries an empty voice.
pub(super) struct Gemini {
    http: ureq::Agent,
    key: String,
    voice: Option<String>,
    model: String,
    endpoint: String,
}

// Do not derive Debug: credentials must never appear in logs.
impl fmt::Debug for Gemini {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Gemini").finish_non_exhaustive()
    }
}

impl Gemini {
    /// A client that speaks with `voice`.
    pub(super) fn new(key: String, voice: String, model: String) -> Self {
        Self::build(key, Some(voice), model)
    }

    /// A client that turns clips into words.
    pub(super) fn hearing(key: String, model: String) -> Self {
        Self::build(key, None, model)
    }

    fn build(key: String, voice: Option<String>, model: String) -> Self {
        Self {
            http: ureq::Agent::config_builder()
                // From some hosts Google refuses IPv6 callers with "User location is not
                // supported", while the same host is accepted over IPv4.
                .ip_family(ureq::config::IpFamily::Ipv4Only)
                .timeout_global(Some(TIMEOUT))
                .max_redirects(0)
                .http_status_as_error(false)
                .build()
                .into(),
            key,
            voice,
            model,
            endpoint: ENDPOINT.into(),
        }
    }

    /// Sends one request and gives back the response, or Google's refusal when the status is not
    /// a success.
    fn post(&self, body: &Value) -> Result<ureq::http::Response<ureq::Body>, VoiceError> {
        let mut response = self
            .http
            .post(&self.endpoint)
            .header("x-goog-api-key", &self.key)
            .header("Content-Type", "application/json")
            .send(body.to_string())
            .map_err(|_| VoiceError::Http)?;
        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(response);
        }
        let text = response
            .body_mut()
            .with_config()
            .limit(ERROR_BODY_BYTES)
            .read_to_string()
            .unwrap_or_default();
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|body| body["error"]["message"].as_str().map(str::to_owned))
            .unwrap_or_default();
        Err(self.refusal(status, &message))
    }

    /// The refusal that an `error` object of an answer or an event holds.
    fn refusal_from(&self, error: &Value) -> VoiceError {
        let status = error["code"]
            .as_u64()
            .and_then(|code| u16::try_from(code).ok())
            .unwrap_or(502);
        self.refusal(status, error["message"].as_str().unwrap_or_default())
    }

    /// Google's refusal as an error. Its message is cut short, and the key and the voice are taken
    /// out, because the message is shown on the page.
    fn refusal(&self, status: u16, message: &str) -> VoiceError {
        if status == 429 {
            return VoiceError::RateLimited;
        }
        let mut message = message.replace(&self.key, "\u{2026}");
        if let Some(voice) = &self.voice {
            message = message.replace(voice, "\u{2026}");
        }
        let message = message.chars().take(MESSAGE_CHARACTERS).collect();
        VoiceError::Rejected { status, message }
    }
}

#[cfg(test)]
mod test_support {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    pub(super) const KEY: &str = "test-credential-never-output";

    /// A one-request server that answers with `status` and `body` and hands back the request.
    pub(super) fn server(status: u16, body: String) -> (Gemini, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = Gemini::new(KEY.into(), "voice_test".into(), "model-test".into());
        client.endpoint = format!(
            "http://{}/v1beta/interactions",
            listener.local_addr().unwrap()
        );
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let count = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..count]);
                if let Some(at) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&request[..at]).to_ascii_lowercase();
                    let length: usize = header
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .unwrap()
                        .parse()
                        .unwrap();
                    if request.len() >= at + 4 + length {
                        break;
                    }
                }
                assert_ne!(count, 0);
            }
            let response = format!(
                "HTTP/1.1 {status} Test\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{body}"
            );
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8(request).unwrap()
        });
        (client, worker)
    }
}
