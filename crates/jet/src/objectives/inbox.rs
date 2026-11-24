//! What a user sends to a colleague's Jet: the rules for a send card, the sender's tap that stores
//! the item, and the limits that keep one user from flooding another.

use super::{Objectives, UTC};
use crate::chat::TurnOwner;
use crate::store::{
    CardId, Close, Closed, Item, ItemId, ItemKind, ItemState, NewTask, ObjectiveId, Posted,
    ReplyCard, ReplyCardId, ReplyOutcome, SendCard, SendTap, SetBy, StoreError, TaskId, TaskKind,
    UserId,
};
use agent::{Colleague, ColleagueOutcome, NewEntry, Role};

/// The longest text of an item, in characters.
const TEXT_LIMIT: usize = 2000;
/// The most items one sender may send one recipient in a day.
pub(crate) const SEND_LIMIT: u64 = 20;
const DAY_SECONDS: u64 = 24 * 60 * 60;

#[derive(Debug, thiserror::Error)]
pub(crate) enum InboxError {
    #[error("there is no user {id}; people_list shows the ids")]
    NoSuchUser { id: i64 },
    #[error("a message to the user's own Jet goes nowhere; pick a colleague")]
    ToSelf,
    #[error("the text is empty; write what to send")]
    EmptyText,
    #[error("the text is {length} characters and an item holds at most {TEXT_LIMIT}; shorten it")]
    TextTooLong { length: usize },
    #[error(
        "objective {id} is not shared between the user and {name}, so it cannot be named; leave it out"
    )]
    ObjectiveNotShared { id: i64, name: String },
    #[error(
        "the user sent {name} {SEND_LIMIT} items in the last day, which is the most; try again tomorrow"
    )]
    SendLimit { name: String },
    #[error("the user has no card {id}")]
    NoSuchCard { id: i64 },
    #[error("card {id} was sent already")]
    CardNotOpen { id: i64 },
    #[error("the user has no item {id} to reply to; tasks_list and the chat show the ids")]
    NoSuchItem { id: i64 },
    #[error("item {id} is {state} and cannot be replied to again")]
    ItemClosed { id: i64, state: &'static str },
    #[error("an answer needs the user's words; give them in `text`")]
    NeedsWords,
    #[error("the database failed")]
    Store(#[from] StoreError),
}

impl InboxError {
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::NoSuchUser { .. } => "noSuchUser",
            Self::ToSelf => "sendToSelf",
            Self::EmptyText => "emptyText",
            Self::TextTooLong { .. } => "textTooLong",
            Self::ObjectiveNotShared { .. } => "objectiveNotShared",
            Self::SendLimit { .. } => "sendLimit",
            Self::NoSuchCard { .. } => "noSuchCard",
            Self::CardNotOpen { .. } => "cardNotOpen",
            Self::NoSuchItem { .. } => "noSuchItem",
            Self::ItemClosed { .. } => "itemClosed",
            Self::NeedsWords => "needsWords",
            Self::Store(_) => "store",
        }
    }
}

impl Objectives {
    /// Makes a send card in the sender's chat. Nothing is stored for the recipient until the
    /// sender taps the card.
    pub(crate) fn propose_send(
        &self,
        sender: TurnOwner,
        to: UserId,
        kind: ItemKind,
        text: &str,
        objective: Option<ObjectiveId>,
    ) -> Result<SendCard, InboxError> {
        let text = text.trim();
        let length = text.chars().count();
        if length == 0 {
            return Err(InboxError::EmptyText);
        }
        if length > TEXT_LIMIT {
            return Err(InboxError::TextTooLong { length });
        }
        if to == sender.user {
            return Err(InboxError::ToSelf);
        }
        let name = self
            .store
            .user(to)?
            .ok_or(InboxError::NoSuchUser { id: to.0 })?
            .display_name;
        if let Some(id) = objective {
            let shared = |viewer, owner| -> Result<bool, StoreError> {
                Ok(self
                    .store
                    .shared_objectives(viewer, owner)?
                    .iter()
                    .any(|shared| shared.id == id))
            };
            if !shared(to, sender.user)? && !shared(sender.user, to)? {
                return Err(InboxError::ObjectiveNotShared { id: id.0, name });
            }
        }
        if self.store.sent_since(sender.user, to, self.day_ago())? >= SEND_LIMIT {
            return Err(InboxError::SendLimit { name });
        }
        let id = self.write(|| {
            self.store.add_send_card(
                (sender.user, Some(sender.chat), to),
                (kind, text, objective),
                self.now(),
            )
        })?;
        self.send_card(sender.user, id)
    }

