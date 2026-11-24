//! Keep provider work alive independently of browser connections and expose recoverable turns.
//! Each chat has a runtime of its own: one reply at a time in it, while other chats reply at once.

mod chats;
mod error;
mod events;
mod memory;
mod promises;
mod provider;
mod review_timer;
mod turn_tools;

use agent::{
    Conversation, ConversationError, Effort, EntryId, Event, Message, Model, Persona, Reaction,
    Reply, ShownEntry, Transport, TurnIdentity, mcp::Progress,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::broadcast;

use crate::files::{About, FileError, Files};
use crate::lock;
use crate::objectives::is_time_zone;
use crate::store::{Chat, Store, Tapped, UserId};
pub(crate) use chats::Chats;
pub use error::BridgeError;
use events::{ActiveTurn, Feed, Reacted, Runtime};
pub(crate) use events::{Envelope, RunningCall, Snapshot, TurnContext};
pub(crate) use provider::AgentStatus;
use review_timer::{ReviewTarget, ReviewTimer};
pub(crate) use turn_tools::{TurnOwner, TurnTools};

/// The longest request or client ID the page may send, in bytes.
pub(crate) const MAX_ID_BYTES: usize = 128;
/// The most files one message may carry.
const MAX_ATTACHMENTS: usize = 10;
/// How many entries of the thread a snapshot shows, the newest ones.
const SHOWN_HISTORY: usize = 200;

/// The runtime of one chat: its conversation, its running turn and events, and its review timer.
pub(crate) struct ChatState {
    pub chat: Chat,
    pub conversation: Conversation,
    hub: Weak<Chats>,
    store: Store,
    tools: Arc<dyn TurnTools>,
    files: Files,
    data_dir: PathBuf,
    review_quiet: Duration,
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
    /// The IANA name of the page's time zone, such as `Europe/London`. The server keeps it on
    /// the user; Jet's local times are read in it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
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
            time_zone: None,
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
    fn new(
        hub: &Arc<Chats>,
        chat: Chat,
        conversation: Conversation,
        feed: Arc<Mutex<Feed>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            runtime: Mutex::new(Runtime::new(chat.id, feed)),
            chat,
            conversation,
            hub: Arc::downgrade(hub),
            store: hub.store.clone(),
            tools: hub.tools.clone(),
            files: hub.files.clone(),
            data_dir: hub.data_dir.clone(),
            review_quiet: hub.review_quiet,
            review: ReviewTimer::new(),
        })
    }

    fn user(&self) -> UserId {
        self.chat.user
    }

    pub fn status(&self) -> Result<AgentStatus, BridgeError> {
        let settings = self.store.settings(self.user())?;
        let paths = self.store.program_paths()?;
        provider::agent_status(
            &settings,
            &paths,
            &self.data_dir,
            self.chat.id,
            &self.conversation,
        )
    }

    /// The provider that runs `model`, from the server's program paths. Finding the program can
    /// take seconds, so callers do it before they take the runtime's lock.
    /// Only an admin's failed replies may name where the program is on the server.
    pub(crate) fn transport_for(&self, model: Model) -> Result<Arc<dyn Transport>, BridgeError> {
        let paths = self.store.program_paths()?;
        let transport = provider::transport_for(model, &paths, &self.data_dir, self.chat.id)?;
        let is_admin = self
            .store
            .user(self.user())?
            .is_some_and(|user| user.is_admin);
        Ok(match is_admin {
            true => transport,
            false => Arc::new(provider::PlacesHidden(transport)),
        })
    }

    pub fn send(self: &Arc<Self>, request: SendRequest) -> Result<Accepted, BridgeError> {
        request.check()?;
        if let Some(zone) = request
            .time_zone
            .as_deref()
            .filter(|zone| is_time_zone(zone))
        {
            self.store.set_time_zone(self.user(), zone)?;
        }
        let payload = json!(&request);
        let text = request.text.clone();
        // Its error waits until the other checks have passed.
        let transport = self.transport_for(request.model);
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
        let taps = self.store.unannounced_taps(self.chat.id)?;
        let (identity, mut message) = self.bind_new_turn(request, payload, attachments);
        message.notices = taps.iter().map(Tapped::notice).collect();
        // The user's message stops a running check and holds the chat's checks back before the
        // check-ins are read, so a check-in is either read here or never posted.
        let hub = self.hub.upgrade();
        let stop_holding = || {
            if let Some(hub) = &hub {
                hub.signals.reply_ended(self.chat.id);
            }
        };
        if let Some(hub) = &hub {
            hub.signals.user_wrote(self.chat.id);
        }
        let (unseen, heard_colleague) = self.unseen_check_ins().inspect_err(|_| stop_holding())?;
        message.notices.extend(unseen);
        if let Some(item) = heard_colleague {
            self.tools
                .colleague_text_read(self.owner(), &identity.request_id, item);
        }
        let (user, reply) = self
            .conversation
            .send(transport, message, Some(identity.clone()))
            .inspect_err(|_| {
                self.tools.revoke(self.owner(), &identity.request_id);
                stop_holding();
            })?;
        let told: Vec<_> = taps.iter().map(|tap| tap.id).collect();
        self.store.mark_taps_announced(&told)?;
        let identity = TurnContext::from(&identity);
        let accepted = Accepted {
            turn_id: identity.turn_id.clone(),
            request_id: identity.request_id.clone(),
            user: user.clone(),
        };
        let active = ActiveTurn::new(identity, Some(user), None);
        self.begin(&mut runtime, active, reply, history, target);
        self.title_from(&text);
        Ok(accepted)
    }

    /// One line for each check-in, and each entry of a colleague's words, that the provider
    /// session has not seen: a check runs in its own throwaway session, so Jet would not otherwise
    /// know what it asked. A colleague's words come inside their labelled block, and the turn is
    /// told so, because it is then the one that first carries them.
    fn unseen_check_ins(&self) -> Result<(Vec<String>, Option<bool>), BridgeError> {
        let seen_until = self
            .store
            .session(self.chat.id)?
            .map_or(0, |session| session.last_request_at);
        let unseen: Vec<_> = self
            .store
            .entries(self.chat.id, None)?
            .into_iter()
            .filter(|entry| {
                (entry.check.is_some() || entry.colleague.is_some()) && entry.at > seen_until
            })
            .collect();
        let heard_colleague = unseen
            .iter()
            .any(|entry| entry.colleague.is_some())
            .then(|| {
                unseen.iter().any(|entry| {
                    entry
                        .colleague
                        .as_ref()
                        .is_some_and(|c| c.outcome.is_none())
                })
            });
        let lines = unseen
            .into_iter()
            .map(|entry| match &entry.colleague {
                Some(colleague) => {
                    let sent = jiff::Timestamp::from_second(colleague.at.cast_signed())
                        .map_or_else(|_| String::new(), |at| at.to_string());
                    agent::colleague_notice(&entry.text, colleague, &sent)
                }
                None => format!(
                    "[You wrote this on your own, with no message from the user; they may be answering it: {}]",
                    entry.text
                ),
            })
            .collect();
        Ok((lines, heard_colleague))
    }

    /// Saves the user's reaction and tells every browser at once, even while a turn runs. A new
    /// or changed emoji lets Jet answer it now, or after the running turn as the one pending
    /// reaction turn. Taking a reaction off starts nothing.
    pub fn react(self: &Arc<Self>, request: ReactRequest) -> Result<ShownEntry, BridgeError> {
        request.check()?;
        let transport = self.transport_for(request.model);
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
                self.tools.revoke(self.owner(), &identity.request_id);
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
        let unread = self.store.unread(self.chat.id).unwrap_or_else(|error| {
            eprintln!(
                "jet: could not count unread entries of chat {}: {error}",
                self.chat.id.0
            );
            0
        });
        runtime.start(active, reply.stopper(), history, unread);
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
        let reads_web = request.model.reads_web();
        let message = Message {
            text: request.text,
            attachments,
            persona: request.persona,
            model: request.model,
            effort: request.effort,
            budget_usd: request.budget_usd,
            local_time: request.local_time,
            mcp: Some(self.tools.bind(&identity, reads_web, self.owner())),
            active_app_id: request.active_app_id,
            feeling: request.feeling,
            spoken: request.spoken,
            notices: Vec::new(),
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
                self.tools.revoke(self.owner(), &identity.request_id);
                runtime.active = None;
                runtime.stopper = None;
                if !matches!(event, Event::NoReply) {
                    self.publish_unread(&mut runtime);
                }
            }
        }
        self.tools.revoke(self.owner(), &identity.request_id);
        drop(reply);
        let mut runtime = lock(&self.runtime);
        if !runtime.closing {
            self.review.schedule(self.clone(), target);
        }
        self.start_pending(&mut runtime);
        if let Some(hub) = self.hub.upgrade() {
            hub.signals.reply_ended(self.chat.id);
        }
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
        match self.files.attach(self.user(), self.chat.id, &unique) {
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
        let feed = lock(&runtime.feed);
        Ok(Snapshot {
            chat_id: self.chat.id,
            epoch: feed.epoch.clone(),
            cursor: feed.cursor,
            history,
            active: runtime.active.clone(),
            unread: self.store.unread(self.chat.id)?,
        })
    }

    /// What a page that opens the event stream gets first: the events it missed when its epoch
    /// and cursor still reach back, else this chat's snapshot. The receiver carries the events of
    /// all of the user's chats.
    pub fn subscribe(
        &self,
        epoch: Option<&str>,
        cursor: Option<u64>,
    ) -> Result<(Vec<Value>, broadcast::Receiver<Envelope>), BridgeError> {
        let runtime = lock(&self.runtime);
        if runtime.closing {
            return Err(BridgeError::ShuttingDown);
        }
        let (receiver, missed) = {
            let feed = lock(&runtime.feed);
            (feed.sender.subscribe(), feed.replay(epoch, cursor))
        };
        let initial = match missed {
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
        self.tools.revoke(self.owner(), request_id);
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

    /// Clears the thread and deletes the files of this chat, the ones Jet wrote and the ones the
    /// user attached. The runtime stays locked throughout, so no turn can start and write a file in
    /// between.
    pub fn forget(&self) -> Result<(), BridgeError> {
        let mut runtime = lock(&self.runtime);
        self.conversation.forget()?;
        runtime.pending = None;
        runtime.publish(None, json!({"kind":"historyChanged"}));
        self.publish_unread(&mut runtime);
        self.files.clear(self.chat.id)?;
        Ok(())
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
    /// turn has read web text. Every earlier web read is on an earlier line, so none is missed; a
    /// web read that came back after that line and before this check also counts. `None` when the
    /// turn ends first.
    pub async fn read_web_before(&self, turn: &TurnContext, card_id: &str) -> Option<bool> {
        let mut events = lock(&lock(&self.runtime).feed).sender.subscribe();
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

    /// Tells every page that the chat now has this many unread Jet entries.
    fn publish_unread(&self, runtime: &mut Runtime) {
        match self.store.unread(self.chat.id) {
            Ok(unread) => runtime.publish(None, json!({"kind":"unread", "unread":unread})),
            Err(error) => eprintln!(
                "jet: could not count unread entries of chat {}: {error}",
                self.chat.id.0
            ),
        }
    }

    /// Moves the user's read mark of this chat to entry `through`, or to the newest entry, and
    /// tells every page the unread count that is left.
    pub fn mark_read(&self, through: Option<u64>) -> Result<u64, BridgeError> {
        let mut runtime = lock(&self.runtime);
        let unread = self.store.mark_read(self.user(), self.chat.id, through)?;
        runtime.publish(None, json!({"kind":"unread", "unread":unread}));
        Ok(unread)
    }

    /// Saves a Jet entry that answers no message, and tells every page: the entry itself, and the
    /// chat's unread count after it.
    #[cfg(test)]
    pub fn add_jet_entry(&self, entry: agent::NewEntry) -> Result<ShownEntry, BridgeError> {
        let shown = self.conversation.add_jet_entry(entry)?;
        self.announce(&shown);
        Ok(shown)
    }

    /// Tells every page about a Jet entry that is saved already, such as a check-in, and the
    /// chat's unread count after it.
    pub fn announce(&self, shown: &ShownEntry) {
        let mut runtime = lock(&self.runtime);
        runtime.publish(None, json!({"kind":"entryAdded", "entry":shown}));
        self.publish_unread(&mut runtime);
    }

    /// Whether a reply to the user runs in this chat.
    pub fn is_replying(&self) -> bool {
        self.conversation.is_busy()
    }

    /// Gives a topic chat that still has its first title a short one from the user's first words.
    /// A title the user set stays.
    fn title_from(&self, text: &str) {
        let Some(hub) = self.hub.upgrade() else {
            return;
        };
        let title = chats::short_title(text);
        let named = match self.store.chat(self.user(), self.chat.id) {
            Ok(Some(chat)) => {
                chat.kind == crate::store::ChatKind::Topic && chat.title == chats::NEW_CHAT_TITLE
            }
            _ => false,
        };
        if named
            && !title.is_empty()
            && self
                .store
                .rename_chat(self.user(), self.chat.id, &title)
                .is_ok()
        {
            hub.chats_changed(self.user(), Some(self.chat.id));
        }
    }

    /// Refuses all new work in this chat so that it can be deleted. A chat that is answering is
    /// refused, and stays as it was.
    fn retire(&self) -> Result<(), BridgeError> {
        let mut runtime = lock(&self.runtime);
        if self.conversation.is_busy() || runtime.active.is_some() {
            return Err(BridgeError::Busy);
        }
        runtime.closing = true;
        runtime.pending = None;
        self.review.note_activity();
        Ok(())
    }

    /// Takes back `retire` when the chat could not be deleted after all.
    fn reopen(&self) {
        lock(&self.runtime).closing = false;
    }

    fn owner(&self) -> TurnOwner {
        TurnOwner {
            user: self.user(),
            chat: self.chat.id,
        }
    }

    /// Stops the running turn and any review, refuses new work, and ends the event streams.
    fn close(&self) {
        {
            let mut runtime = lock(&self.runtime);
            runtime.closing = true;
            self.review.note_activity();
            if let Some(stopper) = &runtime.stopper {
                stopper.stop();
            }
        }
        self.conversation.stop_review();
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
