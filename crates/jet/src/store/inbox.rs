//! What users send to a colleague's Jet: the send card that waits for the sender's tap, the item
//! that the tap stores, and the states the item moves through until it ends.

use super::chats::insert_entry;
use super::tasks::insert_task;
use super::text_enum::text_enum;
use super::{ChatId, NewTask, ObjectiveId, Store, StoreError, TaskId, UserId, seconds};
use agent::{Entry, NewEntry};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) struct CardId(pub(crate) i64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) struct ItemId(pub(crate) i64);

text_enum!(ItemKind {
    Question = "question",
    Task = "task",
    Note = "note",
});

text_enum!(ItemState {
    Sent = "sent",
    Seen = "seen",
    Answered = "answered",
    Declined = "declined",
    Done = "done",
    Expired = "expired",
});

// How the recipient ends an item with their own words.
text_enum!(ReplyOutcome {
    Answered = "answered",
    Declined = "declined",
    Done = "done",
});

impl ReplyOutcome {
    pub(crate) fn state(self) -> ItemState {
        match self {
            Self::Answered => ItemState::Answered,
            Self::Declined => ItemState::Declined,
            Self::Done => ItemState::Done,
        }
    }
}

text_enum!(CardState {
    Proposed = "proposed",
    Sent = "sent",
});

/// An item as the recipient's side needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Item {
    pub(crate) id: ItemId,
    pub(crate) from: UserId,
    pub(crate) to: UserId,
    pub(crate) kind: ItemKind,
    pub(crate) body: String,
    pub(crate) state: ItemState,
    pub(crate) sent_at: u64,
    pub(crate) tried_alone: bool,
}

const ITEM_COLUMNS: &str = "id, from_user, to_user, kind, body, state, sent_at, tried_alone";

fn read_item(row: &rusqlite::Row) -> rusqlite::Result<Item> {
    Ok(Item {
        id: ItemId(row.get(0)?),
        from: UserId(row.get(1)?),
        to: UserId(row.get(2)?),
        kind: row.get(3)?,
        body: row.get(4)?,
        state: row.get(5)?,
        sent_at: row.get::<_, i64>(6)?.unsigned_abs(),
        tried_alone: row.get(7)?,
    })
}

/// An entry that closing an item posted, and where.
#[derive(Debug)]
pub(crate) struct Posted {
    pub(crate) user: UserId,
    pub(crate) chat: ChatId,
    pub(crate) entry: Entry,
}

/// How an item ends, and what is posted when it does.
pub(crate) struct Close<'a> {
    pub(crate) item: ItemId,
    /// The item's recipient: nobody else closes an item.
    pub(crate) recipient: UserId,
    pub(crate) state: ItemState,
    pub(crate) reply: &'a str,
    pub(crate) by_jet: bool,
    pub(crate) at: u64,
    /// The entry in the sender's chat, where the sender asked.
    pub(crate) to_sender: NewEntry,
    /// A line for the recipient's main chat.
    pub(crate) to_recipient: Option<NewEntry>,
}

#[derive(Debug)]
pub(crate) enum Closed {
    Done(Vec<Posted>),
    /// The item is not the recipient's, or does not exist.
    NoItem,
    /// The item ended already.
    Already(ItemState),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct CardTo {
    pub(crate) id: UserId,
    pub(crate) name: String,
}

/// The send card as the page draws it, in the state it is in now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SendCard {
    pub(crate) id: CardId,
    pub(crate) to: CardTo,
    pub(crate) kind: ItemKind,
    pub(crate) text: String,
    pub(crate) objective_id: Option<ObjectiveId>,
    pub(crate) objective_title: Option<String>,
    #[serde(skip)]
    pub(crate) chat: Option<ChatId>,
    pub(crate) state: CardState,
    pub(crate) sent_at: Option<u64>,
    pub(crate) item_id: Option<ItemId>,
    pub(crate) item_state: Option<ItemState>,
}

