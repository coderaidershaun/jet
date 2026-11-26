//! Reconnect browsers from an authoritative snapshot and a bounded tail of events.

use super::BridgeError;
use crate::lock;
use crate::store::ChatId;
use agent::{EntryId, Event, ShownEntry, TurnIdentity, mcp_client::ToolTarget};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

const REPLAY_LIMIT: usize = 512;
/// The `kind` of a card whose call has not finished.
const TOOL_STARTED: &str = "toolStarted";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnContext {
    pub(crate) request_id: String,
    pub(super) client_id: String,
    pub(crate) turn_id: String,
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

/// A tool call that has not finished, with what it tells about the card it belongs to.
pub(crate) struct RunningCall<'a> {
    /// The id of the call's card, when the provider gives one.
    pub card_id: Option<&'a str>,
    /// Jet's own id of the call, which tells two calls apart when neither names its card.
    pub request_id: &'a str,
    pub target: &'a ToolTarget,
    /// The arguments as the model wrote them.
    pub arguments: &'a Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Envelope {
    /// The chat the event is about; `None` for an event that is about the user's whole Jet.
    pub chat_id: Option<ChatId>,
    pub cursor: u64,
    pub turn: Option<TurnContext>,
    pub event: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActiveTurn {
    pub identity: TurnContext,
    /// The message the turn answers; `None` when it answers a reaction instead.
    pub user: Option<ShownEntry>,
    /// The reaction the turn answers, when no message started it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reaction: Option<Reacted>,
    pub text: String,
    pub mood: Option<agent::Mood>,
    pub tools: Vec<Value>,
    /// A web search or page read came back in this turn.
    #[serde(skip)]
    read_web: bool,
    /// The card each call that names no card has taken, by the call's request id.
    #[serde(skip)]
    claimed: HashMap<String, String>,
}

impl ActiveTurn {
    pub(super) fn new(
        identity: TurnContext,
        user: Option<ShownEntry>,
        reaction: Option<Reacted>,
    ) -> Self {
        Self {
            identity,
            user,
            reaction,
            text: String::new(),
            mood: None,
            tools: Vec::new(),
            read_web: false,
            claimed: HashMap::new(),
        }
    }

    pub fn apply(&mut self, event: &Event) {
        match event {
            Event::Text { delta } => self.text.push_str(delta),
            Event::Mood { mood } => self.mood = Some(*mood),
            Event::Reactions {
                entry_id,
                reactions,
            } => {
                if let Some(user) = self.user.as_mut().filter(|user| user.entry.id == *entry_id) {
                    user.entry.reactions = reactions.clone();
                }
            }
            Event::ToolStarted(_) => self.tools.push(json!(event)),
            Event::ToolFinished(call) => {
                self.read_web |= call.read_web();
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
                    .find(|tool| tool["id"] == *id && tool["kind"] == TOOL_STARTED);
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

    /// Whether a web read has come back in this turn, or `None` while the card `card_id` has not
    /// been seen. A web read that came back after the card started also counts.
    pub(super) fn read_web_before(&self, card_id: &str) -> Option<bool> {
        let seen = self.tools.iter().any(|tool| tool["id"] == card_id);
        seen.then_some(self.read_web)
    }

    /// The id of the still-running card the call belongs to. A call that names its card gets that
    /// card or nothing, never another one that merely looks the same. A call that names none, as
    /// from Codex and agy, keeps the first look-alike card that no other call has taken.
    pub(super) fn card_of(&mut self, call: &RunningCall) -> Option<String> {
        if let Some(card_id) = call.card_id {
            return self.is_running(card_id).then(|| card_id.to_owned());
        }
        if let Some(card_id) = self.claimed.get(call.request_id)
            && self.is_running(card_id)
        {
            return Some(card_id.clone());
        }
        let card_id = self.free_card(call.target, call.arguments)?;
        self.claimed
            .insert(call.request_id.to_owned(), card_id.clone());
        Some(card_id)
    }

    fn is_running(&self, card_id: &str) -> bool {
        self.tools
            .iter()
            .any(|tool| tool["id"] == card_id && tool["kind"] == TOOL_STARTED)
    }

    /// Finds the id of the first still-running card, not taken by another call, that names the
    /// same app, tool and arguments as the model sent.
    fn free_card(&self, target: &ToolTarget, arguments: &Value) -> Option<String> {
        // The card keeps the app id as the model wrote it, so it is compared as an id, not as text.
        let names_app = |server: &Value| {
            server
                .as_str()
                .and_then(|server| server.parse::<agent::apps::AppId>().ok())
                .is_some_and(|server| server == target.app_id)
        };
        let is_this_call = |tool: &&Value| {
            tool["kind"] == TOOL_STARTED
                && names_app(&tool["server"])
                && tool["tool"] == target.tool
                && tool["input"] == *arguments
        };
        let is_taken = |card_id: &str| self.claimed.values().any(|taken| taken == card_id);
        self.tools
            .iter()
            .filter(is_this_call)
            .filter_map(|tool| tool["id"].as_str())
            .find(|card_id| !is_taken(card_id))
            .map(str::to_owned)
    }
}

/// The user's emoji on a Jet message that a turn answers.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reacted {
    pub entry_id: EntryId,
    pub emoji: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub chat_id: ChatId,
    pub epoch: String,
    pub cursor: u64,
    pub history: Vec<ShownEntry>,
    pub active: Option<ActiveTurn>,
    /// The Jet entries of the chat after the user's read mark.
    pub unread: u64,
}

/// The events of every chat of one user, in one order with one epoch and cursor, so that one
/// stream carries them all and a reconnecting page resumes them all.
pub(super) struct Feed {
    pub epoch: String,
    pub cursor: u64,
    events: VecDeque<Envelope>,
    pub sender: broadcast::Sender<Envelope>,
}

impl Default for Feed {
    fn default() -> Self {
        let (sender, _) = broadcast::channel(REPLAY_LIMIT);
        Self {
            epoch: uuid::Uuid::new_v4().to_string(),
            cursor: 0,
            events: VecDeque::new(),
            sender,
        }
    }
}

impl Feed {
    pub fn publish(&mut self, chat_id: Option<ChatId>, turn: Option<TurnContext>, event: Value) {
        self.cursor += 1;
        let envelope = Envelope {
            chat_id,
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

    /// The events after `cursor`, or `None` when the page's epoch is not this one or the tail no
    /// longer reaches back to its cursor.
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

pub(super) struct Runtime {
    pub chat: ChatId,
    /// The feed of the chat's user, shared by all of the user's chats.
    pub feed: Arc<Mutex<Feed>>,
    pub active: Option<ActiveTurn>,
    pub stopper: Option<agent::Stopper>,
    pub closing: bool,
    pub cancelled_requests: VecDeque<String>,
    /// The one reaction turn waiting for the running turn to end. A newer reaction replaces it.
    pub pending: Option<super::PendingReaction>,
}

impl Runtime {
    pub fn new(chat: ChatId, feed: Arc<Mutex<Feed>>) -> Self {
        Self {
            chat,
            feed,
            active: None,
            stopper: None,
            closing: false,
            cancelled_requests: VecDeque::new(),
            pending: None,
        }
    }

    /// Says why no turn may start for this request now, if there is a reason.
    pub fn check_can_start(&self, request_id: &str) -> Result<(), BridgeError> {
        if self.closing {
            return Err(BridgeError::ShuttingDown);
        }
        if self.cancelled_requests.iter().any(|id| id == request_id) {
            return Err(BridgeError::Cancelled);
        }
        if self.active.is_some() {
            return Err(BridgeError::Busy);
        }
        Ok(())
    }

    /// Makes the turn the active one and tells the browsers it was accepted, with the thread so
    /// far and the user's message.
    pub fn start(
        &mut self,
        active: ActiveTurn,
        stopper: agent::Stopper,
        mut history: Vec<ShownEntry>,
        unread: u64,
    ) {
        let identity = active.identity.clone();
        history.extend(active.user.clone());
        self.active = Some(active);
        self.stopper = Some(stopper);
        let mut feed = lock(&self.feed);
        let snapshot = Snapshot {
            chat_id: self.chat,
            epoch: feed.epoch.clone(),
            cursor: feed.cursor + 1,
            history,
            active: self.active.clone(),
            unread,
        };
        feed.publish(
            Some(self.chat),
            Some(identity),
            json!({"kind":"accepted", "snapshot":snapshot}),
        );
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
        lock(&self.feed).publish(Some(self.chat), turn, event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent::ToolStart;

    #[test]
    fn two_identical_calls_that_name_no_card_each_keep_their_own_card() {
        let app = uuid::Uuid::new_v4().to_string();
        let identity = TurnContext {
            request_id: "request".into(),
            client_id: "client".into(),
            turn_id: "turn".into(),
        };
        let mut turn = ActiveTurn::new(identity, None, None);
        for id in ["first", "second"] {
            turn.apply(&Event::ToolStarted(ToolStart {
                id: id.into(),
                server: app.clone(),
                tool: "fetch".into(),
                input: json!({"page": 1}),
            }));
        }
        let target = ToolTarget {
            app_id: app.parse().unwrap(),
            tool: "fetch".into(),
        };
        let arguments = json!({"page": 1});
        let call = |request_id| RunningCall {
            card_id: None,
            request_id,
            target: &target,
            arguments: &arguments,
        };
        let one = turn.card_of(&call("one"));
        let two = turn.card_of(&call("two"));
        let one_again = turn.card_of(&call("one"));
        assert_eq!(
            (one.as_deref(), two.as_deref(), one_again.as_deref()),
            (Some("first"), Some("second"), Some("first"))
        );
    }
}
