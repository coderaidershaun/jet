//! What each user is working towards: the objective itself, made in one step with its steps,
//! sources, first check and chat. Every read and write takes the owner, so another user gets
//! nothing and changes nothing.

use super::chats::insert_entry;
use super::tasks::{NewTask, insert_task};
use super::text_enum::text_enum;
use super::{
    ChatId, NewNote, NewSource, NewStep, Store, StoreError, UserId, seconds, sources, steps,
    update_notes,
};
use agent::{EntryStatus, NewEntry, Role};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub(crate) struct ObjectiveId(pub(crate) i64);

text_enum!(ObjectiveStatus {
    Active = "active",
    Paused = "paused",
    Done = "done",
    Dropped = "dropped",
});

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Objective {
    pub(crate) id: ObjectiveId,
    pub(crate) chat_id: ChatId,
    pub(crate) title: String,
    pub(crate) deliverable: String,
    pub(crate) start: String,
    pub(crate) due: String,
    pub(crate) status: ObjectiveStatus,
    pub(crate) version: u64,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
    /// When it was closed as done or dropped.
    pub(crate) closed_at: Option<u64>,
}

/// Where the objective's chat is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ObjectiveChat {
    /// A new chat of kind objective, titled after the objective.
    New,
    /// The chat the objective was agreed in. A main chat stays the main chat and is only linked.
    This,
}

pub(crate) struct NewObjective<'a> {
    pub(crate) user: UserId,
    /// The chat of the turn that agreed the objective.
    pub(crate) agreed_in: ChatId,
    pub(crate) chat: ObjectiveChat,
    pub(crate) title: &'a str,
    pub(crate) deliverable: &'a str,
    pub(crate) start: &'a str,
    pub(crate) due: &'a str,
    pub(crate) steps: &'a [NewStep],
    pub(crate) sources: &'a [NewSource],
    pub(crate) check: NewTask<'a>,
    /// The first entry of a new chat.
    pub(crate) summary: &'a str,
    /// The line left in the chat where it was agreed, when the objective got a new chat.
    pub(crate) line: &'a str,
    pub(crate) at: u64,
}

/// What `create_objective` made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Created {
    pub(crate) objective: ObjectiveId,
    pub(crate) chat: ChatId,
}

/// The changes `edit` may make. A field left `None` stays as it is; `sources` replaces them all.
#[derive(Default)]
pub(crate) struct Edit<'a> {
    pub(crate) title: Option<&'a str>,
    pub(crate) deliverable: Option<&'a str>,
    pub(crate) status: Option<ObjectiveStatus>,
    pub(crate) sources: Option<&'a [NewSource]>,
}

const COLUMNS: &str = "id, chat_id, title, deliverable, start_date, due_date, status, version, created_at, updated_at, closed_at";

fn read(row: &rusqlite::Row) -> rusqlite::Result<Objective> {
    let number = |at: usize| row.get::<_, i64>(at).map(i64::unsigned_abs);
    Ok(Objective {
        id: ObjectiveId(row.get(0)?),
        chat_id: ChatId(row.get(1)?),
        title: row.get(2)?,
        deliverable: row.get(3)?,
        start: row.get(4)?,
        due: row.get(5)?,
        status: row.get(6)?,
        version: number(7)?,
        created_at: number(8)?,
        updated_at: number(9)?,
        closed_at: row.get::<_, Option<i64>>(10)?.map(i64::unsigned_abs),
    })
}

/// Raises the version of the owner's objective, which also tells whether it is theirs.
pub(super) fn touch(
    tx: &Transaction,
    owner: UserId,
    id: ObjectiveId,
    at: u64,
) -> rusqlite::Result<bool> {
    let changed = tx.execute(
        "UPDATE objectives SET version = version + 1, updated_at = ?3 WHERE id = ?1 AND user_id = ?2",
        params![id.0, owner.0, seconds(at)],
    )?;
    Ok(changed == 1)
}

impl Store {
    pub(crate) fn objectives(&self, owner: UserId) -> Result<Vec<Objective>, StoreError> {
        self.with(|db| {
            let mut query = db.prepare(&format!(
                "SELECT {COLUMNS} FROM objectives WHERE user_id = ?1 ORDER BY id"
            ))?;
            query.query_map([owner.0], read)?.collect()
        })
    }