    /// The sender's tap on a card: the item is stored and the recipient's Jet is told to bring it
    /// up. Gives the card as it is after.
    pub(crate) fn tap_send(&self, sender: UserId, card: CardId) -> Result<SendCard, InboxError> {
        let shown = self.send_card(sender, card)?;
        let who = self.name(sender)?;
        let now = self.now();
        let zone = self
            .zone_name(shown.to.id)
            .unwrap_or_else(|_| UTC.to_owned());
        let local_time = self.local_time(&zone, now).unwrap_or_default();
        let why = format!("Bring {who}'s {} to your user", shown.kind.as_str());
        let task = NewTask {
            kind: TaskKind::FollowUp,
            why: &why,
            due_at: now,
            local_time: &local_time,
            time_zone: &zone,
            set_by: SetBy::Jet,
        };
        let limit = (self.day_ago(), SEND_LIMIT);
        match self.write(|| self.store.send_item(sender, card, &task, limit))? {
            SendTap::Sent => {}
            SendTap::NoCard => return Err(InboxError::NoSuchCard { id: card.0 }),
            SendTap::AlreadySent => return Err(InboxError::CardNotOpen { id: card.0 }),
            SendTap::OverLimit => {
                return Err(InboxError::SendLimit {
                    name: shown.to.name,
                });
            }
        }
        let chat = match shown.chat {
            Some(chat) => chat,
            None => self.store.main_chat(sender)?.id,
        };
        let line = format!(
            "[The user tapped Send on the card for {}: it was sent as a {}.]",
            shown.to.name,
            shown.kind.as_str()
        );
        self.store.record_tap(sender, chat, &line, now)?;
        self.send_card(sender, card)
    }

    /// The sender's cards with these ids, as they are now. Others' cards are left out.
    pub(crate) fn send_cards(
        &self,
        sender: UserId,
        ids: &[CardId],
    ) -> Result<Vec<SendCard>, InboxError> {
        Ok(self.store.send_cards(sender, ids)?)
    }

    fn send_card(&self, sender: UserId, id: CardId) -> Result<SendCard, InboxError> {
        self.store
            .send_cards(sender, &[id])?
            .pop()
            .ok_or(InboxError::NoSuchCard { id: id.0 })
    }

    /// Makes a reply card in the recipient's chat with their exact words. Nothing reaches the
    /// sender until the recipient taps it.
    pub(crate) fn propose_reply(
        &self,
        owner: TurnOwner,
        id: ItemId,
        outcome: ReplyOutcome,
        words: &str,
    ) -> Result<ReplyCard, InboxError> {
        let (item, words) = self.replyable(owner.user, id, outcome, words)?;
        if !matches!(item.state, ItemState::Sent | ItemState::Seen) {
            return Err(InboxError::ItemClosed {
                id: id.0,
                state: item.state.as_str(),
            });
        }
        let card = self.write(|| {
            self.store
                .add_reply_card((owner.user, owner.chat), (id, outcome, words), self.now())
        })?;
        self.reply_card(owner.user, card)
    }

    /// The recipient's tap on a reply card: the reply goes to the sender. Gives the card as it is
    /// after, and what the reply posted.
    pub(crate) fn tap_reply(
        &self,
        user: UserId,
        id: ReplyCardId,
    ) -> Result<(ReplyCard, Vec<Posted>), InboxError> {
        let card = self.reply_card(user, id)?;
        if card.sent_at.is_some() {
            return Err(InboxError::CardNotOpen { id: id.0 });
        }
        let posted = self.reply(user, card.item_id, card.outcome, &card.text)?;
        let now = self.now();
        self.write(|| self.store.mark_reply_sent(user, id, now))?;
        let chat = match card.chat {
            Some(chat) => chat,
            None => self.store.main_chat(user)?.id,
        };
        let line = format!(
            "[The user tapped Send on the reply card to {}: it was sent as {}.]",
            card.to.name,
            card.outcome.as_str()
        );
        self.store.record_tap(user, chat, &line, now)?;
        Ok((self.reply_card(user, id)?, posted))
    }

    /// The user's reply cards with these ids, as they are now. Others' cards are left out.
    pub(crate) fn reply_cards(
        &self,
        user: UserId,
        ids: &[ReplyCardId],
    ) -> Result<Vec<ReplyCard>, InboxError> {
        Ok(self.store.reply_cards(user, ids)?)
    }

    fn reply_card(&self, user: UserId, id: ReplyCardId) -> Result<ReplyCard, InboxError> {
        self.store
            .reply_cards(user, &[id])?
            .pop()
            .ok_or(InboxError::NoSuchCard { id: id.0 })
    }