/// One item the user sent, as their pane lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sent {
    pub(crate) id: ItemId,
    pub(crate) to: CardTo,
    pub(crate) kind: ItemKind,
    pub(crate) text: String,
    pub(crate) objective_id: Option<ObjectiveId>,
    /// The title of the sender's own objective; nothing for one that is the recipient's.
    pub(crate) objective_title: Option<String>,
    pub(crate) state: ItemState,
    pub(crate) sent_at: u64,
    pub(crate) closed_at: Option<u64>,
    /// The recipient's words, or their Jet's answer.
    pub(crate) reply: Option<String>,
    pub(crate) answered_by_jet: bool,
    /// The chat where the sender asked, and where the answer came back.
    pub(crate) chat_id: ChatId,
}

/// What a tap on a send card did.
#[derive(Debug)]
pub(crate) enum SendTap {
    Sent,
    /// No such card for this user.
    NoCard,
    AlreadySent,
    /// The sender has sent this recipient as many items as a day allows.
    OverLimit,
}

impl Store {
    /// Makes a send card. It stores no item.
    pub(crate) fn add_send_card(
        &self,
        card: (UserId, Option<ChatId>, UserId),
        what: (ItemKind, &str, Option<ObjectiveId>),
        at: u64,
    ) -> Result<CardId, StoreError> {
        let ((from, chat, to), (kind, body, objective)) = (card, what);
        self.with(|db| {
            db.execute(
                "INSERT INTO send_cards (from_user, to_user, chat_id, kind, body, objective_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![from.0, to.0, chat.map(|id| id.0), kind, body, objective.map(|id| id.0), seconds(at)],
            )?;
            Ok(CardId(db.last_insert_rowid()))
        })
    }

    /// The sender's own cards with these ids, as they are now. Others' cards are left out.
    pub(crate) fn send_cards(
        &self,
        sender: UserId,
        ids: &[CardId],
    ) -> Result<Vec<SendCard>, StoreError> {
        self.with(|db| {
            let mut query = db.prepare(
                "SELECT c.id, c.to_user, u.display_name, c.kind, c.body, c.objective_id, o.title,
                        i.id, i.state, i.sent_at, c.chat_id
                 FROM send_cards c
                 JOIN users u ON u.id = c.to_user
                 LEFT JOIN objectives o ON o.id = c.objective_id AND o.user_id = c.from_user
                 LEFT JOIN inbox_items i ON i.id = c.item_id
                 WHERE c.id = ?1 AND c.from_user = ?2",
            )?;
            let mut found = Vec::new();
            for id in ids {
                let card = query
                    .query_row(params![id.0, sender.0], |row| {
                        let item: Option<i64> = row.get(7)?;
                        Ok(SendCard {
                            id: CardId(row.get(0)?),
                            to: CardTo {
                                id: UserId(row.get(1)?),
                                name: row.get(2)?,
                            },
                            kind: row.get(3)?,
                            text: row.get(4)?,
                            objective_id: row.get::<_, Option<i64>>(5)?.map(ObjectiveId),
                            objective_title: row.get(6)?,
                            chat: row.get::<_, Option<i64>>(10)?.map(ChatId),
                            state: if item.is_some() {
                                CardState::Sent
                            } else {
                                CardState::Proposed
                            },
                            item_id: item.map(ItemId),
                            item_state: row.get(8)?,
                            sent_at: row.get::<_, Option<i64>>(9)?.map(i64::unsigned_abs),
                        })
                    })
                    .optional()?;
                found.extend(card);
            }
            Ok(found)
        })
    }

    /// The newest `limit` items the user sent, newest first.
    pub(crate) fn sent_items(&self, user: UserId, limit: usize) -> Result<Vec<Sent>, StoreError> {
        self.with(|db| {
            db.prepare(
                "SELECT i.id, i.to_user, u.display_name, i.kind, i.body, i.objective_id, o.title, i.state,
                        i.sent_at, i.closed_at, i.reply, i.answered_by_jet,
                        coalesce(i.chat_id, (SELECT id FROM chats WHERE user_id = i.from_user AND kind = 'main'))
                 FROM inbox_items i
                 JOIN users u ON u.id = i.to_user
                 LEFT JOIN objectives o ON o.id = i.objective_id AND o.user_id = i.from_user
                 WHERE i.from_user = ?1 ORDER BY i.id DESC LIMIT ?2",
            )?
            .query_map(params![user.0, i64::try_from(limit).unwrap_or(i64::MAX)], |row| {
                Ok(Sent {
                    id: ItemId(row.get(0)?),
                    to: CardTo {
                        id: UserId(row.get(1)?),
                        name: row.get(2)?,
                    },
                    kind: row.get(3)?,
                    text: row.get(4)?,
                    objective_id: row.get::<_, Option<i64>>(5)?.map(ObjectiveId),
                    objective_title: row.get(6)?,
                    state: row.get(7)?,
                    sent_at: row.get::<_, i64>(8)?.unsigned_abs(),
                    closed_at: row.get::<_, Option<i64>>(9)?.map(i64::unsigned_abs),
                    reply: row.get(10)?,
                    answered_by_jet: row.get(11)?,
                    chat_id: ChatId(row.get(12)?),
                })
            })?
            .collect()
        })
    }

