//! The update notes Jet writes about an objective as the user tells it how things are going.

use super::objectives::touch;
use super::text_enum::text_enum;
use super::{ObjectiveId, Store, StoreError, UserId, seconds};
use rusqlite::{Transaction, params};
use serde::Serialize;

text_enum!(NoteStatus {
    OnTrack = "on track",
    AtRisk = "at risk",
    Blocked = "blocked",
    Done = "done",
});

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NewNote {
    /// `None` for a note that only records new dates.
    pub(crate) status: Option<NoteStatus>,
    pub(crate) moved: String,
    pub(crate) blockers: String,
    pub(crate) new_dates: String,
    pub(crate) is_private: bool,
    /// The chat entry the note came from, when it is known.
    pub(crate) entry_id: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Note {
    pub(crate) id: i64,
    pub(crate) at: u64,
    pub(crate) status: Option<NoteStatus>,
    pub(crate) moved: String,
    pub(crate) blockers: String,
    pub(crate) new_dates: String,
    pub(crate) is_private: bool,
    pub(crate) entry_id: Option<u64>,
}

pub(super) fn insert(
    tx: &Transaction,
    objective: ObjectiveId,
    note: &NewNote,
    at: u64,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO objective_notes (objective_id, at, status, moved, blockers, new_dates, is_private, entry_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            objective.0,
            seconds(at),
            note.status,
            note.moved,
            note.blockers,
            note.new_dates,
            note.is_private,
            note.entry_id.map(seconds)
        ],
    )
    .map(drop)
}

impl Store {
    /// Every note of the owner's objective, oldest first, private ones included.
    pub(crate) fn update_notes(
        &self,
        owner: UserId,
        objective: ObjectiveId,
    ) -> Result<Vec<Note>, StoreError> {
        self.with(|db| {
            let mut query = db.prepare(
                "SELECT n.at, n.status, n.moved, n.blockers, n.new_dates, n.is_private, n.entry_id, n.id
                 FROM objective_notes n JOIN objectives o ON o.id = n.objective_id
                 WHERE o.id = ?1 AND o.user_id = ?2 ORDER BY n.id",
            )?;
            query
                .query_map(params![objective.0, owner.0], |row| {
                    Ok(Note {
                        at: row.get::<_, i64>(0)?.unsigned_abs(),
                        status: row.get(1)?,
                        moved: row.get(2)?,
                        blockers: row.get(3)?,
                        new_dates: row.get(4)?,
                        is_private: row.get(5)?,
                        entry_id: row.get::<_, Option<i64>>(6)?.map(i64::unsigned_abs),
                        id: row.get(7)?,
                    })
                })?
                .collect()
        })
    }

    /// Adds a note. `None` when the user has no such objective.
    pub(crate) fn add_update_note(
        &self,
        owner: UserId,
        objective: ObjectiveId,
        note: &NewNote,
        at: u64,
    ) -> Result<Option<()>, StoreError> {
        self.try_with(|db| {
            let tx = db.transaction()?;
            if !touch(&tx, owner, objective, at)? {
                return Ok(None);
            }
            insert(&tx, objective, note, at)?;
            tx.commit()?;
            Ok(Some(()))
        })
    }

    /// Marks the note private or shared. `None` when the user has no such note.
    pub(crate) fn set_note_private(
        &self,
        owner: UserId,
        objective: ObjectiveId,
        note: i64,
        is_private: bool,
        at: u64,
    ) -> Result<Option<()>, StoreError> {
        self.try_with(|db| {
            let tx = db.transaction()?;
            let changed = tx.execute(
                "UPDATE objective_notes SET is_private = ?3 WHERE id = ?1 AND objective_id = ?2",
                params![note, objective.0, is_private],
            )?;
            if changed != 1 || !touch(&tx, owner, objective, at)? {
                return Ok(None);
            }
            tx.commit()?;
            Ok(Some(()))
        })
    }
}