    pub(crate) fn objective(
        &self,
        owner: UserId,
        id: ObjectiveId,
    ) -> Result<Option<Objective>, StoreError> {
        self.with(|db| {
            db.query_row(
                &format!("SELECT {COLUMNS} FROM objectives WHERE id = ?1 AND user_id = ?2"),
                params![id.0, owner.0],
                read,
            )
            .optional()
        })
    }

    /// The hosts of the page sources of the chat's objectives that are still open, for the pages
    /// a turn in that chat may read.
    pub(crate) fn page_hosts(&self, chat: ChatId) -> Result<Vec<String>, StoreError> {
        let pages: Vec<String> = self.with(|db| {
            let mut query = db.prepare(
                "SELECT s.target FROM objective_sources s JOIN objectives o ON o.id = s.objective_id
                 WHERE o.chat_id = ?1 AND o.status IN ('active', 'paused')
                   AND s.kind = 'web' AND s.detail = 'page'",
            )?;
            query.query_map([chat.0], |row| row.get(0))?.collect()
        })?;
        Ok(pages
            .iter()
            .filter_map(|page| url::Url::parse(page).ok()?.host_str().map(str::to_owned))
            .collect())
    }

    /// The open objectives of a chat made for objectives, each with its deliverable, dates and
    /// steps, in the words the chat opens with; `None` for any other chat.
    pub(crate) fn objective_summary(&self, chat: ChatId) -> Result<Option<String>, StoreError> {
        self.with(|db| {
            let mut objectives = db.prepare(
                "SELECT o.id, o.title, o.deliverable, o.start_date, o.due_date FROM objectives o
                 JOIN chats c ON c.id = o.chat_id
                 WHERE o.chat_id = ?1 AND c.kind = 'objective' AND o.status IN ('active', 'paused')
                 ORDER BY o.id",
            )?;
            let mut steps = db.prepare(
                "SELECT title FROM objective_steps WHERE objective_id = ?1 ORDER BY position",
            )?;
            let mut texts = Vec::new();
            let rows = objectives.query_map([chat.0], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })?;
            for row in rows {
                let (id, title, deliverable, start, due) = row?;
                let mut text =
                    format!("{title}\n\nDeliverable: {deliverable}\nFrom {start} to {due}.");
                let titles = steps.query_map([id], |row| row.get::<_, String>(0))?;
                for (number, step) in (1..).zip(titles) {
                    text.push_str(&format!("\n{number}. {}", step?));
                }
                texts.push(text);
            }
            Ok((!texts.is_empty()).then(|| texts.join("\n\n")))
        })
    }

    /// Makes the objective, its steps and sources, its first check and its chat together, or
    /// nothing at all.
    pub(crate) fn create_objective(&self, new: &NewObjective) -> Result<Created, StoreError> {
        self.try_with(|db| {
            let tx = db.transaction()?;
            let chat = objective_chat(&tx, new)?;
            tx.execute(
                "INSERT INTO objectives (user_id, chat_id, title, deliverable, start_date, due_date, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    new.user.0,
                    chat.0,
                    new.title,
                    new.deliverable,
                    new.start,
                    new.due,
                    seconds(new.at)
                ],
            )?;
            let objective = ObjectiveId(tx.last_insert_rowid());
            steps::insert_all(&tx, objective, 1, new.steps)?;
            sources::insert_all(&tx, objective, new.sources)?;
            insert_task(&tx, new.user, chat, Some(objective), &new.check, new.at)?;
            tx.commit()?;
            Ok(Created { objective, chat })
        })
    }

    /// `None` when the user has no such objective.
    pub(crate) fn edit_objective(
        &self,
        owner: UserId,
        id: ObjectiveId,
        edit: &Edit,
        at: u64,
    ) -> Result<Option<()>, StoreError> {
        self.try_with(|db| {
            let tx = db.transaction()?;
            if !touch(&tx, owner, id, at)? {
                return Ok(None);
            }
            tx.execute(
                "UPDATE objectives SET title = coalesce(?2, title), deliverable = coalesce(?3, deliverable),
                 status = coalesce(?4, status) WHERE id = ?1",
                params![id.0, edit.title, edit.deliverable, edit.status],
            )?;
            if let Some(list) = edit.sources {
                tx.execute(
                    "DELETE FROM objective_sources WHERE objective_id = ?1",
                    [id.0],
                )?;
                sources::insert_all(&tx, id, list)?;
            }
            tx.commit()?;
            Ok(Some(()))
        })
    }

    /// Changes the dates and leaves the note that says why, together. `None` when the user has
    /// no such objective.
    pub(crate) fn change_dates(
        &self,
        owner: UserId,
        id: ObjectiveId,
        dates: (&str, &str),
        note: &NewNote,
        at: u64,
    ) -> Result<Option<()>, StoreError> {
        self.try_with(|db| {
            let tx = db.transaction()?;
            if !touch(&tx, owner, id, at)? {
                return Ok(None);
            }
            tx.execute(
                "UPDATE objectives SET start_date = ?2, due_date = ?3 WHERE id = ?1",
                params![id.0, dates.0, dates.1],
            )?;
            update_notes::insert(&tx, id, note, at)?;
            tx.commit()?;
            Ok(Some(()))
        })
    }

    /// Ends the objective as done or dropped, cancels the checks still waiting, and leaves the
    /// closing note when there is one. `None` when the user has no such objective.
    pub(crate) fn close_objective(
        &self,
        owner: UserId,
        id: ObjectiveId,
        status: ObjectiveStatus,
        note: Option<&NewNote>,
        at: u64,
    ) -> Result<Option<()>, StoreError> {
        self.try_with(|db| {
            let tx = db.transaction()?;
            if !touch(&tx, owner, id, at)? {
                return Ok(None);
            }
            tx.execute(
                "UPDATE objectives SET status = ?2, closed_at = ?3 WHERE id = ?1",
                params![id.0, status, seconds(at)],
            )?;
            tx.execute(
                "UPDATE agent_tasks SET state = 'cancelled', version = version + 1, updated_at = ?2
                 WHERE objective_id = ?1 AND state = 'scheduled'",
                params![id.0, seconds(at)],
            )?;
            if let Some(note) = note {
                update_notes::insert(&tx, id, note, at)?;
            }
            tx.commit()?;
            Ok(Some(()))
        })
    }
}

