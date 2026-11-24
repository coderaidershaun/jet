//! What Jet sets itself to do (agent-tasks) and the runs that did it. A task is a check of one
//! objective, at most one open at a time, or a follow-up in a chat.

use super::text_enum::text_enum;
use super::{ChatId, ObjectiveId, Store, StoreError, UserId, seconds};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) struct TaskId(pub(crate) i64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) struct RunId(pub(crate) i64);

text_enum!(TaskKind {
    Check = "check",
    FollowUp = "follow_up",
});

text_enum!(TaskState {
    Scheduled = "scheduled",
    Running = "running",
    Done = "done",
    Cancelled = "cancelled",
    Failed = "failed",
});

text_enum!(SetBy {
    Jet = "jet",
    User = "user",
    Default = "default",
    Review = "review",
});

text_enum!(RunOutcome {
    Spoke = "spoke",
    Silent = "silent",
    Held = "held",
    Failed = "failed",
    Interrupted = "interrupted",
    Preempted = "preempted",
    Stale = "stale",
});

/// A task before it has an id. `due_at` is the UTC time the local time and zone stand for.
#[derive(Debug, Clone)]
pub(crate) struct NewTask<'a> {
    pub(crate) kind: TaskKind,
    pub(crate) why: &'a str,
    pub(crate) due_at: u64,
    pub(crate) local_time: &'a str,
    pub(crate) time_zone: &'a str,
    pub(crate) set_by: SetBy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTask {
    pub(crate) id: TaskId,
    pub(crate) chat_id: ChatId,
    pub(crate) objective_id: Option<ObjectiveId>,
    pub(crate) kind: TaskKind,
    pub(crate) why: String,
    pub(crate) due_at: u64,
    pub(crate) local_time: String,
    pub(crate) time_zone: String,
    pub(crate) state: TaskState,
    pub(crate) attempts: u64,
    pub(crate) version: u64,
    pub(crate) set_by: SetBy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Run {
    pub(crate) id: RunId,
    pub(crate) task_id: TaskId,
    pub(crate) started_at: u64,
    pub(crate) ended_at: Option<u64>,
    pub(crate) outcome: Option<RunOutcome>,
    pub(crate) found: String,
    pub(crate) sources_read: Vec<String>,
    pub(crate) tokens: Option<u64>,
}

/// How a run ended, for `finish_run`.
pub(crate) struct Finished<'a> {
    pub(crate) outcome: RunOutcome,
    pub(crate) found: &'a str,
    pub(crate) sources_read: &'a [String],
    pub(crate) tokens: Option<u64>,
    /// What the task becomes: `Done` after a good run, `Scheduled` when it will be tried again.
    pub(crate) task: TaskState,
}

/// What `schedule_check` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Scheduled {
    Added(TaskId),
    Moved(TaskId),
    /// The open check is running now and cannot be moved.
    Running(TaskId),
    /// The objective is done or dropped, or is not the user's.
    NoObjective,
}

/// What `cancel_task` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CancelOutcome {
    Cancelled,
    /// The task is not waiting, so it stays as it is.
    NotWaiting(TaskState),
    Missing,
}

/// What `snooze_task` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Snoozed {
    Moved,
    NotWaiting(TaskState),
    Missing,
}

const COLUMNS: &str = "id, chat_id, objective_id, kind, why, due_at, local_time, time_zone, state, attempts, version, set_by";

fn read(row: &rusqlite::Row) -> rusqlite::Result<AgentTask> {
    let number = |at: usize| row.get::<_, i64>(at).map(i64::unsigned_abs);
    Ok(AgentTask {
        id: TaskId(row.get(0)?),
        chat_id: ChatId(row.get(1)?),
        objective_id: row.get::<_, Option<i64>>(2)?.map(ObjectiveId),
        kind: row.get(3)?,
        why: row.get(4)?,
        due_at: number(5)?,
        local_time: row.get(6)?,
        time_zone: row.get(7)?,
        state: row.get(8)?,
        attempts: number(9)?,
        version: number(10)?,
        set_by: row.get(11)?,
    })
}

/// Adds a task. A second open check for the same objective is refused by the database.
pub(super) fn insert_task(
    tx: &Transaction,
    user: UserId,
    chat: ChatId,
    objective: Option<ObjectiveId>,
    task: &NewTask,
    at: u64,
) -> Result<TaskId, StoreError> {
    let added = tx.execute(
        "INSERT INTO agent_tasks (user_id, chat_id, objective_id, kind, why, due_at, local_time, time_zone, set_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![
            user.0,
            chat.0,
            objective.map(|id| id.0),
            task.kind,
            task.why,
            seconds(task.due_at),
            task.local_time,
            task.time_zone,
            task.set_by,
            seconds(at)
        ],
    );
    match added {
        Ok(_) => Ok(TaskId(tx.last_insert_rowid())),
        Err(rusqlite::Error::SqliteFailure(failure, _))
            if failure.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
        {
            Err(StoreError::DuplicateCheck)
        }
        Err(error) => Err(error.into()),
    }
}

