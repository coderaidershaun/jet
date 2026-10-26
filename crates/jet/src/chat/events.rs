//! Reconnect browsers from an authoritative snapshot and a bounded tail of events.

use agent::{Event, ShownEntry, TurnIdentity};
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
            Event::ToolStarted { .. } => self.tools.push(json!(event)),
            Event::ToolFinished { id, .. } => {
                let result = json!(event);
                if let Some(tool) = self.tools.iter_mut().find(|tool| tool["id"] == *id) {
                    if let (Some(tool), Some(result)) = (tool.as_object_mut(), result.as_object()) {
                        tool.extend(result.clone());
                    }
                } else {
                    self.tools.push(result);
                }
            }
            _ => {}
        }
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
        match self.sender.send(envelope) {
            Ok(_) | Err(broadcast::error::SendError(_)) => {}
        }
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
