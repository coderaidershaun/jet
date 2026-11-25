//! Every open chat of the server, one runtime each, found by the chat's id, and each user's list
//! of chats. A chat opens the first time its user asks for it, so a user's turns, events and
//! review timer never touch another's. Every chat is found through its user, so another user's
//! chat is answered like one that does not exist.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent::{Conversation, Entry, Notes, Review, ReviewOutcome, ReviewedChat, Transport};
use serde_json::json;

use super::events::Feed;
use super::memory::ChatMemory;
use super::{BridgeError, ChatState, TurnTools};
use crate::files::Files;
use crate::lock;
use crate::scheduler::Signals;
use crate::store::{Chat, ChatId, ChatKind, ChatSummary, ObjectiveId, Posted, Store, UserId};

/// What every chat of the server shares.
pub(crate) struct Chats {
    pub(super) store: Store,
    pub(super) tools: Arc<dyn TurnTools>,
    pub(super) files: Files,
    /// Where the provider programs are looked for when no path is set.
    pub(super) data_dir: PathBuf,
    /// How long a chat must be quiet before its notes review runs.
    pub(super) review_quiet: Duration,
    /// Tells the scheduler when a reply ends, and stops a check when the user writes.
    pub(super) signals: Signals,
    /// How far apart two reviews of one user are, in milliseconds. Tests shorten it.
    review_gap_ms: AtomicU64,
    open: Mutex<Open>,
}

#[derive(Default)]
struct Open {
    chats: HashMap<ChatId, Arc<ChatState>>,
    /// One feed of events for each user, for all of the user's chats.
    feeds: HashMap<UserId, Arc<Mutex<Feed>>>,
    /// Held while a user's notes review runs, so that only one review of the notes runs at a time.
    /// It holds the time, in milliseconds, of the user's last review.
    reviews: HashMap<UserId, Arc<Mutex<u64>>>,
    closing: bool,
}

/// The longest title a chat may have, in characters.
const TITLE_LIMIT: usize = 80;
/// The title of a chat that was opened without one.
pub(super) const NEW_CHAT_TITLE: &str = "New chat";

/// How long shutdown waits for the providers of every chat to let go.
const CLEANUP_LIMIT: Duration = Duration::from_secs(3);

/// The first words of a message, cut at a word boundary to about forty characters.
pub(super) fn short_title(text: &str) -> String {
    let mut title = String::new();
    for word in text.split_whitespace() {
        if !title.is_empty() && title.chars().count() + 1 + word.chars().count() > 40 {
            break;
        }
        if !title.is_empty() {
            title.push(' ');
        }
        title.push_str(word);
    }
    title.chars().take(40).collect()
}

fn no_such_chat() -> BridgeError {
    BridgeError::NotFound("no such chat".into())
}

/// A chat title as saved: trimmed, never empty, never longer than `TITLE_LIMIT` characters.
fn checked_title(title: &str) -> Result<String, BridgeError> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > TITLE_LIMIT {
        return Err(BridgeError::InvalidRequest(format!(
            "a chat title has 1 to {TITLE_LIMIT} characters"
        )));
    }
    Ok(title.to_owned())
}

