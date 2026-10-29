//! The Gemini wire format: one streamed request for a clip of speech, and the key kept out of
//! every message and every `Debug` print.

use super::{SAMPLE_RATE, VoiceError};
use base64::Engine;
use serde_json::{Value, json};
use std::fmt;
use std::io::{BufRead, BufReader};
use std::time::Duration;

const ENDPOINT: &str = "https://generativelanguage.googleapis.com/v1beta/interactions";
const TIMEOUT: Duration = Duration::from_secs(20);
const MESSAGE_CHARACTERS: usize = 200;
const ERROR_BODY_BYTES: u64 = 4096;
/// About five minutes of audio, far more than the longest piece the server accepts.
const MOST_PCM_BYTES: usize = SAMPLE_RATE as usize * 2 * 300;

/// One request makes one clip, with no retries or redirects.
pub(super) struct Gemini {
    http: ureq::Agent,
    key: String,
    voice: String,
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
    pub(super) fn new(key: String, voice: String, model: String) -> Self {
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

    /// The words as raw 24 kHz PCM. Gemini streams the audio, and the clip is returned whole,
    /// because the page needs its exact length.
    pub(super) fn speak(&self, words: &str) -> Result<Vec<u8>, VoiceError> {
        let body = json!({
            "model": self.model,
            "store": false,
            "stream": true,
            "input": [{"type": "user_input", "content": [{"type": "text", "text": words}]}],
            "response_format": {"type": "audio"},
            "generation_config": {"speech_config": [{"voice": self.voice}]},
        });
        let mut response = self
            .http
            .post(&self.endpoint)
            .header("x-goog-api-key", &self.key)
            .header("Content-Type", "application/json")
            .send(body.to_string())
            .map_err(|_| VoiceError::Http)?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
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
            return Err(self.refusal(status, &message));
        }
        self.read_audio(BufReader::new(response.body_mut().as_reader()))
    }