impl Store {
    /// Jet's tasks for the user: the open ones first, soonest first, then the rest.
    pub(crate) fn agent_tasks(&self, owner: UserId) -> Result<Vec<AgentTask>, StoreError> {
        self.with(|db| {
            let mut query = db.prepare(&format!(
                "SELECT {COLUMNS} FROM agent_tasks WHERE user_id = ?1
                 ORDER BY state IN ('scheduled', 'running') DESC, due_at, id"
            ))?;
            query.query_map([owner.0], read)?.collect()
        })
    }

    /// The newest runs of the user's tasks, newest first.
    pub(crate) fn task_runs(&self, owner: UserId, limit: usize) -> Result<Vec<Run>, StoreError> {
        let rows: Vec<(Run, String)> = self.with(|db| {
            let mut query = db.prepare(
                "SELECT r.id, r.task_id, r.started_at, r.ended_at, r.outcome, r.found, r.tokens, r.sources_read
                 FROM task_runs r JOIN agent_tasks t ON t.id = r.task_id
                 WHERE t.user_id = ?1 ORDER BY r.id DESC LIMIT ?2",
            )?;
            query
                .query_map(
                    params![owner.0, i64::try_from(limit).unwrap_or(i64::MAX)],
                    |row| {
                        let run = Run {
                            id: RunId(row.get(0)?),
                            task_id: TaskId(row.get(1)?),
                            started_at: row.get::<_, i64>(2)?.unsigned_abs(),
                            ended_at: row.get::<_, Option<i64>>(3)?.map(i64::unsigned_abs),
                            outcome: row.get(4)?,
                            found: row.get(5)?,
                            sources_read: Vec::new(),
                            tokens: row.get::<_, Option<i64>>(6)?.map(i64::unsigned_abs),
                        };
                        Ok((run, row.get(7)?))
                    },
                )?
                .collect()
        })?;
        rows.into_iter()
            .map(|(mut run, sources)| {
                run.sources_read = super::from_json("the sources of a run", &sources)?;
                Ok(run)
            })
            .collect()
    }

    /// Sets the objective's check for `task`: moves the open one when it waits, or adds one.
    pub(crate) fn schedule_check(
        &self,
        owner: UserId,
        objective: ObjectiveId,
        task: &NewTask,
        at: u64,
    ) -> Result<Scheduled, StoreError> {
        self.try_with(|db| {
            let tx = db.transaction()?;
            let found: Option<(i64, String)> = tx
                .query_row(
                    "SELECT chat_id, status FROM objectives WHERE id = ?1 AND user_id = ?2",
                    params![objective.0, owner.0],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((chat, status)) = found else {
                return Ok(Scheduled::NoObjective);
            };
            if !matches!(status.as_str(), "active" | "paused") {
                return Ok(Scheduled::NoObjective);
            }
            let open: Option<(i64, TaskState)> = tx
                .query_row(
                    "SELECT id, state FROM agent_tasks
                     WHERE objective_id = ?1 AND kind = 'check' AND state IN ('scheduled', 'running')",
                    [objective.0],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let scheduled = match open {
                Some((id, TaskState::Running)) => return Ok(Scheduled::Running(TaskId(id))),
                Some((id, _)) => {
                    tx.execute(
                        "UPDATE agent_tasks SET why = ?2, due_at = ?3, local_time = ?4, time_zone = ?5,
                         set_by = ?6, version = version + 1, updated_at = ?7 WHERE id = ?1",
                        params![
                            id,
                            task.why,
                            seconds(task.due_at),
                            task.local_time,
                            task.time_zone,
                            task.set_by,
                            seconds(at)
                        ],
                    )?;
                    Scheduled::Moved(TaskId(id))
                }
                None => {
                    let id = insert_task(&tx, owner, ChatId(chat), Some(objective), task, at)?;
                    Scheduled::Added(id)
                }
            };
            tx.commit()?;
            Ok(scheduled)
        })
    }

    /// Adds a task that belongs to no objective, to land in `chat`.
    pub(crate) fn add_follow_up(
        &self,
        owner: UserId,
        chat: ChatId,
        task: &NewTask,
    ) -> Result<TaskId, StoreError> {
        self.try_with(|db| {
            let tx = db.transaction()?;
            let id = insert_task(&tx, owner, chat, None, task, 0)?;
            tx.commit()?;
            Ok(id)
        })
    }

    /// Cancels a task that waits. A running or finished one is left alone.
    pub(crate) fn cancel_task(
        &self,
        owner: UserId,
        id: TaskId,
        at: u64,
    ) -> Result<CancelOutcome, StoreError> {
        self.with(|db| {
            let changed = db.execute(
                "UPDATE agent_tasks SET state = 'cancelled', version = version + 1, updated_at = ?3
                 WHERE id = ?1 AND user_id = ?2 AND state = 'scheduled'",
                params![id.0, owner.0, seconds(at)],
            )?;
            if changed == 1 {
                return Ok(CancelOutcome::Cancelled);
            }
            let state: Option<TaskState> = db
                .query_row(
                    "SELECT state FROM agent_tasks WHERE id = ?1 AND user_id = ?2",
                    params![id.0, owner.0],
                    |row| row.get(0),
                )
                .optional()?;
            Ok(state.map_or(CancelOutcome::Missing, CancelOutcome::NotWaiting))
        })
    }

    /// Takes a due task for one run: only one caller gets it. `None` when it is not waiting, or
    /// is not due yet.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the step that runs checks calls it")
    )]
    pub(crate) fn claim_task(&self, id: TaskId, now: u64) -> Result<Option<RunId>, StoreError> {
        self.try_with(|db| {
            let tx = db.transaction()?;
            let changed = tx.execute(
                "UPDATE agent_tasks SET state = 'running', attempts = attempts + 1, version = version + 1,
                 updated_at = ?2 WHERE id = ?1 AND state = 'scheduled' AND due_at <= ?2",
                params![id.0, seconds(now)],
            )?;
            if changed == 0 {
                return Ok(None);
            }
            tx.execute(
                "INSERT INTO task_runs (task_id, started_at) VALUES (?1, ?2)",
                params![id.0, seconds(now)],
            )?;
            let run = RunId(tx.last_insert_rowid());
            tx.commit()?;
            Ok(Some(run))
        })
    }

