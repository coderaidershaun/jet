//! Speaking with Gemini: one streamed request turns words into a clip of speech.

use super::Gemini;
use crate::voice::{SAMPLE_RATE, VoiceError};
use base64::Engine;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader};

/// About five minutes of audio, far more than the longest piece the server accepts.
const MOST_PCM_BYTES: usize = SAMPLE_RATE as usize * 2 * 300;

impl Gemini {
    /// The words as raw 24 kHz PCM. Gemini streams the audio, and the clip is returned whole,
    /// because the page needs its exact length. A `style` such as "warm and bright" tells the
    /// voice how to say them.
    pub(in crate::voice) fn speak(
        &self,
        words: &str,
        style: Option<&str>,
    ) -> Result<Vec<u8>, VoiceError> {
        let mut text = json!({"type": "text", "text": words});
        if let Some(style) = style {
            text["annotations"] = json!([{"type": "speech_metadata", "style": style}]);
        }
        let body = json!({
            "model": self.model,
            "store": false,
            "stream": true,
            "input": [{"type": "user_input", "content": [text]}],
            "response_format": {"type": "audio"},
            "generation_config": {"speech_config": [{"voice": self.voice}]},
        });
        let mut response = self.post(&body)?;
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
            return Err(self.refusal_from(error));
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
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{KEY, server};
    use super::*;
    use base64::Engine;
    use serde_json::json;

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
        assert_eq!(
            client.speak("Hello there.", None).unwrap(),
            [1, 0, 2, 0, 3, 0]
        );
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

        // A style rides on the text as an annotation, and only when there is one.
        let (client, worker) = server(200, audio_event(&[1, 0]));
        client.speak("Hi.", Some("warm and bright")).unwrap();
        let request = worker.join().unwrap();
        let body: serde_json::Value =
            serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(
            body["input"][0]["content"][0],
            json!({"type": "text", "text": "Hi.", "annotations": [{"type": "speech_metadata", "style": "warm and bright"}]})
        );

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
            let error = client.speak("Hi.", None).unwrap_err();
            assert_eq!(error, expected);
            assert!(!format!("{error:?} {error}").contains(KEY));
            worker.join().unwrap();
        }
    }
}