    /// The audio of every event in the stream, joined. One event may spread its data over
    /// several `data:` lines, so the lines are gathered until the blank line that ends it.
    fn read_audio(&self, stream: impl BufRead) -> Result<Vec<u8>, VoiceError> {
        let mut pcm = Vec::new();
        let mut data = String::new();
        for line in stream.lines() {
            let line = line.map_err(|_| VoiceError::Http)?;
            if let Some(more) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(more);
            } else if line.is_empty() {
                self.add_event(&std::mem::take(&mut data), &mut pcm)?;
            }
        }
        self.add_event(&data, &mut pcm)?;
        pcm.truncate(pcm.len() & !1);
        if pcm.is_empty() {
            return Err(VoiceError::Decode);
        }
        Ok(pcm)
    }

    /// Adds the audio of one event to `pcm`. An error event ends the clip as a refusal, and an
    /// event that is not audio is passed over.
    fn add_event(&self, data: &str, pcm: &mut Vec<u8>) -> Result<(), VoiceError> {
        let Ok(event) = serde_json::from_str::<Value>(data) else {
            return Ok(());
        };
        if let Some(error) = event.get("error").filter(|error| error.is_object()) {
            let status = error["code"]
                .as_u64()
                .and_then(|code| u16::try_from(code).ok())
                .unwrap_or(502);
            return Err(self.refusal(status, error["message"].as_str().unwrap_or_default()));
        }
        let Some(delta) = event.get("delta").filter(|delta| delta["type"] == "audio") else {
            return Ok(());
        };
        if delta
            .get("sample_rate")
            .is_some_and(|rate| *rate != SAMPLE_RATE)
        {
            return Err(VoiceError::Decode);
        }
        let chunk = delta["data"]
            .as_str()
            .and_then(|data| base64::engine::general_purpose::STANDARD.decode(data).ok())
            .ok_or(VoiceError::Decode)?;
        pcm.extend_from_slice(&chunk);
        if pcm.len() > MOST_PCM_BYTES {
            return Err(VoiceError::Decode);
        }
        Ok(())
    }

    /// Google's refusal as an error. Its message is cut short, and the key and the voice are taken
    /// out, because the message is shown on the page.
    fn refusal(&self, status: u16, message: &str) -> VoiceError {
        if status == 429 {
            return VoiceError::RateLimited;
        }
        let message = message
            .replace(&self.key, "\u{2026}")
            .replace(&self.voice, "\u{2026}")
            .chars()
            .take(MESSAGE_CHARACTERS)
            .collect();
        VoiceError::Rejected { status, message }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    const KEY: &str = "test-credential-never-output";

    /// A one-request server that answers with `status` and `body` and hands back the request.
    fn server(status: u16, body: String) -> (Gemini, std::thread::JoinHandle<String>) {
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

    fn audio_event(bytes: &[u8]) -> String {
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        let delta = json!({"delta": {"type": "audio", "mime_type": "audio/l16", "sample_rate": 24000, "channels": 1, "data": data}});
        format!("event: step.delta\ndata: {delta}\n\n")
    }

    #[test]
    fn speech_is_streamed_from_gemini_without_leaking_the_key() {
        // The last audio event ends its lines with CRLF and spreads its data over two lines.
        let split = audio_event(&[3, 0])
            .replace(",\"data\"", ",\ndata: \"data\"")
            .replace('\n', "\r\n");
        assert_eq!(split.matches("\r\ndata:").count(), 2);
        let body = format!(
            "event: step.start\ndata: {{}}\n\n{}{split}event: done\ndata: {{}}\n\n",
            audio_event(&[1, 0, 2, 0]),
        );
        let (client, worker) = server(200, body);
        assert_eq!(client.speak("Hello there.").unwrap(), [1, 0, 2, 0, 3, 0]);
        let request = worker.join().unwrap();
        let (header, body) = request.split_once("\r\n\r\n").unwrap();
        assert!(header.starts_with("POST /v1beta/interactions HTTP/1.1"));
        assert!(
            header
                .to_ascii_lowercase()
                .contains(&format!("x-goog-api-key: {KEY}"))
        );
        let body: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["model"], "model-test");
        assert_eq!(body["store"], false);
        assert_eq!(body["stream"], true);
        assert_eq!(body["response_format"], json!({"type": "audio"}));
        assert_eq!(
            body["generation_config"]["speech_config"],
            json!([{"voice": "voice_test"}])
        );
        assert_eq!(
            body["input"],
            json!([{"type": "user_input", "content": [{"type": "text", "text": "Hello there."}]}])
        );
        assert!(!format!("{client:?}").contains(KEY));

        let error_event = format!(
            "event: error\ndata: {}\n\n",
            json!({"error": {"message": format!("quota for {KEY} and voice_test is gone"), "code": 500}})
        );
        let refusal =
            json!({"error": {"message": format!("API key {KEY} is not valid"), "code": 400}});
        for (status, body, expected) in [
            (
                200,
                format!("{}{error_event}", audio_event(&[1, 0])),
                VoiceError::Rejected {
                    status: 500,
                    message: "quota for … and … is gone".into(),
                },
            ),
            (
                400,
                refusal.to_string(),
                VoiceError::Rejected {
                    status: 400,
                    message: "API key … is not valid".into(),
                },
            ),
            (429, refusal.to_string(), VoiceError::RateLimited),
            (
                503,
                "not json".into(),
                VoiceError::Rejected {
                    status: 503,
                    message: String::new(),
                },
            ),
            (200, "event: done\ndata: {}\n\n".into(), VoiceError::Decode),
            (
                200,
                audio_event(&[1, 0]).replace("24000", "16000"),
                VoiceError::Decode,
            ),
        ] {
            let (client, worker) = server(status, body);
            let error = client.speak("Hi.").unwrap_err();
            assert_eq!(error, expected);
            assert!(!format!("{error:?} {error}").contains(KEY));
            worker.join().unwrap();
        }
    }
}
