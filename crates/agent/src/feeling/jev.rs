//! Keeps the JEV wire format and credential handling out of the conversation.

use super::{Feeling, JevError, QUESTIONS};
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;
use std::fmt;
use std::time::Duration;

const ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
const MODEL: &str = "jev-1.13.0";
const TIMEOUT: Duration = Duration::from_secs(2);

/// One bounded request per classification, with no retries or redirects.
pub struct Jev {
    http: ureq::Agent,
    key: String,
    endpoint: String,
}

// Do not derive Debug: credentials must never appear in logs.
impl fmt::Debug for Jev {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Jev").finish_non_exhaustive()
    }
}

impl Jev {
    pub fn new(key: String) -> Self {
        Self {
            http: ureq::Agent::config_builder()
                .timeout_global(Some(TIMEOUT))
                .max_redirects(0)
                .http_status_as_error(false)
                .build()
                .into(),
            key,
            endpoint: ENDPOINT.into(),
        }
    }
    /// Asks JEV how the message makes Jet feel.
    /// # Errors
    /// Returns a safe request or decoding error when JEV is unavailable.
    pub fn classify(&self, text: &str) -> Result<Feeling, JevError> {
        let questions: serde_json::Map<_, _> = QUESTIONS
            .into_iter()
            .map(|(mood, question)| {
                (
                    mood.word().into(),
                    json!({"type": "noul", "instructions": {"line": text, "question": question}}),
                )
            })
            .collect();
        let body = json!({"state": {}, "model": MODEL, "questions": questions});
        let mut response = self
            .http
            .post(&self.endpoint)
            .header("Authorization", format!("Bearer {}", self.key))
            .header("Content-Type", "application/json")
            .send(body.to_string())
            .map_err(|_| JevError::Http)?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(JevError::Rejected { status });
        }
        let body = response
            .body_mut()
            .read_to_string()
            .map_err(|_| JevError::Http)?;
        let decoded: Response = serde_json::from_str(&body).map_err(|_| JevError::Decode)?;
        if QUESTIONS
            .iter()
            .any(|(mood, _)| !decoded.answers.contains_key(mood.word()))
        {
            return Err(JevError::Decode);
        }
        Ok(Feeling::from_scores(
            decoded
                .answers
                .into_iter()
                .map(|(word, answer)| (word, answer.noul))
                .collect(),
        ))
    }
}

#[derive(Deserialize)]
struct Response {
    answers: BTreeMap<String, Answer>,
}
#[derive(Deserialize)]
struct Answer {
    noul: f64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Mood;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn server(
        status: u16,
        body: &'static str,
        pause: Duration,
    ) -> (Jev, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = Jev::new("test-credential-never-output".into());
        client.endpoint = format!("http://{}/systemone", listener.local_addr().unwrap());
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
            std::thread::sleep(pause);
            let response = format!(
                "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            // A timed-out client has already closed its socket.
            stream.write_all(response.as_bytes()).ok();
            listener.set_nonblocking(true).unwrap();
            assert!(
                listener.accept().is_err(),
                "classification made more than one request"
            );
            String::from_utf8(request).unwrap()
        });
        (client, worker)
    }

    #[test]
    fn jev_sends_questions_and_decodes_only_complete_answers_with_safe_errors() {
        let (client, worker) = server(
            200,
            r#"{"answers":{"hello":{"noul":0.8},"insulted":{"noul":0.1}}}"#,
            Duration::ZERO,
        );
        assert_eq!(client.classify("hello\nworld").unwrap().mood, Mood::Hello);
        let request = worker.join().unwrap();
        let (header, body) = request.split_once("\r\n\r\n").unwrap();
        assert!(header.starts_with("POST /systemone HTTP/1.1"));
        assert!(
            header
                .to_ascii_lowercase()
                .contains("authorization: bearer test-credential-never-output")
        );
        let body: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["model"], MODEL);
        assert_eq!(body["state"], json!({}));
        assert_eq!(body["questions"].as_object().unwrap().len(), 2);
        for (mood, question) in QUESTIONS {
            assert_eq!(
                body["questions"][mood.word()],
                json!({"type":"noul","instructions":{"line":"hello\nworld","question":question}})
            );
        }
        assert!(!format!("{client:?}").contains("test-credential"));
        for (status, body, expected) in [
            (
                200,
                "not-json test-credential-never-output",
                JevError::Decode,
            ),
            (
                200,
                r#"{"answers":{"hello":{"noul":0.8}}}"#,
                JevError::Decode,
            ),
            (
                200,
                r#"{"answers":{"hello":{"noul":"bad"},"insulted":{"noul":0}}}"#,
                JevError::Decode,
            ),
            (
                401,
                "test-credential-never-output",
                JevError::Rejected { status: 401 },
            ),
            (
                503,
                "test-credential-never-output",
                JevError::Rejected { status: 503 },
            ),
        ] {
            let (client, worker) = server(status, body, Duration::ZERO);
            let error = client.classify("hi").unwrap_err();
            assert_eq!(error, expected);
            assert!(!format!("{error:?} {error}").contains("test-credential"));
            worker.join().unwrap();
        }
    }

    #[test]
    fn jev_times_out_after_two_seconds_without_retrying() {
        let (client, worker) = server(200, "{}", Duration::from_millis(2200));
        let start = std::time::Instant::now();
        assert_eq!(client.classify("hi"), Err(JevError::Http));
        assert!(start.elapsed() >= Duration::from_millis(1800));
        assert!(start.elapsed() < Duration::from_secs(3));
        worker.join().unwrap();
    }
}