    /// The item the user may reply to, and their words trimmed, when the words fit the outcome.
    fn replyable<'a>(
        &self,
        user: UserId,
        id: ItemId,
        outcome: ReplyOutcome,
        words: &'a str,
    ) -> Result<(Item, &'a str), InboxError> {
        let words = words.trim();
        let length = words.chars().count();
        if length > TEXT_LIMIT {
            return Err(InboxError::TextTooLong { length });
        }
        if outcome == ReplyOutcome::Answered && words.is_empty() {
            return Err(InboxError::NeedsWords);
        }
        let item = self
            .store
            .item(id)?
            .filter(|item| item.to == user)
            .ok_or(InboxError::NoSuchItem { id: id.0 })?;
        Ok((item, words))
    }

    /// The recipient's own words end an item: an answer, a decline or a done. The sender gets one
    /// entry in the chat where they asked, with the words as the recipient's own.
    pub(crate) fn reply(
        &self,
        user: UserId,
        id: ItemId,
        outcome: ReplyOutcome,
        words: &str,
    ) -> Result<Vec<Posted>, InboxError> {
        let (item, words) = self.replyable(user, id, outcome, words)?;
        let name = self.name(user)?;
        let (said, colleague) = match outcome {
            ReplyOutcome::Answered => ("answered", ColleagueOutcome::Answered),
            ReplyOutcome::Declined => ("declined", ColleagueOutcome::Declined),
            ReplyOutcome::Done => ("marked it done", ColleagueOutcome::Done),
        };
        let reply = Colleague {
            user: user.0.cast_unsigned(),
            name: name.clone(),
            text: words.to_owned(),
            at: self.now(),
            outcome: Some(colleague),
            ..self.quote(&item)?
        };
        let closed = self.write(|| {
            self.store.close_item(Close {
                item: id,
                recipient: user,
                state: outcome.state(),
                reply: words,
                by_jet: false,
                at: self.now(),
                to_sender: NewEntry {
                    role: Role::Jet,
                    colleague: Some(reply.clone()),
                    ..NewEntry::user_text(&format!("{name} {said}."))
                },
                to_recipient: None,
            })
        })?;
        match closed {
            Closed::Done(posted) => Ok(posted),
            Closed::NoItem => Err(InboxError::NoSuchItem { id: id.0 }),
            Closed::Already(state) => Err(InboxError::ItemClosed {
                id: id.0,
                state: state.as_str(),
            }),
        }
    }

    /// A cancelled task that would have brought an item to its user ends the item as declined,
    /// with no words, so the sender learns it in the usual way.
    pub(crate) fn decline_item_of(
        &self,
        user: UserId,
        task: TaskId,
    ) -> Result<Vec<Posted>, InboxError> {
        let Some(item) = self.store.item_of_task(task)? else {
            return Ok(Vec::new());
        };
        match self.reply(user, item.id, ReplyOutcome::Declined, "") {
            Err(InboxError::ItemClosed { .. }) => Ok(Vec::new()),
            done => done,
        }
    }

    /// The sender's message as the recipient meets it: their words with their id, kept apart from
    /// anything Jet writes.
    pub(crate) fn quote(&self, item: &Item) -> Result<Colleague, StoreError> {
        Ok(Colleague {
            user: item.from.0.cast_unsigned(),
            name: self.name(item.from)?,
            item: item.id.0.cast_unsigned(),
            kind: item.kind.as_str().to_owned(),
            text: item.body.clone(),
            at: item.sent_at,
            outcome: None,
        })
    }

    /// The recipient's Jet answers the item from the objectives its user shares with the sender.
    /// The sender gets the answer marked as from Jet, and the recipient's main chat a line of who
    /// asked what and what Jet answered.
    pub(crate) fn answer_by_jet(&self, item: &Item, answer: &str) -> Result<Closed, InboxError> {
        let (asked, answered) = (self.name(item.from)?, self.name(item.to)?);
        let kind = item.kind.as_str();
        let (quote, now) = (self.quote(item)?, self.now());
        let reply = Colleague {
            user: item.to.0.cast_unsigned(),
            name: answered.clone(),
            text: answer.to_owned(),
            at: now,
            outcome: Some(ColleagueOutcome::JetAnswered),
            ..quote.clone()
        };
        let line = |text: String, colleague: &Colleague| NewEntry {
            role: Role::Jet,
            colleague: Some(colleague.clone()),
            ..NewEntry::user_text(&text)
        };
        Ok(self.write(|| {
            self.store.close_item(Close {
                item: item.id,
                recipient: item.to,
                state: ItemState::Answered,
                reply: answer,
                by_jet: true,
                at: now,
                to_sender: line(
                    format!("{answered}'s Jet answered from the objectives they share with you."),
                    &reply,
                ),
                to_recipient: Some(line(
                    format!("{asked} sent a {kind}, and I answered it from what you share with them: {answer}"),
                    &quote,
                )),
            })
        })?)
    }

    fn name(&self, user: UserId) -> Result<String, StoreError> {
        Ok(self
            .store
            .user(user)?
            .map_or_else(String::new, |user| user.display_name))
    }

    fn day_ago(&self) -> u64 {
        self.now().saturating_sub(DAY_SECONDS)
    }
}