impl Chats {
    pub(crate) fn new(
        store: Store,
        tools: Arc<dyn TurnTools>,
        files: Files,
        data_dir: PathBuf,
        review_quiet: Duration,
        signals: Signals,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            tools,
            files,
            data_dir,
            review_quiet,
            signals,
            review_gap_ms: AtomicU64::new(agent::REVIEW_GAP.as_millis() as u64),
            open: Mutex::new(Open::default()),
        })
    }

    /// The runtime of the user's main chat.
    pub(crate) fn main(self: &Arc<Self>, user: UserId) -> Result<Arc<ChatState>, BridgeError> {
        let chat = self.store.main_chat(user)?;
        self.runtime(chat)
    }

    /// The runtime of the user's chat `id`, or of their main chat when no id is given. A chat that
    /// is not the user's is `NotFound`, the same answer as for a chat that does not exist.
    pub(crate) fn chat(
        self: &Arc<Self>,
        user: UserId,
        id: Option<ChatId>,
    ) -> Result<Arc<ChatState>, BridgeError> {
        let Some(id) = id else {
            return self.main(user);
        };
        match self.store.chat(user, id)? {
            Some(chat) => self.runtime(chat),
            None => Err(no_such_chat()),
        }
    }

    /// The user's chats, the main one first and then the others by latest entry.
    pub(crate) fn list(&self, user: UserId) -> Result<Vec<ChatSummary>, BridgeError> {
        Ok(self.store.chats_of(user)?)
    }

    /// Opens a chat for the user, titled `title` or "New chat".
    pub(crate) fn add(
        self: &Arc<Self>,
        user: UserId,
        title: Option<&str>,
    ) -> Result<ChatSummary, BridgeError> {
        let title = match title {
            Some(title) => checked_title(title)?,
            None => NEW_CHAT_TITLE.to_owned(),
        };
        let id = self.store.add_chat(user, &title)?;
        self.chats_changed(user, Some(id));
        self.list(user)?
            .into_iter()
            .find(|chat| chat.id == id)
            .ok_or_else(no_such_chat)
    }

    pub(crate) fn rename(
        self: &Arc<Self>,
        user: UserId,
        id: ChatId,
        title: &str,
    ) -> Result<(), BridgeError> {
        self.store.chat(user, id)?.ok_or_else(no_such_chat)?;
        self.store.rename_chat(user, id, &checked_title(title)?)?;
        self.chats_changed(user, Some(id));
        Ok(())
    }

    /// Deletes a chat of the user with its thread. Its objectives and agent-tasks move to the
    /// main chat. The main chat is refused, and so is a chat that is still answering.
    pub(crate) fn delete(self: &Arc<Self>, user: UserId, id: ChatId) -> Result<(), BridgeError> {
        let Some(chat) = self.store.chat(user, id)? else {
            return Err(no_such_chat());
        };
        if chat.kind == ChatKind::Main {
            return Err(BridgeError::InvalidRequest(
                "the main chat cannot be deleted".into(),
            ));
        }
        let runtime = self.chat(user, Some(id))?;
        runtime.retire()?;
        if let Err(error) = self.store.delete_chat(user, id) {
            runtime.reopen();
            return Err(error.into());
        }
        lock(&self.open).chats.remove(&id);
        self.chats_changed(user, Some(id));
        // What the chat held is in the main chat now, which the pane shows differently, and the
        // files only that chat held went with it.
        self.pane_changed(user);
        Ok(())
    }

    /// Moves the read mark of the user's chat and gives the unread count that is left.
    pub(crate) fn read(
        self: &Arc<Self>,
        user: UserId,
        id: ChatId,
        through: Option<u64>,
    ) -> Result<u64, BridgeError> {
        self.chat(user, Some(id))?.mark_read(through)
    }

    /// The newest `limit` entries of the user's chat, oldest first.
    pub(crate) fn tail(
        &self,
        user: UserId,
        id: ChatId,
        limit: usize,
    ) -> Result<(Chat, Vec<Entry>), BridgeError> {
        let chat = self.store.chat(user, id)?.ok_or_else(no_such_chat)?;
        let entries = self.store.entries(id, Some(limit))?;
        Ok((chat, entries))
    }

    /// Tells the user's pages that their list of chats changed, and which chat it was about.
    pub(crate) fn chats_changed(&self, user: UserId, chat: Option<ChatId>) {
        let feed = self.feed(user);
        lock(&feed).publish(chat, None, json!({"kind":"chatsChanged"}));
    }

    /// Tells the user's pages that what the plan pane shows changed: an objective, a task or a run.
    /// This is the one call for every writer of that data, a tap, a tool or a finished check.
    pub(crate) fn pane_changed(&self, user: UserId) {
        let feed = self.feed(user);
        lock(&feed).publish(None, None, json!({"kind":"paneChanged"}));
    }

    /// Tells each page that the entries an item's ending posted are there, with the chats' unread
    /// counts, and each person's pane that an item changed.
    pub(crate) fn announce_posted(self: &Arc<Self>, posted: &[Posted]) {
        for Posted { user, chat, entry } in posted {
            let shown = agent::ShownEntry {
                html: agent::render_markdown(&entry.text),
                entry: entry.clone(),
            };
            if let Ok(runtime) = self.chat(*user, Some(*chat)) {
                runtime.announce(&shown);
            }
            self.pane_changed(*user);
        }
    }

    /// Tells the people an objective is shared with that their "shared with you" list changed.
    pub(crate) fn viewers_pane_changed(&self, objective: ObjectiveId) {
        match self.store.viewers(objective) {
            Ok(viewers) => viewers
                .into_iter()
                .for_each(|viewer| self.pane_changed(viewer)),
            Err(error) => eprintln!(
                "jet: could not find who sees objective {}: {error}",
                objective.0
            ),
        }
    }

    /// The feed of the user's events, made the first time it is asked for.
    fn feed(&self, user: UserId) -> Arc<Mutex<Feed>> {
        let mut open = lock(&self.open);
        open.feeds.entry(user).or_default().clone()
    }

    /// Sets how far apart two reviews of one user are.
    pub(crate) fn set_review_gap(&self, gap: Duration) {
        self.review_gap_ms
            .store(gap.as_millis() as u64, Ordering::SeqCst);
    }

    /// Reads the new entries of every chat of the user into their one set of notes, once the chat
    /// `quiet` has been quiet and the user's last review is a gap behind. One review of a user's
    /// notes runs at a time: a second one waits, and then finds nothing left to read. Gives how
    /// long the caller should wait before asking again when the review is not due yet.
    pub(super) fn review(
        self: &Arc<Self>,
        quiet: &Arc<ChatState>,
        transport: &dyn Transport,
        name: &str,
    ) -> Option<Duration> {
        let user = quiet.chat.user;
        let gate = lock(&self.open).reviews.entry(user).or_default().clone();
        let mut last_review = lock(&gate);
        let now = agent::now_ms();
        let gap = Duration::from_millis(self.review_gap_ms.load(Ordering::SeqCst));
        let wait = quiet
            .conversation
            .review_wait(now, self.review_quiet, gap)?;
        let since_last = Duration::from_millis(now.saturating_sub(*last_review));
        let wait = wait.max(gap.saturating_sub(since_last));
        if !wait.is_zero() {
            return Some(wait);
        }
        *last_review = now;
        let when = self.local_now(user, now);
        let outcome = self.reviewed_chats(user, quiet).and_then(|chats| {
            let list: Vec<_> = chats
                .iter()
                .map(|(title, chat)| ReviewedChat {
                    title,
                    conversation: &chat.conversation,
                })
                .collect();
            let review = agent::review_chats(transport, name, &when, &list)
                .map_err(|error| error.to_string())?;
            Ok((review, chats))
        });
        match outcome {
            Ok((Review { outcome, promises }, chats)) => {
                self.schedule_promises(user, &chats, &promises, now);
                if let ReviewOutcome::Updated(notes) = outcome {
                    self.notes_changed(user, &notes);
                }
            }
            Err(error) => eprintln!("jet: notes review failed: {error}"),
        }
        None
    }

    /// Every chat of the user with its title, `quiet` first.
    fn reviewed_chats(
        self: &Arc<Self>,
        user: UserId,
        quiet: &Arc<ChatState>,
    ) -> Result<Vec<(String, Arc<ChatState>)>, String> {
        let mut chats = vec![(String::new(), quiet.clone())];
        for summary in self
            .store
            .chats_of(user)
            .map_err(|error| error.to_string())?
        {
            if summary.id == quiet.chat.id {
                chats[0].0 = summary.title;
                continue;
            }
            let chat = Chat {
                id: summary.id,
                user,
                kind: summary.kind,
                title: summary.title.clone(),
            };
            let runtime = self.runtime(chat).map_err(|error| error.to_string())?;
            chats.push((summary.title, runtime));
        }
        Ok(chats)
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
        let feed = open.feeds.entry(chat.user).or_default().clone();
        let runtime = ChatState::new(self, chat, conversation, feed);
        open.chats.insert(runtime.chat.id, runtime.clone());
        Ok(runtime)
    }

    /// The runtime of a chat that is open, such as the chat of a running turn.
    pub(crate) fn open_chat(&self, chat: ChatId) -> Option<Arc<ChatState>> {
        lock(&self.open).chats.get(&chat).cloned()
    }

    /// Tells the user's pages that their notes changed.
    pub(crate) fn notes_changed(self: &Arc<Self>, user: UserId, notes: &Notes) {
        let feed = self.feed(user);
        lock(&feed).publish(None, None, json!({"kind":"memoryUpdated", "notes":notes}));
    }

    /// Tells the pages of the app's owner that the app changed.
    pub(crate) fn registry_changed(
        self: &Arc<Self>,
        user: UserId,
        event: &agent::apps::RegistryEvent,
    ) {
        let feed = self.feed(user);
        lock(&feed).publish(
            None,
            None,
            json!({"kind":"registryChanged", "appId":event.app_id, "change":event.change}),
        );
    }

    /// Stops every chat's provider work and closes its event streams, waiting a fixed time for the
    /// providers to let go.
    pub(crate) fn shutdown(&self) {
        self.tools.shutdown();
        let (chats, feeds): (Vec<_>, Vec<_>) = {
            let mut open = lock(&self.open);
            open.closing = true;
            (
                open.chats.values().cloned().collect(),
                open.feeds.values().cloned().collect(),
            )
        };
        for chat in &chats {
            chat.close();
        }
        for feed in &feeds {
            lock(feed).publish(None, None, json!({"kind":"shutdown"}));
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::test_store;
    use agent::{McpConnection, NewEntry, Role, TurnIdentity};

    use super::super::TurnOwner;

    struct NoTools;
    impl TurnTools for NoTools {
        fn bind(&self, _: &TurnIdentity, _: bool, _: TurnOwner) -> McpConnection {
            unreachable!("no turn runs in this test")
        }
        fn colleague_text_read(&self, _: TurnOwner, _: &str, _: bool) {}
        fn revoke(&self, _: TurnOwner, _: &str) {}
        fn shutdown(&self) {}
    }

    #[test]
    fn a_jet_entry_that_answers_no_message_is_unread_until_its_chat_is_read() {
        let (dir, store, ada, _) = test_store();
        let files = Files::new(store.clone());
        let chats = Chats::new(
            store,
            Arc::new(NoTools),
            files,
            dir.path().into(),
            Duration::ZERO,
            Signals::default(),
        );
        let topic = chats.add(ada, None).unwrap();
        assert_eq!(topic.title, "New chat");
        let chat = chats.chat(ada, Some(topic.id)).unwrap();
        let (_, mut events) = chat.subscribe(None, None).unwrap();

        let check_in = NewEntry {
            role: Role::Jet,
            ..NewEntry::user_text("How is the kite?")
        };
        chat.add_jet_entry(check_in).unwrap();
        let kinds: Vec<_> = (0..2)
            .map(|_| events.try_recv().unwrap())
            .map(|envelope| (envelope.chat_id, envelope.event["kind"].clone()))
            .collect();
        assert_eq!(
            kinds,
            [
                (Some(topic.id), "entryAdded".into()),
                (Some(topic.id), "unread".into())
            ]
        );
        assert_eq!(chat.snapshot().unwrap().unread, 1);
        assert_eq!(chats.list(ada).unwrap()[0].title, "Main chat");
        assert_eq!(chats.list(ada).unwrap()[1].unread, 1);

        assert_eq!(
            chats.read(ada, topic.id, Some(0)).unwrap(),
            1,
            "the mark never moves back"
        );
        assert_eq!(
            chats.read(ada, topic.id, Some(99)).unwrap(),
            0,
            "and never passes the newest entry"
        );
    }
}