    /// Ends a run and moves its task to the state the run leaves it in. `false` when the task is
    /// no longer running, because something else changed it: the run is then not recorded.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the step that runs checks calls it")
    )]
    pub(crate) fn finish_run(
        &self,
        run: RunId,
        finished: &Finished,
        at: u64,
    ) -> Result<bool, StoreError> {
        let sources = super::to_json(&finished.sources_read)?;
        self.try_with(|db| {
            let tx = db.transaction()?;
            let changed = tx.execute(
                "UPDATE agent_tasks SET state = ?2, version = version + 1, updated_at = ?3
                 WHERE state = 'running' AND id = (SELECT task_id FROM task_runs WHERE id = ?1)",
                params![run.0, finished.task, seconds(at)],
            )?;
            if changed == 0 {
                return Ok(false);
            }
            tx.execute(
                "UPDATE task_runs SET ended_at = ?2, outcome = ?3, found = ?4, sources_read = ?5, tokens = ?6
                 WHERE id = ?1",
                params![
                    run.0,
                    seconds(at),
                    finished.outcome,
                    finished.found,
                    sources,
                    finished.tokens.map(seconds)
                ],
            )?;
            tx.commit()?;
            Ok(true)
        })
    }

    /// Moves a waiting task to a later time, as the user's own choice. A running or finished
    /// task is left alone.
    pub(crate) fn snooze_task(
        &self,
        owner: UserId,
        id: TaskId,
        (due_at, local_time, time_zone): (u64, &str, &str),
        at: u64,
    ) -> Result<Snoozed, StoreError> {
        self.with(|db| {
            let changed = db.execute(
                "UPDATE agent_tasks SET due_at = ?3, local_time = ?4, time_zone = ?5, set_by = 'user',
                 version = version + 1, updated_at = ?6
                 WHERE id = ?1 AND user_id = ?2 AND state = 'scheduled'",
                params![id.0, owner.0, seconds(due_at), local_time, time_zone, seconds(at)],
            )?;
            if changed == 1 {
                return Ok(Snoozed::Moved);
            }
            let state: Option<TaskState> = db
                .query_row(
                    "SELECT state FROM agent_tasks WHERE id = ?1 AND user_id = ?2",
                    params![id.0, owner.0],
                    |row| row.get(0),
                )
                .optional()?;
            Ok(state.map_or(Snoozed::Missing, Snoozed::NotWaiting))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{NewObjective, ObjectiveChat, test_store};

    #[test]
    fn one_open_check_per_objective() {
        let (_dir, store, ada, _) = test_store();
        let chat = store.main_chat(ada).unwrap().id;
        let check = NewTask {
            kind: TaskKind::Check,
            why: "look",
            due_at: 2_000_000_000,
            local_time: "2033-05-18T03:33",
            time_zone: "UTC",
            set_by: SetBy::Jet,
        };
        let created = store
            .create_objective(&NewObjective {
                user: ada,
                agreed_in: chat,
                chat: ObjectiveChat::This,
                title: "T",
                deliverable: "D",
                start: "2033-01-01",
                due: "2033-02-01",
                steps: &[],
                sources: &[],
                check: check.clone(),
                summary: "",
                line: "",
                at: 1,
            })
            .unwrap();
        let second = store.try_with(|db| {
            let tx = db.transaction()?;
            insert_task(&tx, ada, chat, Some(created.objective), &check, 1).map(drop)
        });
        assert!(
            matches!(second, Err(StoreError::DuplicateCheck)),
            "{second:?}"
        );
        // A follow-up is not a check, and a finished check frees the place.
        store
            .add_follow_up(
                ada,
                chat,
                &NewTask {
                    kind: TaskKind::FollowUp,
                    ..check.clone()
                },
            )
            .unwrap();
        let open = store.agent_tasks(ada).unwrap();
        store.cancel_task(ada, open[0].id, 2).unwrap();
        let moved = store
            .schedule_check(ada, created.objective, &check, 3)
            .unwrap();
        assert!(matches!(moved, Scheduled::Added(_)), "{moved:?}");
    }
}
