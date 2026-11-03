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
pub(super) struct Gemini {
    http: ureq::Agent,
    key: String,
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
    pub(super) fn new(key: String, model: String) -> Self {
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
            model,
            endpoint: ENDPOINT.into(),
        }
    }

    /// Sends one request and gives back the response, or Google's refusal when the status is not
    /// a success. A refusal hides the key and every word of `hidden`.
    fn post(
        &self,
        body: &Value,
        hidden: &[&str],
    ) -> Result<ureq::http::Response<ureq::Body>, VoiceError> {
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
        Err(self.refusal(status, &message, hidden))
    }

    /// The refusal that an `error` object of an answer or an event holds.
    fn refusal_from(&self, error: &Value, hidden: &[&str]) -> VoiceError {
        let status = error["code"]
            .as_u64()
            .and_then(|code| u16::try_from(code).ok())
            .unwrap_or(502);
        self.refusal(
            status,
            error["message"].as_str().unwrap_or_default(),
            hidden,
        )
    }

    /// Google's refusal as an error. Its message is cut short, and the key and the `hidden` words
    /// are taken out, because the message is shown on the page.
    fn refusal(&self, status: u16, message: &str, hidden: &[&str]) -> VoiceError {
        if status == 429 {
            return VoiceError::RateLimited;
        }
        let mut message = message.replace(&self.key, "\u{2026}");
        for word in hidden {
            message = message.replace(word, "\u{2026}");
        }
        let message = message.chars().take(MESSAGE_CHARACTERS).collect();
        VoiceError::Rejected { status, message }
    }
}

#[cfg(test)]
mod test_support {
    use super::*;

    pub(super) const KEY: &str = "test-credential-never-output";

    /// A client that talks to a one-request server answering with `status` and `body`, and the
    /// handle that hands back the request.
    pub(super) fn server(status: u16, body: &str) -> (Gemini, std::thread::JoinHandle<String>) {
        let (address, worker) = crate::test_server::serve(status, body);
        let mut client = Gemini::new(KEY.into(), "model-test".into());
        client.endpoint = format!("{address}/v1beta/interactions");
        (client, worker)
    }
}