    /// Ends the items that waited longer than `lifetime` seconds with no answer, and cancels the
    /// tasks that would bring them up. Gives the senders, whose panes changed.
    pub(crate) fn expire_items(&self, now: u64, lifetime: u64) -> Result<Vec<UserId>, StoreError> {
        self.try_with(|db| {
            let tx = db.transaction()?;
            let (at, before) = (seconds(now), seconds(now.saturating_sub(lifetime)));
            let senders = tx
                .prepare(
                    "SELECT DISTINCT from_user FROM inbox_items
                     WHERE state IN ('sent', 'seen') AND sent_at <= ?1",
                )?
                .query_map([before], |row| Ok(UserId(row.get(0)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            tx.execute(
                "UPDATE agent_tasks SET state = 'cancelled', version = version + 1, updated_at = ?2
                 WHERE state = 'scheduled' AND id IN (
                     SELECT task_id FROM inbox_items WHERE state IN ('sent', 'seen') AND sent_at <= ?1)",
                params![before, at],
            )?;
            tx.execute(
                "UPDATE inbox_items SET state = 'expired', closed_at = ?2
                 WHERE state IN ('sent', 'seen') AND sent_at <= ?1",
                params![before, at],
            )?;
            tx.commit()?;
            Ok(senders)
        })
    }

    /// How many items `from` sent `to` since `since`.
    pub(crate) fn sent_since(
        &self,
        from: UserId,
        to: UserId,
        since: u64,
    ) -> Result<u64, StoreError> {
        self.with(|db| count_since(db, from, to, since))
    }

    /// The sender's tap: stores the card's item, and the agent-task that brings it to the
    /// recipient's Jet, in one transaction. `task` is made for the recipient and lands in the chat
    /// of the objective the item names when the recipient owns it, else in their main chat. The item
    /// is sent, and the task falls due, at the task's `due_at`.
    pub(crate) fn send_item(
        &self,
        sender: UserId,
        card: CardId,
        task: &NewTask,
        (since, limit): (u64, u64),
    ) -> Result<SendTap, StoreError> {
        self.try_with(|db| {
            let tx = db.transaction()?;
            let row = tx
                .query_row(
                    "SELECT to_user, chat_id, kind, body, objective_id, item_id
                     FROM send_cards WHERE id = ?1 AND from_user = ?2",
                    params![card.0, sender.0],
                    |row| {
                        Ok((
                            UserId(row.get(0)?),
                            row.get::<_, Option<i64>>(1)?,
                            row.get::<_, ItemKind>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, Option<i64>>(4)?,
                            row.get::<_, Option<i64>>(5)?,
                        ))
                    },
                )
                .optional()?;
            let Some((to, chat, kind, body, objective, item)) = row else {
                return Ok(SendTap::NoCard);
            };
            if item.is_some() {
                return Ok(SendTap::AlreadySent);
            }
            if count_since(&tx, sender, to, since)? >= limit {
                return Ok(SendTap::OverLimit);
            }
            let landing = tx
                .query_row(
                    "SELECT chat_id FROM objectives WHERE id = ?1 AND user_id = ?2",
                    params![objective, to.0],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            let landing = match landing {
                Some(chat) => ChatId(chat),
                None => main_chat(&tx, to)?,
            };
            tx.execute(
                "INSERT INTO inbox_items (from_user, to_user, chat_id, kind, body, objective_id, sent_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![sender.0, to.0, chat, kind, body, objective, seconds(task.due_at)],
            )?;
            let item = ItemId(tx.last_insert_rowid());
            let task = insert_task(&tx, to, landing, None, task, task.due_at)?;
            tx.execute(
                "UPDATE inbox_items SET task_id = ?2 WHERE id = ?1",
                params![item.0, task.0],
            )?;
            tx.execute(
                "UPDATE send_cards SET item_id = ?2 WHERE id = ?1",
                params![card.0, item.0],
            )?;
            tx.commit()?;
            Ok(SendTap::Sent)
        })
    }

    /// The item with this id, whoever it is between.
    pub(crate) fn item(&self, id: ItemId) -> Result<Option<Item>, StoreError> {
        self.with(|db| {
            db.query_row(
                &format!("SELECT {ITEM_COLUMNS} FROM inbox_items WHERE id = ?1"),
                [id.0],
                read_item,
            )
            .optional()
        })
    }

    /// The item that the task brings to its user, if the task is one.
    pub(crate) fn item_of_task(&self, task: TaskId) -> Result<Option<Item>, StoreError> {
        self.with(|db| {
            db.query_row(
                &format!("SELECT {ITEM_COLUMNS} FROM inbox_items WHERE task_id = ?1"),
                [task.0],
                read_item,
            )
            .optional()
        })
    }

    /// Notes that the recipient's Jet has tried to answer the item from the shared objectives.
    pub(crate) fn mark_item_tried(&self, item: ItemId) -> Result<(), StoreError> {
        self.with(|db| {
            db.execute(
                "UPDATE inbox_items SET tried_alone = 1 WHERE id = ?1",
                [item.0],
            )
            .map(drop)
        })
    }

    /// Ends an item that is still open, and posts what the end leaves in the chats, in one
    /// transaction. The item's agent-task is cancelled while it still waits.
    pub(crate) fn close_item(&self, close: Close) -> Result<Closed, StoreError> {
        self.try_with(|db| {
            let tx = db.transaction()?;
            let row = tx
                .query_row(
                    "SELECT state, from_user, coalesce(chat_id, (SELECT id FROM chats WHERE user_id = from_user AND kind = 'main'))
                     FROM inbox_items WHERE id = ?1 AND to_user = ?2",
                    params![close.item.0, close.recipient.0],
                    |row| Ok((row.get::<_, ItemState>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
                )
                .optional()?;
            let Some((state, sender, sender_chat)) = row else {
                return Ok(Closed::NoItem);
            };
            if !matches!(state, ItemState::Sent | ItemState::Seen) {
                return Ok(Closed::Already(state));
            }
            let at = seconds(close.at);
            tx.execute(
                "UPDATE inbox_items SET state = ?2, reply = ?3, answered_by_jet = ?4, closed_at = ?5 WHERE id = ?1",
                params![close.item.0, close.state, close.reply, close.by_jet, at],
            )?;
            tx.execute(
                "UPDATE agent_tasks SET state = 'cancelled', version = version + 1, updated_at = ?2
                 WHERE state = 'scheduled' AND id = (SELECT task_id FROM inbox_items WHERE id = ?1)",
                params![close.item.0, at],
            )?;
            let now = agent::now_ms();
            let mut posted = vec![Posted {
                user: UserId(sender),
                chat: ChatId(sender_chat),
                entry: insert_entry(&tx, ChatId(sender_chat), close.to_sender, now)?,
            }];
            if let Some(line) = close.to_recipient {
                let chat = main_chat(&tx, close.recipient)?;
                posted.push(Posted {
                    user: close.recipient,
                    chat,
                    entry: insert_entry(&tx, chat, line, now)?,
                });
            }
            tx.commit()?;
            Ok(Closed::Done(posted))
        })
    }
}

fn main_chat(db: &Connection, user: UserId) -> rusqlite::Result<ChatId> {
    db.query_row(
        "SELECT id FROM chats WHERE user_id = ?1 AND kind = 'main'",
        [user.0],
        |row| row.get(0).map(ChatId),
    )
}

fn count_since(db: &Connection, from: UserId, to: UserId, since: u64) -> rusqlite::Result<u64> {
    db.query_row(
        "SELECT count(*) FROM inbox_items WHERE from_user = ?1 AND to_user = ?2 AND sent_at > ?3",
        params![from.0, to.0, seconds(since)],
        |row| row.get::<_, i64>(0).map(i64::unsigned_abs),
    )
}
