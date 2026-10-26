//! What a streamed reply sends to the chat page, one step at a time, and why a reply failed.
//! The page reads these names, so change them together with the page.

use serde::Serialize;

use super::{Mood, ShownEntry, ToolCall, ToolStart};

/// Why a reply failed. The message is written for the user and shown as it stands.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Failure {
    ClaudeMissing { message: String },
    ProviderFailed { message: String },
    Timeout { message: String },
    Io { message: String },
}

impl Failure {
    pub fn message(&self) -> &str {
        match self {
            Failure::ClaudeMissing { message }
            | Failure::ProviderFailed { message }
            | Failure::Timeout { message }
            | Failure::Io { message } => message,
        }
    }
}

/// One step of a streamed reply. Exactly one of `Finished`, `Failed` and `Stopped` ends it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    Started {
        fresh: bool,
    },
    /// At most once, before the first `Text`.
    Mood {
        mood: Mood,
    },
    /// Reply text with the mood line already removed.
    Text {
        delta: String,
    },
    /// The model called a library tool; it is running now. A call still running when the reply
    /// ends gets no `ToolFinished`, and the saved entry keeps only finished calls.
    ToolStarted(ToolStart),
    /// The call with the same `id` came back.
    ToolFinished(ToolCall),
    /// A fresh conversation began for a reason the user should hear about.
    Notice {
        message: String,
    },
    Finished {
        entry: ShownEntry,
    },
    Failed {
        failure: Failure,
        entry: ShownEntry,
    },
    Stopped {
        entry: ShownEntry,
    },
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::chat::{Entry, EntryId, EntryStatus, Role};

    fn jet_entry(id: u64, status: EntryStatus) -> ShownEntry {
        let entry = Entry {
            turn: None,
            id: EntryId(id),
            role: Role::Jet,
            text: "Friday looks fine".into(),
            mood: None,
            status,
            error: None,
            tools: Vec::new(),
            at: 1_760_433_360_000,
        };
        let html = "<p>Friday looks fine</p>".into();
        ShownEntry { entry, html }
    }

    fn quanty_search() -> ToolCall {
        ToolCall {
            id: "toolu_1".into(),
            server: "quanty".into(),
            tool: "search".into(),
            input: json!({"question": "What is vega?"}),
            ok: true,
            result: json!({"results": [1, 2]}),
            summary: "quanty · search · 2 results".into(),
            duration_ms: 950,
        }
    }

    #[test]
    fn event_json_matches_the_ui_contract() {
        let text = || "m".to_owned();
        let insulted = Mood::Insulted;
        let mut complete = jet_entry(42, EntryStatus::Complete);
        complete.entry.mood = Some(insulted);
        complete.entry.tools = vec![quanty_search()];
        let call = quanty_search();
        let started = ToolStart {
            id: call.id.clone(),
            server: call.server.clone(),
            tool: call.tool.clone(),
            input: call.input.clone(),
        };
        let stopped = jet_entry(44, EntryStatus::Stopped);
        let mut cases = vec![
            (
                Event::Started { fresh: true },
                json!({"kind": "started", "fresh": true}),
            ),
            (
                Event::ToolStarted(started),
                json!({"kind": "toolStarted", "id": "toolu_1", "server": "quanty",
                       "tool": "search", "input": {"question": "What is vega?"}}),
            ),
            (
                Event::ToolFinished(call),
                json!({"kind": "toolFinished", "id": "toolu_1", "server": "quanty",
                       "tool": "search", "input": {"question": "What is vega?"}, "ok": true,
                       "result": {"results": [1, 2]},
                       "summary": "quanty · search · 2 results", "durationMs": 950}),
            ),
            (
                Event::Notice { message: text() },
                json!({"kind": "notice", "message": "m"}),
            ),
            (
                Event::Mood { mood: insulted },
                json!({"kind": "mood", "mood": "insulted"}),
            ),
            (
                Event::Text { delta: text() },
                json!({"kind": "text", "delta": "m"}),
            ),
            (
                Event::Finished { entry: complete },
                json!({
                    "kind": "finished",
                    "entry": {"id": 42, "role": "jet", "text": "Friday looks fine",
                              "html": "<p>Friday looks fine</p>", "mood": "insulted",
                              "status": "complete", "at": 1_760_433_360_000_u64,
                              "tools": [{"id": "toolu_1", "server": "quanty", "tool": "search",
                                         "input": {"question": "What is vega?"}, "ok": true,
                                         "result": {"results": [1, 2]},
                                         "summary": "quanty · search · 2 results",
                                         "durationMs": 950}]}
                }),
            ),
            (
                Event::Stopped { entry: stopped },
                json!({
                    "kind": "stopped",
                    "entry": {"id": 44, "role": "jet", "text": "Friday looks fine",
                              "html": "<p>Friday looks fine</p>", "status": "stopped",
                              "at": 1_760_433_360_000_u64}
                }),
            ),
        ];
        let failures = [
            (Failure::ClaudeMissing { message: text() }, "claudeMissing"),
            (
                Failure::ProviderFailed { message: text() },
                "providerFailed",
            ),
            (Failure::Timeout { message: text() }, "timeout"),
            (Failure::Io { message: text() }, "io"),
        ];
        for (failure, kind) in failures {
            let mut entry = jet_entry(43, EntryStatus::Failed);
            entry.entry.error = Some(text());
            cases.push((
                Event::Failed { failure, entry },
                json!({
                    "kind": "failed",
                    "failure": {"kind": kind, "message": "m"},
                    "entry": {"id": 43, "role": "jet", "text": "Friday looks fine",
                              "html": "<p>Friday looks fine</p>", "status": "failed",
                              "error": "m", "at": 1_760_433_360_000_u64}
                }),
            ));
        }
        for (event, expected) in cases {
            assert_eq!(serde_json::to_value(&event).unwrap(), expected);
        }
    }
}
