//! Keep provider work alive independently of browser connections and expose recoverable turns.

mod error;
mod events;
mod provider;
mod review_timer;
mod turn_tools;

use agent::{
    Conversation, ConversationError, DataDir, Effort, EntryId, Event, Message, Model, Persona,
    Reaction, Reply, ShownEntry, Transport, TurnIdentity, mcp::Progress,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::broadcast;

use crate::files::{About, FileError, Files};
use crate::{lock, settings};
pub use error::BridgeError;
use events::{ActiveTurn, Reacted, Runtime};
pub(crate) use events::{Envelope, RunningCall, Snapshot, TurnContext};
pub(crate) use provider::AgentStatus;
use review_timer::{ReviewTarget, ReviewTimer};
pub(crate) use turn_tools::TurnTools;

/// The longest request or client ID the page may send, in bytes.
pub(crate) const MAX_ID_BYTES: usize = 128;
/// The most files one message may carry.
const MAX_ATTACHMENTS: usize = 10;
/// How many entries of the thread a snapshot shows, the newest ones.
const SHOWN_HISTORY: usize = 200;

pub(crate) struct ChatState {
    pub conversation: Conversation,
    tools: Arc<dyn TurnTools>,
    files: Files,
    pub data_dir: PathBuf,
    runtime: Mutex<Runtime>,
    review: ReviewTimer,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SendRequest {
    pub request_id: String,
    pub client_id: String,
    pub text: String,
    /// The ids of uploaded files that go with the text.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<String>,
    #[serde(default)]
    pub model: Model,
    #[serde(default)]
    pub effort: Effort,
    pub budget_usd: f64,
    pub persona: Persona,
    pub local_time: String,
    #[serde(default)]
    pub feeling: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_app_id: Option<agent::apps::AppId>,
    /// True when the user hears the reply spoken aloud. Left out of the saved request when false,
    /// so that a retried request still matches the one that was accepted.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub spoken: bool,
}

impl SendRequest {
    fn check(&self) -> Result<(), BridgeError> {
        if self.request_id.is_empty()
            || self.client_id.is_empty()
            || self.request_id.len() > MAX_ID_BYTES
            || self.client_id.len() > MAX_ID_BYTES
            || (self.text.trim().is_empty() && self.attachments.is_empty())
            || !self.budget_usd.is_finite()
            || self.budget_usd <= 0.0
        {
            return Err(BridgeError::InvalidRequest(
                "request ID, client ID, message and positive budget are required".into(),
            ));
        }
        if self.attachments.len() > MAX_ATTACHMENTS {
            return Err(BridgeError::InvalidRequest(format!(
                "a message can carry at most {MAX_ATTACHMENTS} files"
            )));
        }
        Ok(())
    }
}

/// The user puts an emoji on a Jet message, or takes theirs off with `emoji: null`. The settings
/// are those of `send`, for the turn in which Jet may answer the reaction.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReactRequest {
    pub request_id: String,
    pub client_id: String,
    pub entry_id: EntryId,
    pub emoji: Option<String>,
    #[serde(default)]
    pub model: Model,
    #[serde(default)]
    pub effort: Effort,
    pub budget_usd: f64,
    pub persona: Persona,
    pub local_time: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_app_id: Option<agent::apps::AppId>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub spoken: bool,
}

impl ReactRequest {
    fn check(&self) -> Result<(), BridgeError> {
        if self.request_id.is_empty()
            || self.client_id.is_empty()
            || self.request_id.len() > MAX_ID_BYTES
            || self.client_id.len() > MAX_ID_BYTES
            || !self.budget_usd.is_finite()
            || self.budget_usd <= 0.0
        {
            return Err(BridgeError::InvalidRequest(
                "request ID, client ID and positive budget are required".into(),
            ));
        }
        if let Some(emoji) = &self.emoji
            && !Reaction::is_emoji(emoji)
        {
            return Err(BridgeError::InvalidRequest(format!(
                "{emoji:?} is not an emoji"
            )));
        }
        Ok(())
    }

    /// The same settings as a message with no words, so the turn is bound like any other.
    fn as_send(&self) -> SendRequest {
        SendRequest {
            request_id: self.request_id.clone(),
            client_id: self.client_id.clone(),
            text: String::new(),
            attachments: Vec::new(),
            model: self.model,
            effort: self.effort,
            budget_usd: self.budget_usd,
            persona: self.persona.clone(),
            local_time: self.local_time.clone(),
            feeling: None,
            active_app_id: self.active_app_id.clone(),
            spoken: self.spoken,
        }
    }
}

/// A user's reaction that Jet answers once the running turn has ended.
pub(crate) struct PendingReaction {
    request: ReactRequest,
    /// Found when the reaction came in, so starting the turn later looks nothing up.
    transport: Arc<dyn Transport>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Accepted {
    pub turn_id: String,
    pub request_id: String,
    pub user: ShownEntry,
}

impl ChatState {
    pub fn open(
        data_dir: PathBuf,
        tools: Arc<dyn TurnTools>,
        files: Files,
    ) -> Result<Arc<Self>, BridgeError> {
        let conversation = Conversation::new(DataDir::new(data_dir.clone()));
        conversation.recover_interrupted()?;
        Ok(Arc::new(Self {
            conversation,
            tools,
            files,
            data_dir,
            runtime: Mutex::new(Runtime::new()),
            review: ReviewTimer::new(),
        }))
    }

    pub fn status(&self) -> Result<AgentStatus, BridgeError> {
        let settings = settings::read_from(&self.data_dir)?;
        provider::agent_status(&settings, &self.data_dir, &self.conversation)
    }

    pub fn send(self: &Arc<Self>, request: SendRequest) -> Result<Accepted, BridgeError> {
        request.check()?;
        let payload = json!(&request);
        // Finding the program can take seconds, so it runs before the lock. Its error waits
        // until the other checks have passed.
        let transport = settings::read_from(&self.data_dir)
            .map_err(BridgeError::from)
            .and_then(|saved| provider::transport_for(request.model, &saved, &self.data_dir));
        let mut runtime = lock(&self.runtime);
        if let Some(accepted) = self.accepted_before(&request.request_id, &payload)? {
            return Ok(accepted);
        }
        runtime.check_can_start(&request.request_id)?;
        // One fewer than a snapshot shows, because the new user entry is added to these.
        let history = self.conversation.history(SHOWN_HISTORY - 1)?;
        let transport = transport?;
        let attachments = self.attach(&request.attachments)?;
        let target = ReviewTarget {
            transport: transport.clone(),
            name: request.persona.name.clone(),
        };
        let (identity, message) = self.bind_new_turn(request, payload, attachments);
        let (user, reply) = self
            .conversation
            .send(transport, message, Some(identity.clone()))
            .inspect_err(|_| {
                self.tools.revoke(&identity.request_id);
            })?;
        let identity = TurnContext::from(&identity);
        let accepted = Accepted {
            turn_id: identity.turn_id.clone(),
            request_id: identity.request_id.clone(),
            user: user.clone(),
        };
        let active = ActiveTurn::new(identity, Some(user), None);
        self.begin(&mut runtime, active, reply, history, target);
        Ok(accepted)
    }

    /// Saves the user's reaction and tells every browser at once, even while a turn runs. A new
    /// or changed emoji lets Jet answer it now, or after the running turn as the one pending
    /// reaction turn. Taking a reaction off starts nothing.
    pub fn react(self: &Arc<Self>, request: ReactRequest) -> Result<ShownEntry, BridgeError> {
        request.check()?;
        let transport = settings::read_from(&self.data_dir)
            .map_err(BridgeError::from)
            .and_then(|saved| provider::transport_for(request.model, &saved, &self.data_dir));
        let mut runtime = lock(&self.runtime);
        if runtime.closing {
            return Err(BridgeError::ShuttingDown);
        }
        let (entry, changed) = self
            .conversation
            .react(request.entry_id, request.emoji.as_deref())?;
        if !changed {
            return Ok(entry);
        }
        let event = Event::Reactions {
            entry_id: entry.entry.id,
            reactions: entry.entry.reactions.clone(),
        };
        runtime.publish(None, json!(event));
        if request.emoji.is_none() {
            let for_this_entry =
                |pending: &PendingReaction| pending.request.entry_id == request.entry_id;
            if runtime.pending.as_ref().is_some_and(for_this_entry) {
                runtime.pending = None;
            }
            return Ok(entry);
        }
        // Only Jet's answer needs the settings and the provider, so the reaction is saved first.
        let transport = transport?;
        runtime.pending = Some(PendingReaction { request, transport });
        self.start_pending(&mut runtime);
        Ok(entry)
    }

    /// Starts the pending reaction turn when no turn runs. While the provider is still held by
    /// the turn that just ended, it stays pending: that turn starts it once it lets go.
    fn start_pending(self: &Arc<Self>, runtime: &mut Runtime) {
        if runtime.active.is_some() || runtime.closing {
            return;
        }
        let Some(PendingReaction { request, transport }) = runtime.pending.take() else {
            return;
        };
        if runtime.cancelled_requests.contains(&request.request_id) {
            return;
        }
        let history = match self.conversation.history(SHOWN_HISTORY) {
            Ok(history) => history,
            Err(error) => {
                eprintln!(
                    "jet: the reaction on message {} was not answered: {error}",
                    request.entry_id
                );
                return;
            }
        };
        let target = ReviewTarget {
            transport: transport.clone(),
            name: request.persona.name.clone(),
        };
        let (identity, message) =
            self.bind_new_turn(request.as_send(), json!(&request), Vec::new());
        let started = self.conversation.answer_reaction(
            transport.clone(),
            message,
            request.entry_id,
            Some(identity.clone()),
        );
        let reply = match started {
            Ok(reply) => reply,
            Err(error) => {
                self.tools.revoke(&identity.request_id);
                if matches!(error, ConversationError::Busy) {
                    runtime.pending = Some(PendingReaction { request, transport });
                } else {
                    eprintln!(
                        "jet: the reaction on message {} was not answered: {error}",
                        request.entry_id
                    );
                }
                return;
            }
        };
        let reacted = Reacted {
            entry_id: request.entry_id,
            emoji: request.emoji.unwrap_or_default(),
        };
        let active = ActiveTurn::new(TurnContext::from(&identity), None, Some(reacted));
        self.begin(runtime, active, reply, history, target);
    }

    /// Makes the turn the active one and follows its reply on a thread of its own.
    fn begin(
        self: &Arc<Self>,
        runtime: &mut Runtime,
        active: ActiveTurn,
        reply: Reply,
        history: Vec<ShownEntry>,
        target: ReviewTarget,
    ) {
        let identity = active.identity.clone();
        self.review.note_activity();
        runtime.start(active, reply.stopper(), history);
        let host = self.clone();
        std::thread::spawn(move || host.follow_reply(reply, &identity, target));
    }

    /// The answer to a request that was accepted before, if it was. The same request ID with a
    /// different request is a conflict.
    fn accepted_before(
        &self,
        request_id: &str,
        payload: &Value,
    ) -> Result<Option<Accepted>, BridgeError> {
        let Some(user) = self.conversation.accepted_request(request_id)? else {
            return Ok(None);
        };
        let identity = user
            .entry
            .turn
            .as_ref()
            .expect("accepted requests carry identity");
        if identity.request != *payload {
            return Err(BridgeError::Conflict);
        }
        Ok(Some(Accepted {
            turn_id: identity.turn_id.clone(),
            request_id: identity.request_id.clone(),
            user,
        }))
    }

    /// Makes the identity of a new turn and its message for the provider. The turn is bound to the
    /// tool server here, so the message carries the connection the provider calls.
    fn bind_new_turn(
        &self,
        request: SendRequest,
        payload: Value,
        attachments: Vec<agent::Attachment>,
    ) -> (TurnIdentity, Message) {
        let identity = TurnIdentity {
            request_id: request.request_id,
            client_id: request.client_id,
            turn_id: uuid::Uuid::new_v4().to_string(),
            request: payload,
        };
        // Only Claude Code turns get web tools.
        let reads_web = !request.model.is_codex();
        let message = Message {
            text: request.text,
            attachments,
            persona: request.persona,
            model: request.model,
            effort: request.effort,
            budget_usd: request.budget_usd,
            local_time: request.local_time,
            mcp: Some(self.tools.bind(&identity, reads_web)),
            active_app_id: request.active_app_id,
            feeling: request.feeling,
            spoken: request.spoken,
        };
        (identity, message)
    }

    /// Publishes each event of the reply until it ends, then lets go of the turn and schedules the
    /// review of the thread.
    fn follow_reply(
        self: Arc<Self>,
        mut reply: Reply,
        identity: &TurnContext,
        target: ReviewTarget,
    ) {
        for event in reply.by_ref() {
            let terminal = matches!(
                event,
                Event::Finished { .. }
                    | Event::NoReply
                    | Event::Failed { .. }
                    | Event::Stopped { .. }
            );
            let mut runtime = lock(&self.runtime);
            if let Some(active) = &mut runtime.active {
                active.apply(&event);
            }
            runtime.publish(Some(identity.clone()), json!(event));
            if terminal {
                self.tools.revoke(&identity.request_id);
                runtime.active = None;
                runtime.stopper = None;
            }
        }
        self.tools.revoke(&identity.request_id);
        drop(reply);
        let mut runtime = lock(&self.runtime);
        if !runtime.closing {
            self.review.schedule(self.clone(), target);
        }
        self.start_pending(&mut runtime);
    }

    /// Makes the uploads visible to Jet and gives their details for the message. A bad id leaves
    /// nothing attached, and a repeated id counts once.
    fn attach(&self, ids: &[String]) -> Result<Vec<agent::Attachment>, BridgeError> {
        let mut unique: Vec<&str> = Vec::with_capacity(ids.len());
        for id in ids {
            if !unique.contains(&id.as_str()) {
                unique.push(id);
            }
        }
        match self.files.attach(&unique) {
            Ok(uploads) => Ok(uploads.iter().map(About::attachment).collect()),
            Err(FileError::NotFound(id)) => Err(BridgeError::InvalidRequest(format!(
                "{id} is not an uploaded file"
            ))),
            Err(error) => Err(error.into()),
        }
    }

    pub fn snapshot(&self) -> Result<Snapshot, BridgeError> {
        let runtime = lock(&self.runtime);
        self.snapshot_locked(&runtime)
    }

    fn snapshot_locked(&self, runtime: &Runtime) -> Result<Snapshot, BridgeError> {
        let mut history = self.conversation.history(SHOWN_HISTORY)?;
        if let Some(active) = &runtime.active {
            history.retain(|entry| {
                !(entry.entry.role == agent::Role::Jet
                    && entry
                        .entry
                        .turn
                        .as_ref()
                        .is_some_and(|turn| turn.turn_id == active.identity.turn_id))
            });
        }
        Ok(Snapshot {
            epoch: runtime.epoch.clone(),
            cursor: runtime.cursor,
            history,
            active: runtime.active.clone(),
        })
    }

    pub fn subscribe(
        &self,
        epoch: Option<&str>,
        cursor: Option<u64>,
    ) -> Result<(Vec<Value>, broadcast::Receiver<Envelope>), BridgeError> {
        let runtime = lock(&self.runtime);
        if runtime.closing {
            return Err(BridgeError::ShuttingDown);
        }
        let receiver = runtime.sender.subscribe();
        let initial = match runtime.replay(epoch, cursor) {
            Some(events) => events
                .into_iter()
                .map(|event| json!({"kind":"event", "data":event}))
                .collect(),
            None => vec![json!({"kind":"snapshot", "data":self.snapshot_locked(&runtime)?})],
        };
        Ok((initial, receiver))
    }

    pub fn stop(&self, request_id: &str) -> Result<(), BridgeError> {
        if request_id.is_empty() || request_id.len() > MAX_ID_BYTES {
            return Err(BridgeError::InvalidRequest(format!(
                "request ID is required and must be at most {MAX_ID_BYTES} bytes"
            )));
        }
        let mut runtime = lock(&self.runtime);
        runtime.cancel_request(request_id);
        self.tools.revoke(request_id);
        if runtime
            .active
            .as_ref()
            .is_some_and(|turn| turn.identity.request_id == request_id)
            && let Some(stopper) = &runtime.stopper
        {
            stopper.stop();
        }
        Ok(())
    }

    /// Clears the thread and deletes every file, the ones Jet wrote and the ones the user attached.
    /// The runtime stays locked throughout, so no turn can start and write a file in between.
    pub fn forget(&self) -> Result<(), BridgeError> {
        let mut runtime = lock(&self.runtime);
        self.conversation.forget()?;
        runtime.pending = None;
        runtime.publish(None, json!({"kind":"historyChanged"}));
        self.files.clear()?;
        Ok(())
    }

    pub fn is_closing(&self) -> bool {
        lock(&self.runtime).closing
    }

    pub fn registry_changed(&self, event: agent::apps::RegistryEvent) {
        lock(&self.runtime).publish(
            None,
            json!({"kind":"registryChanged", "appId":event.app_id, "change":event.change}),
        );
    }
    pub fn open_app(
        &self,
        turn: &TurnContext,
        app_id: &agent::apps::AppId,
    ) -> Result<(), BridgeError> {
        let mut runtime = lock(&self.runtime);
        if runtime.closing
            || runtime.cancelled_requests.contains(&turn.request_id)
            || !runtime.active.as_ref().is_some_and(|active| {
                active.identity.turn_id == turn.turn_id
                    && active.identity.client_id == turn.client_id
            })
        {
            return Err(BridgeError::Cancelled);
        }
        runtime.publish(None, json!({"kind":"appOpened","appId":app_id,"turnId":turn.turn_id,"requestId":turn.request_id,"clientId":turn.client_id}));
        Ok(())
    }

    /// Shows how far a running tool call has got, on its card. A call that names no card gets the
    /// first still-running card of this turn with the same app, tool and arguments. Progress that
    /// finds no card is dropped.
    pub fn tool_progress(&self, turn: &TurnContext, call: &RunningCall, progress: Progress) {
        let mut runtime = lock(&self.runtime);
        let Some(active) = &mut runtime.active else {
            return;
        };
        if active.identity.turn_id != turn.turn_id {
            return;
        }
        let Some(id) = active.card_of(call) else {
            return;
        };
        let identity = active.identity.clone();
        let event = Event::ToolProgress {
            id,
            progress: progress.progress,
            total: progress.total,
            message: progress.message,
        };
        active.apply(&event);
        runtime.publish(Some(identity), json!(event));
    }

    /// Waits until the turn's stream has passed the tool-use line `card_id`, then says whether the
    /// turn had read web text by then. Every earlier web read is on an earlier line, so the answer
    /// is exact. `None` when the turn ends first.
    pub async fn read_web_before(&self, turn: &TurnContext, card_id: &str) -> Option<bool> {
        let mut events = lock(&self.runtime).sender.subscribe();
        loop {
            {
                let runtime = lock(&self.runtime);
                let active = runtime.active.as_ref()?;
                if active.identity.turn_id != turn.turn_id {
                    return None;
                }
                if let Some(read) = active.read_web_before(card_id) {
                    return Some(read);
                }
            }
            if let Err(broadcast::error::RecvError::Closed) = events.recv().await {
                return None;
            }
        }
    }

    pub fn memory_updated(&self, notes: agent::Notes) {
        lock(&self.runtime).publish(None, json!({"kind":"memoryUpdated", "notes":notes}));
    }

    pub fn shutdown(&self) {
        self.tools.shutdown();
        {
            let mut runtime = lock(&self.runtime);
            runtime.closing = true;
            self.review.note_activity();
            if let Some(stopper) = &runtime.stopper {
                stopper.stop();
            }
            runtime.publish(None, json!({"kind":"shutdown"}));
        }
        self.conversation.stop_review();
        let deadline = Instant::now() + Duration::from_secs(3);
        while self.conversation.is_busy() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if self.conversation.is_busy() {
            eprintln!(
                "jet: provider cleanup exceeded three seconds; request will be recovered on restart"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use agent::Mood;

    #[test]
    fn every_mood_word_is_handled_by_the_director() {
        let director = include_str!("../../ui/jet/director.js");
        let mood_lines: Vec<&str> = director
            .lines()
            .filter(|line| line.starts_with("export const MOODS = ["))
            .collect();
        assert_eq!(
            mood_lines.len(),
            1,
            "director.js must have exactly one `export const MOODS = [` line, found {}",
            mood_lines.len()
        );
        let inside_brackets = mood_lines[0]
            .split_once('[')
            .and_then(|(_, rest)| rest.split_once(']'))
            .map(|(words, _)| words)
            .expect("the MOODS line has no closing bracket");
        let director_words: BTreeSet<&str> =
            inside_brackets.split('\'').skip(1).step_by(2).collect();
        let agent_words: BTreeSet<&str> = Mood::ALL.iter().map(|mood| mood.word()).collect();

        let missing_from_director: Vec<&str> =
            agent_words.difference(&director_words).copied().collect();
        let missing_from_agent: Vec<&str> =
            director_words.difference(&agent_words).copied().collect();
        assert!(
            missing_from_director.is_empty() && missing_from_agent.is_empty(),
            "mood words differ. Missing from MOODS in director.js: {missing_from_director:?}. \
             Missing from agent::Mood: {missing_from_agent:?}"
        );
    }
}
