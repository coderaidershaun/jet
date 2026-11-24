//! The steps of an objective, in the order Jet and the user agreed them.

use super::objectives::touch;
use super::{ObjectiveId, Store, StoreError, UserId, seconds};
use rusqlite::{Transaction, params};
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
    pub(crate) done_at: Option<u64>,
}

/// Adds the steps at positions counting up from `first`.
pub(super) fn insert_all(
    tx: &Transaction,
    objective: ObjectiveId,
    first: i64,
    steps: &[NewStep],
) -> rusqlite::Result<()> {
    for (position, step) in (first..).zip(steps) {
        tx.execute(
            "INSERT INTO objective_steps (objective_id, position, title, due_date) VALUES (?1, ?2, ?3, ?4)",
            params![objective.0, position, step.title, step.due],
        )?;
    }
    Ok(())
}

impl Store {
    pub(crate) fn steps(
        &self,
        owner: UserId,
        objective: ObjectiveId,
    ) -> Result<Vec<Step>, StoreError> {
        self.with(|db| {
            let mut query = db.prepare(
                "SELECT s.id, s.position, s.title, s.due_date, s.done_at
                 FROM objective_steps s JOIN objectives o ON o.id = s.objective_id
                 WHERE o.id = ?1 AND o.user_id = ?2 ORDER BY s.position",
            )?;
            query
                .query_map(params![objective.0, owner.0], |row| {
                    Ok(Step {
                        id: StepId(row.get(0)?),
                        position: row.get::<_, i64>(1)?.unsigned_abs(),
                        title: row.get(2)?,
                        due: row.get(3)?,
                        done_at: row.get::<_, Option<i64>>(4)?.map(i64::unsigned_abs),
                    })
                })?
                .collect()
        })
    }

    /// Adds a step at the end. `None` when the user has no such objective.
    pub(crate) fn add_step(
        &self,
        owner: UserId,
        objective: ObjectiveId,
        step: &NewStep,
        at: u64,
    ) -> Result<Option<StepId>, StoreError> {
        self.try_with(|db| {
            let tx = db.transaction()?;
            if !touch(&tx, owner, objective, at)? {
                return Ok(None);
            }
            let last: i64 = tx.query_row(
                "SELECT coalesce(max(position), 0) FROM objective_steps WHERE objective_id = ?1",
                [objective.0],
                |row| row.get(0),
            )?;
            insert_all(&tx, objective, last + 1, std::slice::from_ref(step))?;
            let id = StepId(tx.last_insert_rowid());
            tx.commit()?;
            Ok(Some(id))
        })
    }

    /// Gives the step a new title, a new due date, or both; a `None` keeps what it has. `None`
    /// when the user has no such step.
    pub(crate) fn edit_step(
        &self,
        owner: UserId,
        (objective, step): (ObjectiveId, StepId),
        (title, due): (Option<&str>, Option<&str>),
        at: u64,
    ) -> Result<Option<()>, StoreError> {
        self.try_with(|db| {
            let tx = db.transaction()?;
            if !touch(&tx, owner, objective, at)? {
                return Ok(None);
            }
            let changed = tx.execute(
                "UPDATE objective_steps SET title = coalesce(?3, title), due_date = coalesce(?4, due_date)
                 WHERE id = ?1 AND objective_id = ?2",
                params![step.0, objective.0, title, due],
            )?;
            if changed == 0 {
                return Ok(None);
            }
            tx.commit()?;
            Ok(Some(()))
        })
    }

    /// Marks the step done at `at`, or not done again. `None` when the user has no such step.
    pub(crate) fn tick_step(
        &self,
        owner: UserId,
        objective: ObjectiveId,
        step: StepId,
        is_done: bool,
        at: u64,
    ) -> Result<Option<()>, StoreError> {
        self.try_with(|db| {
            let tx = db.transaction()?;
            if !touch(&tx, owner, objective, at)? {
                return Ok(None);
            }
            let changed = tx.execute(
                "UPDATE objective_steps SET done_at = ?3 WHERE id = ?1 AND objective_id = ?2",
                params![step.0, objective.0, is_done.then(|| seconds(at))],
            )?;
            if changed == 0 {
                return Ok(None);
            }
            tx.commit()?;
            Ok(Some(()))
        })
    }
}
