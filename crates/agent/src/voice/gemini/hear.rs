//! Hearing with Gemini: one request turns a clip of speech into words.

use super::Gemini;
use crate::voice::VoiceError;
use base64::Engine;
use serde_json::{Value, json};

const MOST_TRANSCRIPT_BYTES: u64 = 1 << 20;

impl Gemini {
    /// The words in a WAV clip, trimmed; empty when the clip holds no speech. `vocabulary` lists
    /// names that Google would otherwise spell wrongly.
    pub(in crate::voice) fn hear(
        &self,
        wav: &[u8],
        vocabulary: &[String],
    ) -> Result<String, VoiceError> {
        let body = json!({
            "model": self.model,
            "store": false,
            "stream": false,
            "input": [{
                "type": "audio",
                "data": base64::engine::general_purpose::STANDARD.encode(wav),
                "mime_type": "audio/wav",
            }],
            "generation_config": {"transcription_config": {
                "mode": "smart",
                "language_codes": [],
                "custom_vocabulary": vocabulary,
            }},
        });
        let mut response = self.post(&body)?;
        let answer = response
            .body_mut()
            .with_config()
            .limit(MOST_TRANSCRIPT_BYTES)
            .read_to_string()
            .map_err(|_| VoiceError::Http)?;
        self.read_transcript(&answer)
    }

    /// The text of every `text` item in every step of the answer, joined with spaces.
    fn read_transcript(&self, answer: &str) -> Result<String, VoiceError> {
        let answer: Value = serde_json::from_str(answer).map_err(|_| VoiceError::Decode)?;
        if let Some(error) = answer.get("error").filter(|error| error.is_object()) {
            return Err(self.refusal_from(error));
        }
        let steps = match answer["steps"].as_array() {
            Some(steps) => steps.as_slice(),
            // For a clip with no speech Google leaves `steps` out of a completed answer.
            None if answer["status"] == "completed" => &[],
            None => return Err(VoiceError::Decode),
        };
        let words: Vec<&str> = steps
            .iter()
            .filter_map(|step| step["content"].as_array())
            .flatten()
            .filter(|item| item["type"] == "text")
            .filter_map(|item| item["text"].as_str())
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .collect();
        Ok(words.join(" "))
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{KEY, server};
    use super::*;
    use base64::Engine;
    use serde_json::json;

    fn answer(items: serde_json::Value) -> String {
        json!({"steps": [{"type": "model_output", "content": items}]}).to_string()
    }

    #[test]
    fn a_clip_is_heard_as_words_without_leaking_the_key() {
        let body = json!({"steps": [
            {"type": "model_output", "content": [
                {"type": "text", "text": " What time is it "},
                {"type": "audio", "data": "ignored"},
            ]},
            {"type": "thought", "summary": []},
            {"type": "model_output", "content": [{"type": "text", "text": "in Lisbon? "}]},
        ]})
        .to_string();
        let (mut client, worker) = server(200, body);
        client.voice = None;
        let vocabulary = ["Jet".to_owned(), "Quanty".to_owned()];
        assert_eq!(
            client.hear(&[9, 8, 7], &vocabulary).unwrap(),
            "What time is it in Lisbon?"
        );
        let request = worker.join().unwrap();
        let (header, body) = request.split_once("\r\n\r\n").unwrap();
        assert!(
            header
                .to_ascii_lowercase()
                .contains(&format!("x-goog-api-key: {KEY}"))
        );
        let body: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(
            body,
            json!({
                "model": "model-test",
                "store": false,
                "stream": false,
                "input": [{
                    "type": "audio",
                    "data": base64::engine::general_purpose::STANDARD.encode([9, 8, 7]),
                    "mime_type": "audio/wav",
                }],
                "generation_config": {"transcription_config": {
                    "mode": "smart",
                    "language_codes": [],
                    "custom_vocabulary": ["Jet", "Quanty"],
                }},
            })
        );
        assert!(!format!("{client:?}").contains(KEY));

        let refusal =
            json!({"error": {"message": format!("API key {KEY} is not valid"), "code": 400}});
        for (status, body, expected) in [
            (200, answer(json!([])), Ok("")),
            (200, json!({"status": "completed"}).to_string(), Ok("")),
            (200, answer(json!([{"type": "text", "text": "  "}])), Ok("")),
            (200, "{}".into(), Err(VoiceError::Decode)),
            (200, "not json".into(), Err(VoiceError::Decode)),
            (429, refusal.to_string(), Err(VoiceError::RateLimited)),
            (
                400,
                refusal.to_string(),
                Err(VoiceError::Rejected {
                    status: 400,
                    message: "API key … is not valid".into(),
                }),
            ),
            (
                200,
                refusal.to_string(),
                Err(VoiceError::Rejected {
                    status: 400,
                    message: "API key … is not valid".into(),
                }),
            ),
        ] {
            let (mut client, worker) = server(status, body);
            client.voice = None;
            let result = client.hear(&[0, 0], &[]);
            assert_eq!(result, expected.map(str::to_owned));
            if let Err(error) = result {
                assert!(!format!("{error:?} {error}").contains(KEY));
            }
            worker.join().unwrap();
        }
    }
}