fn jet_text(text: &str) -> NewEntry {
    NewEntry {
        turn: None,
        role: Role::Jet,
        text: text.to_owned(),
        attachments: Vec::new(),
        mood: None,
        status: EntryStatus::Complete,
        error: None,
        tools: Vec::new(),
        check: None,
        colleague: None,
    }
}

/// The chat the new objective belongs to, made or converted inside the transaction.
fn objective_chat(tx: &Transaction, new: &NewObjective) -> Result<ChatId, StoreError> {
    let kind: String = tx.query_row(
        "SELECT kind FROM chats WHERE id = ?1 AND user_id = ?2",
        params![new.agreed_in.0, new.user.0],
        |row| row.get(0),
    )?;
    match (new.chat, kind.as_str()) {
        (ObjectiveChat::This, "main") => Ok(new.agreed_in),
        (ObjectiveChat::This, "objective") => Err(StoreError::ChatTaken),
        (ObjectiveChat::This, _) => {
            tx.execute(
                "UPDATE chats SET kind = 'objective', title = ?2 WHERE id = ?1",
                params![new.agreed_in.0, new.title],
            )?;
            Ok(new.agreed_in)
        }
        (ObjectiveChat::New, _) => {
            tx.execute(
                "INSERT INTO chats (user_id, kind, title, created_at) VALUES (?1, 'objective', ?2, ?3)",
                params![new.user.0, new.title, seconds(new.at)],
            )?;
            let chat = ChatId(tx.last_insert_rowid());
            // `new.at` is in seconds; an entry's time is in milliseconds, as the page reads it.
            let at_ms = new.at.saturating_mul(1000);
            insert_entry(tx, chat, jet_text(new.summary), at_ms)?;
            insert_entry(tx, new.agreed_in, jet_text(new.line), at_ms)?;
            Ok(chat)
        }
    }
}
