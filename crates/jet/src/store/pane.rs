//! What the plan pane and the task list keep: the taps Jet is told of, one waiting line per changed
//! task, and who has shared objectives with a user.

use super::{ChatId, ObjectiveId, StepId, Store, StoreError, UserId, seconds};
use rusqlite::{Connection, params};

/// A pane tap and the line Jet is told of it, written in the same transaction as the change.
pub(crate) type Tap<'a> = Option<(ChatId, &'a str)>;

/// Keeps the line of a tap inside the transaction of the change it tells of.
pub(super) fn insert_tap(db: &Connection, user: UserId, tap: Tap, at: u64) -> rusqlite::Result<()> {
    if let Some((chat, line)) = tap {
        db.execute(
            "INSERT INTO pane_taps (user_id, chat_id, line, at) VALUES (?1, ?2, ?3, ?4)",
            params![user.0, chat.0, line, seconds(at)],
        )?;
    }
    Ok(())
}

/// What Jet is told of one change to a task, kept as that task's one waiting line.
pub(crate) enum Told<'a> {
    /// The task is there after the change.
    Kept {
        /// The chat of the task after the change.
        chat: ChatId,
        /// The task's line, from its id and whether Jet has not heard of the task yet.
        line: &'a dyn Fn(StepId, bool) -> String,
        is_add: bool,
        /// The chat the task moved out of, and the line it is told there.
        left: Option<(ChatId, String)>,
    },
    Deleted {
        chat: ChatId,
        line: String,
    },
}

/// Replaces the waiting lines of the step with the one line of its latest change. A task that Jet
/// never heard of is told as added, and its delete is not told at all.
pub(super) fn record_task_line(
    db: &Connection,
    user: UserId,
    step: StepId,
    told: &Told,
    at: u64,
) -> rusqlite::Result<()> {
    let unheard: bool = db.query_row(
        "SELECT coalesce(max(step_added), 0) = 1 FROM pane_taps WHERE step_id = ?1 AND announced = 0",
        [step.0],
        |row| row.get(0),
    )?;
    db.execute(
        "DELETE FROM pane_taps WHERE step_id = ?1 AND announced = 0",
        [step.0],
    )?;
    let insert = |chat: ChatId, line: &str, step: Option<StepId>, added: bool| {
        db.execute(
            "INSERT INTO pane_taps (user_id, chat_id, line, at, step_id, step_added)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                user.0,
                chat.0,
                line,
                seconds(at),
                step.map(|id| id.0),
                added
            ],
        )
    };
    match told {
        Told::Kept {
            chat,
            line,
            is_add,
            left,
        } => {
            let added = *is_add || unheard;
            insert(*chat, &line(step, added), Some(step), added)?;
            if let (Some((old, text)), false) = (left, unheard) {
                insert(*old, text, None, false)?;
            }
        }
        Told::Deleted { chat, line } if !unheard => {
            insert(*chat, line, Some(step), false)?;
        }
        Told::Deleted { .. } => {}
    }
    Ok(())
}

impl Store {
    /// The people an objective is shared with, directly or through a team.
    pub(crate) fn viewers(&self, objective: ObjectiveId) -> Result<Vec<UserId>, StoreError> {
        self.with(|db| {
            db.prepare(
                "SELECT user_id FROM objective_shares WHERE objective_id = ?1 AND user_id IS NOT NULL
                 UNION SELECT m.user_id FROM objective_shares s JOIN team_members m ON m.team_id = s.team_id
                 WHERE s.objective_id = ?1",
            )?
            .query_map([objective.0], |row| Ok(UserId(row.get(0)?)))?
            .collect()
        })
    }

    /// The people who share at least one objective with `viewer`, directly or through a team.
    pub(crate) fn sharers(&self, viewer: UserId) -> Result<Vec<(UserId, String)>, StoreError> {
        self.with(|db| {
            db.prepare(
                "SELECT u.id, u.display_name FROM users u WHERE u.id IN (
                     SELECT o.user_id FROM objectives o JOIN objective_shares s ON s.objective_id = o.id
                     WHERE o.user_id != ?1 AND (s.user_id = ?1
                        OR s.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?1)))
                 ORDER BY u.id",
            )?
            .query_map([viewer.0], |row| Ok((UserId(row.get(0)?), row.get(1)?)))?
            .collect()
        })
    }
}
