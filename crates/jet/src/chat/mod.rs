//! Keep provider work alive independently of browser connections and expose recoverable turns.

mod error;
mod events;
mod provider;
mod review_timer;

use agent::{
    Conversation, DataDir, Effort, Event, Message, Model, Persona, ShownEntry, TurnIdentity,
    mcp::{Progress, ToolTarget},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};
use tokio::sync::broadcast;

use crate::files::{About, FileError, Files};
use crate::settings;
pub use error::BridgeError;
use events::{ActiveTurn, Runtime, TurnContext};
pub(crate) use events::{Envelope, Snapshot};
pub(crate) use provider::AgentStatus;
use review_timer::{ReviewTarget, ReviewTimer};

/// The longest request or client ID the page may send, in bytes.
pub(crate) const MAX_ID_BYTES: usize = 128;
/// The most files one message may carry.
const MAX_ATTACHMENTS: usize = 10;

pub(crate) struct ChatState {
    pub conversation: Conversation,
    // SMELL: chat and facade import each other; the facade reaches back through a weak link that server::open sets.
    facade: Arc<crate::facade::Facade>,
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
        facade: Arc<crate::facade::Facade>,
        files: Files,
    ) -> Result<Arc<Self>, BridgeError> {
        let conversation = Conversation::new(DataDir::new(data_dir.clone()));
        conversation.recover_interrupted()?;
        Ok(Arc::new(Self {
            conversation,
            facade,
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
        if request.request_id.is_empty()
            || request.client_id.is_empty()
            || request.request_id.len() > MAX_ID_BYTES
            || request.client_id.len() > MAX_ID_BYTES
            || (request.text.trim().is_empty() && request.attachments.is_empty())
            || !request.budget_usd.is_finite()
            || request.budget_usd <= 0.0
        {
            return Err(BridgeError::InvalidRequest(
                "request ID, client ID, message and positive budget are required".into(),
            ));
        }
        if request.attachments.len() > MAX_ATTACHMENTS {
            return Err(BridgeError::InvalidRequest(format!(
                "a message can carry at most {MAX_ATTACHMENTS} files"
            )));
        }
        let payload = json!(&request);
        // Finding the program can take seconds, so it runs before the lock. Its error waits
        // until the other checks have passed.
        let transport = settings::read_from(&self.data_dir)
            .map_err(BridgeError::from)
            .and_then(|saved| provider::transport_for(request.model, &saved, &self.data_dir));
        let mut runtime = lock(&self.runtime);
        if let Some(user) = self.conversation.accepted_request(&request.request_id)? {
            let identity = user
                .entry
                .turn
                .as_ref()
                .expect("accepted requests carry identity");
            if identity.request != payload {
                return Err(BridgeError::Conflict);
            }
            return Ok(Accepted {
                turn_id: identity.turn_id.clone(),
                request_id: identity.request_id.clone(),
                user,
            });
        }
        if runtime.closing {
            return Err(BridgeError::ShuttingDown);
        }
        if runtime.cancelled_requests.contains(&request.request_id) {
            return Err(BridgeError::Cancelled);
        }
        if runtime.active.is_some() {
            return Err(BridgeError::Busy);
        }
        let mut history = self.conversation.history(199)?;
        let transport = transport?;
        let attachments = self.attach(&request.attachments)?;
        let target = ReviewTarget {
            transport: transport.clone(),
            name: request.persona.name.clone(),
        };
        let identity = TurnIdentity {
            request_id: request.request_id,
            client_id: request.client_id,
            turn_id: uuid::Uuid::new_v4().to_string(),
            request: payload,
        };
        let message = Message {
            text: request.text,
            attachments,
            persona: request.persona,
            model: request.model,
            effort: request.effort,
            budget_usd: request.budget_usd,
            local_time: request.local_time,
            mcp: Some(self.facade.bind(&identity)),
            active_app_id: request.active_app_id,
            feeling: request.feeling,
        };
        let (user, mut reply) = self
            .conversation
            .send(transport, message, Some(identity.clone()))
            .inspect_err(|_| {
                self.facade.revoke(&identity.request_id);
            })?;
        let identity = TurnContext::from(&identity);
        self.review.note_activity();
        runtime.active = Some(ActiveTurn {
            identity: identity.clone(),
            user: user.clone(),
            text: String::new(),
            mood: None,
            tools: Vec::new(),
        });
        runtime.stopper = Some(reply.stopper());
        history.push(user.clone());
        let snapshot = Snapshot {
            epoch: runtime.epoch.clone(),
            cursor: runtime.cursor + 1,
            history,
            active: runtime.active.clone(),
        };
        runtime.publish(
            Some(identity.clone()),
            json!({"kind":"accepted", "snapshot":snapshot}),
        );
        let host = self.clone();
        let accepted = Accepted {
            turn_id: identity.turn_id.clone(),
            request_id: identity.request_id.clone(),
            user,
        };
        std::thread::spawn(move || {
            for event in reply.by_ref() {
                let terminal = matches!(
                    event,
                    Event::Finished { .. } | Event::Failed { .. } | Event::Stopped { .. }
                );
                let mut runtime = lock(&host.runtime);
                if let Some(active) = &mut runtime.active {
                    active.apply(&event);
                }
                runtime.publish(Some(identity.clone()), json!(event));
                if terminal {
                    host.facade.revoke(&identity.request_id);
                    runtime.active = None;
                    runtime.stopper = None;
                }
            }
            host.facade.revoke(&identity.request_id);
            drop(reply);
            let runtime = lock(&host.runtime);
            if !runtime.closing {
                host.review.schedule(host.clone(), target);
            }
        });
        Ok(accepted)
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
        let mut history = self.conversation.history(200)?;
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
        self.facade.revoke(request_id);
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
        binding: &crate::facade::Binding,
        app_id: &agent::apps::AppId,
    ) -> Result<(), BridgeError> {
        let mut runtime = lock(&self.runtime);
        if runtime.closing
            || runtime.cancelled_requests.contains(&binding.request_id)
            || !runtime.active.as_ref().is_some_and(|turn| {
                turn.identity.turn_id == binding.turn_id
                    && turn.identity.client_id == binding.client_id
            })
        {
            return Err(BridgeError::Cancelled);
        }
        runtime.publish(None, json!({"kind":"appOpened","appId":app_id,"turnId":binding.turn_id,"requestId":binding.request_id,"clientId":binding.client_id}));
        Ok(())
    }

    /// Shows how far a running tool call has got, on the card of that call. The facade only knows
    /// the request it forwarded, so the card is the first still-running one of this turn that names
    /// the same app, tool and arguments as the model sent. Anything that matches nothing is dropped.
    pub fn tool_progress(
        &self,
        binding: &crate::facade::Binding,
        target: &ToolTarget,
        arguments: &Value,
        progress: Progress,
    ) {
        let mut runtime = lock(&self.runtime);
        let Some(active) = &mut runtime.active else {
            return;
        };
        if active.identity.turn_id != binding.turn_id {
            return;
        }
        let Some(id) = active.running_call_id(target, arguments) else {
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

    pub fn memory_updated(&self, notes: agent::Notes) {
        lock(&self.runtime).publish(None, json!({"kind":"memoryUpdated", "notes":notes}));
    }

    pub fn shutdown(&self) {
        self.facade.shutdown();
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

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
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
