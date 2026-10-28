//! Reconnect browsers from an authoritative snapshot and a bounded tail of events.

use agent::{Event, ShownEntry, TurnIdentity, mcp::ToolTarget};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::VecDeque;
use tokio::sync::broadcast;

const REPLAY_LIMIT: usize = 512;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnContext {
    pub(super) request_id: String,
    pub(super) client_id: String,
    pub(super) turn_id: String,
}

impl From<&TurnIdentity> for TurnContext {
    fn from(identity: &TurnIdentity) -> Self {
        Self {
            request_id: identity.request_id.clone(),
            client_id: identity.client_id.clone(),
            turn_id: identity.turn_id.clone(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Envelope {
    pub cursor: u64,
    pub turn: Option<TurnContext>,
    pub event: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActiveTurn {
    pub identity: TurnContext,
    pub user: ShownEntry,
    pub text: String,
    pub mood: Option<agent::Mood>,
    pub tools: Vec<Value>,
}

impl ActiveTurn {
    pub fn apply(&mut self, event: &Event) {
        match event {
            Event::Text { delta } => self.text.push_str(delta),
            Event::Mood { mood } => self.mood = Some(*mood),
            Event::ToolStarted(_) => self.tools.push(json!(event)),
            Event::ToolFinished(call) => {
                let started = self.tools.iter_mut().find(|tool| tool["id"] == call.id);
                match (started, json!(event)) {
                    (Some(Value::Object(tool)), Value::Object(finished)) => {
                        tool.extend(finished);
                        tool.remove("progress");
                    }
                    (_, finished) => self.tools.push(finished),
                }
            }
            Event::ToolProgress {
                id,
                progress,
                total,
                message,
            } => {
                let running = self
                    .tools
                    .iter_mut()
                    .find(|tool| tool["id"] == *id && tool["kind"] == "toolStarted");
                if let Some(Value::Object(tool)) = running {
                    tool.insert(
                        "progress".into(),
                        json!({"progress":progress,"total":total,"message":message}),
                    );
                }
            }
            _ => {}
        }
    }

    /// Finds the id of the first still-running call that names the same app, tool and arguments
    /// as the model sent.
    pub(super) fn running_call_id(&self, target: &ToolTarget, arguments: &Value) -> Option<String> {
        // The card keeps the app id as the model wrote it, so it is compared as an id, not as text.
        let names_app = |server: &Value| {
            server
                .as_str()
                .and_then(|server| server.parse::<agent::apps::AppId>().ok())
                .is_some_and(|server| server == target.app_id)
        };
        let is_this_call = |tool: &&Value| {
            tool["kind"] == "toolStarted"
                && names_app(&tool["server"])
                && tool["tool"] == target.tool
                && tool["input"] == *arguments
        };
        self.tools
            .iter()
            .filter(is_this_call)
            .find_map(|tool| tool["id"].as_str().map(str::to_owned))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub epoch: String,
    pub cursor: u64,
    pub history: Vec<ShownEntry>,
    pub active: Option<ActiveTurn>,
}

pub(super) struct Runtime {
    pub epoch: String,
    pub cursor: u64,
    pub active: Option<ActiveTurn>,
    pub stopper: Option<agent::Stopper>,
    pub events: VecDeque<Envelope>,
    pub sender: broadcast::Sender<Envelope>,
    pub closing: bool,
    pub cancelled_requests: VecDeque<String>,
}

impl Runtime {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(REPLAY_LIMIT);
        Self {
            epoch: uuid::Uuid::new_v4().to_string(),
            cursor: 0,
            active: None,
            stopper: None,
            events: VecDeque::new(),
            sender,
            closing: false,
            cancelled_requests: VecDeque::new(),
        }
    }

    pub fn cancel_request(&mut self, request_id: &str) {
        if !self.cancelled_requests.iter().any(|id| id == request_id) {
            self.cancelled_requests.push_back(request_id.to_owned());
            if self.cancelled_requests.len() > REPLAY_LIMIT {
                self.cancelled_requests.pop_front();
            }
        }
    }

    pub fn publish(&mut self, turn: Option<TurnContext>, event: Value) {
        self.cursor += 1;
        let envelope = Envelope {
            cursor: self.cursor,
            turn,
            event,
        };
        self.events.push_back(envelope.clone());
        while self.events.len() > REPLAY_LIMIT {
            self.events.pop_front();
        }
        // No browser needs to be connected for a turn to finish.
        self.sender.send(envelope).ok();
    }

    pub fn replay(&self, epoch: Option<&str>, cursor: Option<u64>) -> Option<Vec<Envelope>> {
        let cursor = cursor?;
        let earliest = self
            .events
            .front()
            .map_or(self.cursor, |event| event.cursor.saturating_sub(1));
        if epoch != Some(&self.epoch) || cursor < earliest || cursor > self.cursor {
            return None;
        }
        Some(
            self.events
                .iter()
                .filter(|event| event.cursor > cursor)
                .cloned()
                .collect(),
        )
    }
}
