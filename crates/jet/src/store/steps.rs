//! The steps of an objective, and the user's tasks under no objective, as Jet reads them: in the
//! user's own order, which every task of the user shares.

use super::{ObjectiveId, Store, StoreError, UserId, seconds};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) struct StepId(pub(crate) i64);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NewStep {
    pub(crate) title: String,
    pub(crate) due: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Step {
    pub(crate) id: StepId,
    pub(crate) position: u64,
    pub(crate) title: String,
    pub(crate) due: Option<String>,
    pub(crate) started_at: Option<u64>,
    pub(crate) done_at: Option<u64>,
}

const COLUMNS: &str = "s.id, s.position, s.title, s.due_date, s.started_at, s.done_at";

fn read(row: &rusqlite::Row) -> rusqlite::Result<Step> {
    let time = |at: usize| {
        row.get::<_, Option<i64>>(at)
            .map(|t| t.map(i64::unsigned_abs))
    };
    Ok(Step {
        id: StepId(row.get(0)?),
        position: row.get::<_, i64>(1)?.unsigned_abs(),
        title: row.get(2)?,
        due: row.get(3)?,
        started_at: time(4)?,
        done_at: time(5)?,
    })
}

/// Adds the user's tasks last in their order, under `objective` or under none. Gives the id of the
/// last one added.
pub(super) fn insert_all(
    tx: &Transaction,
    user: UserId,
    objective: Option<ObjectiveId>,
    steps: &[NewStep],
) -> rusqlite::Result<StepId> {
    let last: i64 = tx.query_row(
        "SELECT coalesce(max(position), 0) FROM objective_steps WHERE user_id = ?1",
        [user.0],
        |row| row.get(0),
    )?;
    for (position, step) in (last + 1..).zip(steps) {
        tx.execute(
            "INSERT INTO objective_steps (user_id, objective_id, position, title, due_date)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                user.0,
                objective.map(|id| id.0),
                position,
                step.title,
                step.due
            ],
        )?;
    }
    Ok(StepId(tx.last_insert_rowid()))
}

impl Store {
    pub(crate) fn steps(
        &self,
        owner: UserId,
        objective: ObjectiveId,
    ) -> Result<Vec<Step>, StoreError> {
        self.with(|db| {
            db.prepare(&format!(
                "SELECT {COLUMNS} FROM objective_steps s
                 WHERE s.objective_id = ?1 AND s.user_id = ?2 ORDER BY s.position, s.id"
            ))?
            .query_map(params![objective.0, owner.0], read)?
            .collect()
        })
    }

    /// The user's tasks under no objective: the open ones, and the ones done after `done_since`.
    pub(crate) fn loose_steps(
        &self,
        owner: UserId,
        done_since: u64,
    ) -> Result<Vec<Step>, StoreError> {
        self.with(|db| {
            db.prepare(&format!(
                "SELECT {COLUMNS} FROM objective_steps s
                 WHERE s.user_id = ?1 AND s.objective_id IS NULL
                   AND (s.done_at IS NULL OR s.done_at > ?2)
                 ORDER BY s.position, s.id"
            ))?
            .query_map(params![owner.0, seconds(done_since)], read)?
            .collect()
        })
    }

    pub(crate) fn step(&self, owner: UserId, id: StepId) -> Result<Option<Step>, StoreError> {
        self.with(|db| {
            db.query_row(
                &format!(
                    "SELECT {COLUMNS} FROM objective_steps s WHERE s.id = ?1 AND s.user_id = ?2"
                ),
                params![id.0, owner.0],
                read,
            )
            .optional()
        })
    }

    /// The objective the user's step is under: `Some(None)` for a task under no objective, and
    /// `None` when the user has no such step.
    pub(crate) fn step_objective(
        &self,
        owner: UserId,
        id: StepId,
    ) -> Result<Option<Option<ObjectiveId>>, StoreError> {
        self.with(|db| {
            db.query_row(
                "SELECT objective_id FROM objective_steps WHERE id = ?1 AND user_id = ?2",
                params![id.0, owner.0],
                |row| Ok(row.get::<_, Option<i64>>(0)?.map(ObjectiveId)),
            )
            .optional()
        })
    }
}
