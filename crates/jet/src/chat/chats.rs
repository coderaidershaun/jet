//! Every open chat of the server, one runtime each, found by the chat's id. A chat opens the first
//! time its user asks for it, so a user's turns, events and review timer never touch another's.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent::{Conversation, Notes};

use super::memory::ChatMemory;
use super::{BridgeError, ChatState, TurnTools};
use crate::files::Files;
use crate::lock;
use crate::store::{Chat, ChatId, Store, UserId};

/// What every chat of the server shares.
pub(crate) struct Chats {
    pub(super) store: Store,
    pub(super) tools: Arc<dyn TurnTools>,
    pub(super) files: Files,
    /// Where the provider programs are looked for when no path is set.
    pub(super) data_dir: PathBuf,
    /// How long a chat must be quiet before its notes review runs.
    pub(super) review_quiet: Duration,
    open: Mutex<Open>,
}

#[derive(Default)]
struct Open {
    chats: HashMap<ChatId, Arc<ChatState>>,
    closing: bool,
}

/// How long shutdown waits for the providers of every chat to let go.
const CLEANUP_LIMIT: Duration = Duration::from_secs(3);

impl Chats {
    pub(crate) fn new(
        store: Store,
        tools: Arc<dyn TurnTools>,
        files: Files,
        data_dir: PathBuf,
        review_quiet: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            tools,
            files,
            data_dir,
            review_quiet,
            open: Mutex::new(Open::default()),
        })
    }

    /// The runtime of the user's main chat.
    pub(crate) fn main(self: &Arc<Self>, user: UserId) -> Result<Arc<ChatState>, BridgeError> {
        let chat = self.store.main_chat(user)?;
        self.runtime(chat)
    }

    /// The runtime of the chat, opened the first time it is asked for. Opening marks the replies
    /// that a stopped server left unfinished.
    pub(crate) fn runtime(self: &Arc<Self>, chat: Chat) -> Result<Arc<ChatState>, BridgeError> {
        let mut open = lock(&self.open);
        if open.closing {
            return Err(BridgeError::ShuttingDown);
        }
        if let Some(runtime) = open.chats.get(&chat.id) {
            return Ok(runtime.clone());
        }
        let memory = ChatMemory {
            store: self.store.clone(),
            chat: chat.clone(),
        };
        let conversation = Conversation::new(Arc::new(memory));
        conversation.recover_interrupted()?;
        let runtime = ChatState::new(self, chat, conversation);
        open.chats.insert(runtime.chat.id, runtime.clone());
        Ok(runtime)
    }

    /// The runtime of a chat that is open, such as the chat of a running turn.
    pub(crate) fn open_chat(&self, chat: ChatId) -> Option<Arc<ChatState>> {
        lock(&self.open).chats.get(&chat).cloned()
    }

    /// The user's open chats, the main one always among them, so that a change to the user's
    /// notes or apps reaches the main chat's event stream even before its page opened it.
    fn open_chats_of(self: &Arc<Self>, user: UserId) -> Vec<Arc<ChatState>> {
        if let Err(error) = self.main(user) {
            eprintln!(
                "jet: could not open the main chat of user {}: {error}",
                user.0
            );
        }
        lock(&self.open)
            .chats
            .values()
            .filter(|chat| chat.chat.user == user)
            .cloned()
            .collect()
    }

    /// Tells every open chat of the user that their notes changed.
    pub(crate) fn notes_changed(self: &Arc<Self>, user: UserId, notes: &Notes) {
        for chat in self.open_chats_of(user) {
            chat.memory_updated(notes.clone());
        }
    }

    /// Tells every open chat of the app's owner that the app changed.
    pub(crate) fn registry_changed(
        self: &Arc<Self>,
        user: UserId,
        event: &agent::apps::RegistryEvent,
    ) {
        for chat in self.open_chats_of(user) {
            chat.registry_changed(event);
        }
    }

    /// Stops every chat's provider work and closes its event streams, waiting a fixed time for the
    /// providers to let go.
    pub(crate) fn shutdown(&self) {
        self.tools.shutdown();
        let chats: Vec<_> = {
            let mut open = lock(&self.open);
            open.closing = true;
            open.chats.values().cloned().collect()
        };
        for chat in &chats {
            chat.close();
        }
        let deadline = Instant::now() + CLEANUP_LIMIT;
        while chats.iter().any(|chat| chat.conversation.is_busy()) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if chats.iter().any(|chat| chat.conversation.is_busy()) {
            eprintln!(
                "jet: provider cleanup exceeded three seconds; request will be recovered on restart"
            );
        }
    }
}
