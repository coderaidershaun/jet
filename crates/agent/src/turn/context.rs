//! Keep context measurements separate from the provider's aggregate billing counts.
use serde_json::Value;

use crate::chat::ContextStatus;

#[derive(Default)]
pub(super) struct ContextReader {
    model: String,
    latest: Option<u64>,
    streamed_usage: Value,
    measured: ContextStatus,
}

impl ContextReader {
    pub(super) fn read(&mut self, line: &str) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        match value["type"].as_str() {
            Some("system") if value["subtype"] == "init" => {
                self.model = value["model"].as_str().unwrap_or_default().to_owned();
            }
            Some("stream_event") => {
                let event = &value["event"];
                if event["type"] == "message_start" {
                    self.streamed_usage = event["message"]["usage"].clone();
                    self.latest = tokens(&self.streamed_usage);
                } else if event["type"] == "message_delta"
                    && let Some(output) = event["usage"]["output_tokens"].as_u64()
                    && self.streamed_usage.is_object()
                {
                    self.streamed_usage["output_tokens"] = output.into();
                    self.latest = tokens(&self.streamed_usage);
                }
            }
            Some("assistant") => {
                if let Some(tokens) = tokens(&value["message"]["usage"]) {
                    self.latest = Some(tokens);
                }
            }
            Some("result") => {
                let usage = &value["usage"];
                let last = usage["iterations"]
                    .as_array()
                    .and_then(|items| items.last())
                    .and_then(tokens);
                let direct = value["context"]["usedTokens"].as_u64();
                self.measured.used_tokens =
                    direct.or(last).or(self.latest).or_else(|| tokens(usage));
                self.measured.estimated =
                    direct.is_none() && last.is_none() && self.latest.is_none();
                self.measured.limit_tokens = value["context"]["limitTokens"]
                    .as_u64()
                    .or_else(|| value["modelUsage"][&self.model]["contextWindow"].as_u64())
                    .filter(|&limit| limit > 0);
            }
            _ => {}
        }
    }

    pub(super) fn finish(&self) -> ContextStatus {
        self.measured.clone()
    }
}

fn tokens(usage: &Value) -> Option<u64> {
    let input = usage["input_tokens"].as_u64()?;
    Some(
        input
            .saturating_add(usage["cache_read_input_tokens"].as_u64().unwrap_or(0))
            .saturating_add(usage["cache_creation_input_tokens"].as_u64().unwrap_or(0))
            .saturating_add(usage["output_tokens"].as_u64().unwrap_or(0)),
    )
}
