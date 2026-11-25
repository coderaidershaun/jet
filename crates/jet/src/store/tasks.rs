//! What Jet sets itself to do (agent-tasks) and the runs that did it. A task is a check of one
//! objective, at most one open at a time, or a follow-up in a chat.

use super::chats::insert_entry;
use super::text_enum::text_enum;
use super::{ChatId, ObjectiveId, Store, StoreError, UserId, seconds};
use agent::{CheckIn, Entry, NewEntry};
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
    #[serde(skip)]
    pub(crate) user: UserId,
    pub(crate) created_at: u64,
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

#[derive(Debug, Clone, PartialEq, Serialize)]
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
    /// What the provider charged, for the providers that say.
    #[serde(rename = "cost")]
    pub(crate) cost_usd: Option<f64>,
    /// The check-in this run posted, or the notice it left.
    pub(crate) entry_id: Option<u64>,
}

/// The versions of the task and the objective that a check read when it began.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Versions {
    pub(crate) task: u64,
    pub(crate) objective: Option<(ObjectiveId, u64)>,
}

/// What becomes of the task when its run ends.
pub(crate) enum TaskEnd<'a> {
    /// The task is finished, and `next` is the task that follows it.
    Done(Option<NewTask<'a>>),
    /// The task waits again at the time `with` holds. `counted` says whether this run was an
    /// attempt; a run that was not one leaves the count as it was.
    Wait {
        with: NewTask<'a>,
        counted: bool,
    },
    Failed,
    Cancelled,
}

/// Everything one run leaves behind, applied together or not at all.
pub(crate) struct Settled<'a> {
    pub(crate) run: RunId,
    /// `None` skips the version check, for a run that no check read the facts of.
    pub(crate) seen: Option<Versions>,
    pub(crate) outcome: RunOutcome,
    pub(crate) found: &'a str,
    pub(crate) sources_read: &'a [String],
    pub(crate) tokens: Option<u64>,
    pub(crate) cost_usd: Option<f64>,
    /// The entry of Jet for the chat. It is marked as written by this task and run.
    pub(crate) entry: Option<NewEntry>,
    pub(crate) end: TaskEnd<'a>,
    pub(crate) at: u64,
}

/// Why a result was not applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Stale {
    /// The task is no longer running under this run, or its version moved. The run is recorded
    /// as stale and the task keeps the change that was made to it.
    Task,
    /// Only the objective changed. Nothing was written.
    Objective,
}

#[derive(Debug)]
pub(crate) enum Settlement {
    Applied(Option<Box<Entry>>),
    Stale(Stale),
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

const COLUMNS: &str = "id, chat_id, objective_id, kind, why, due_at, local_time, time_zone, state, attempts, version, set_by, user_id, created_at";

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
        user: UserId(row.get(12)?),
        created_at: number(13)?,
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
                "SELECT r.id, r.task_id, r.started_at, r.ended_at, r.outcome, r.found, r.tokens, r.sources_read,
                        r.cost_usd, r.entry_id
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
                            cost_usd: row.get(8)?,
                            entry_id: row.get::<_, Option<i64>>(9)?.map(i64::unsigned_abs),
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

    /// The waiting tasks of every user that are due, the one that fell due first at the front.
    pub(crate) fn due_tasks(&self, now: u64) -> Result<Vec<AgentTask>, StoreError> {
        self.with(|db| {
            let mut query = db.prepare(&format!(
                "SELECT {COLUMNS} FROM agent_tasks WHERE state = 'scheduled' AND due_at <= ?1
                 ORDER BY due_at, id"
            ))?;
            query.query_map([seconds(now)], read)?.collect()
        })
    }

    /// When the first waiting task that is not yet due falls due, if one waits. A task that is due
    /// already and waits for a reply is not counted: the end of the reply wakes the scheduler.
    pub(crate) fn next_due(&self, now: u64) -> Result<Option<u64>, StoreError> {
        self.with(|db| {
            db.query_row(
                "SELECT min(due_at) FROM agent_tasks WHERE state = 'scheduled' AND due_at > ?1",
                [seconds(now)],
                |row| row.get::<_, Option<i64>>(0),
            )
            .map(|due| due.map(i64::unsigned_abs))
        })
    }

    pub(crate) fn task(&self, id: TaskId) -> Result<Option<AgentTask>, StoreError> {
        self.with(|db| {
            db.query_row(
                &format!("SELECT {COLUMNS} FROM agent_tasks WHERE id = ?1"),
                [id.0],
                read,
            )
            .optional()
        })
    }

    /// The tasks that are running, each with the run that started it. After a restart these are
    /// the runs that were cut off.
    pub(crate) fn running_tasks(&self) -> Result<Vec<(AgentTask, RunId)>, StoreError> {
        self.with(|db| {
            let mut query = db.prepare(&format!(
                "SELECT {COLUMNS}, (SELECT max(r.id) FROM task_runs r WHERE r.task_id = agent_tasks.id AND r.ended_at IS NULL)
                 FROM agent_tasks WHERE state = 'running' ORDER BY id"
            ))?;
            query
                .query_map([], |row| Ok((read(row)?, RunId(row.get(14)?))))?
                .collect()
        })
    }

    /// How the task's finished runs ended, the newest first.
    pub(crate) fn past_outcomes(&self, task: TaskId) -> Result<Vec<RunOutcome>, StoreError> {
        self.with(|db| {
            let mut query = db.prepare(
                "SELECT outcome FROM task_runs WHERE task_id = ?1 AND outcome IS NOT NULL ORDER BY id DESC",
            )?;
            query.query_map([task.0], |row| row.get(0))?.collect()
        })
    }

    /// Ends a run and applies what it leaves behind in one transaction: the entry of Jet, the run
    /// record and what becomes of the task, with the next task. It applies only while the task is
    /// still running under this run and neither the task nor the objective changed since the
    /// check read them; anything else is dropped as stale. A task of a closed objective is never
    /// set back to waiting.
    pub(crate) fn settle(&self, settled: Settled) -> Result<Settlement, StoreError> {
        let sources = super::to_json(&settled.sources_read)?;
        self.try_with(|db| {
            let tx = db.transaction()?;
            let at = seconds(settled.at);
            let row: Option<Running> = tx
                .query_row(
                    "SELECT t.id, t.user_id, t.chat_id, t.objective_id, t.state, t.version, t.attempts
                     FROM task_runs r JOIN agent_tasks t ON t.id = r.task_id
                     WHERE r.id = ?1 AND r.ended_at IS NULL",
                    [settled.run.0],
                    |row| {
                        Ok(Running {
                            task: row.get(0)?,
                            user: row.get(1)?,
                            chat: row.get(2)?,
                            objective: row.get(3)?,
                            state: row.get(4)?,
                            version: row.get(5)?,
                            attempts: row.get(6)?,
                        })
                    },
                )
                .optional()?;
            let Some(Running {
                task,
                user,
                chat,
                objective,
                state,
                version,
                attempts,
            }) = row
            else {
                return Ok(Settlement::Stale(Stale::Task));
            };
            let task_moved = settled
                .seen
                .is_some_and(|seen| seen.task != version.unsigned_abs());
            if state != TaskState::Running || task_moved {
                tx.execute(
                    "UPDATE task_runs SET ended_at = ?2, outcome = 'stale', found = 'the task changed while the check ran' WHERE id = ?1",
                    params![settled.run.0, at],
                )?;
                tx.commit()?;
                return Ok(Settlement::Stale(Stale::Task));
            }
            let mut closed = false;
            if let Some(objective) = objective {
                let (current, status): (i64, String) = tx.query_row(
                    "SELECT version, status FROM objectives WHERE id = ?1",
                    [objective],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                closed = matches!(status.as_str(), "done" | "dropped");
                let seen = settled.seen.and_then(|seen| seen.objective);
                if seen.is_some_and(|(_, seen)| seen != current.unsigned_abs()) {
                    return Ok(Settlement::Stale(Stale::Objective));
                }
            }
            let entry = settled
                .entry
                .map(|mut entry| {
                    entry.check = Some(CheckIn {
                        task: task.unsigned_abs(),
                        run: settled.run.0.unsigned_abs(),
                    });
                    insert_entry(&tx, ChatId(chat), entry, agent::now_ms())
                })
                .transpose()?;
            if entry.as_ref().is_some_and(|entry| entry.colleague.is_some()) {
                tx.execute(
                    "UPDATE inbox_items SET state = 'seen' WHERE task_id = ?1 AND state = 'sent'",
                    [task],
                )?;
            }
            tx.execute(
                "UPDATE task_runs SET ended_at = ?2, outcome = ?3, found = ?4, sources_read = ?5, tokens = ?6,
                 cost_usd = ?7, entry_id = ?8 WHERE id = ?1",
                params![
                    settled.run.0,
                    at,
                    settled.outcome,
                    settled.found,
                    sources,
                    settled.tokens.map(seconds),
                    settled.cost_usd,
                    entry.as_ref().map(|entry| entry.id.number().cast_signed())
                ],
            )?;
            let end = match &settled.end {
                _ if closed => &TaskEnd::Cancelled,
                end => end,
            };
            match end {
                TaskEnd::Done(next) => {
                    set_state(&tx, task, "done", at)?;
                    if let Some(next) = next {
                        insert_task(&tx, UserId(user), ChatId(chat), objective.map(ObjectiveId), next, settled.at)?;
                    }
                }
                TaskEnd::Wait { with, counted } => {
                    tx.execute(
                        "UPDATE agent_tasks SET state = 'scheduled', why = ?2, due_at = ?3, local_time = ?4,
                         time_zone = ?5, set_by = ?6, attempts = ?7, version = version + 1, updated_at = ?8
                         WHERE id = ?1",
                        params![
                            task,
                            with.why,
                            seconds(with.due_at),
                            with.local_time,
                            with.time_zone,
                            with.set_by,
                            if *counted { attempts } else { (attempts - 1).max(0) },
                            at
                        ],
                    )?;
                }
                TaskEnd::Failed => {
                    set_state(&tx, task, "failed", at)?;
                }
                TaskEnd::Cancelled => {
                    set_state(&tx, task, "cancelled", at)?;
                }
            }
            tx.commit()?;
            Ok(Settlement::Applied(entry.map(Box::new)))
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

/// The task row of a run that is ending.
struct Running {
    task: i64,
    user: i64,
    chat: i64,
    objective: Option<i64>,
    state: TaskState,
    version: i64,
    attempts: i64,
}

fn set_state(tx: &Transaction, task: i64, state: &str, at: i64) -> rusqlite::Result<usize> {
    tx.execute(
        "UPDATE agent_tasks SET state = ?2, version = version + 1, updated_at = ?3 WHERE id = ?1",
        params![task, state, at],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Edit, NewObjective, ObjectiveStatus, test_store};

    /// An objective with one check due at 1000, and that check claimed and running.
    fn running_check() -> (
        tempfile::TempDir,
        Store,
        UserId,
        ObjectiveId,
        AgentTask,
        RunId,
    ) {
        let (dir, store, ada, _) = test_store();
        let chat = store.main_chat(ada).unwrap().id;
        let check = NewTask {
            kind: TaskKind::Check,
            why: "look",
            due_at: 1000,
            local_time: "1970-01-01T00:16",
            time_zone: "UTC",
            set_by: SetBy::Jet,
        };
        let created = store
            .create_objective(&NewObjective {
                user: ada,
                agreed_in: chat,
                title: "T",
                deliverable: "D",
                start: "2033-01-01",
                due: "2033-02-01",
                steps: &[],
                sources: &[],
                check,
                summary: "",
                line: "",
                at: 1,
            })
            .unwrap();
        let task = store.agent_tasks(ada).unwrap().remove(0);
        let run = store.claim_task(task.id, 1000).unwrap().unwrap();
        let task = store.task(task.id).unwrap().unwrap();
        (dir, store, ada, created.objective, task, run)
    }

    fn silent(run: RunId, seen: Versions, end: TaskEnd) -> Settled {
        Settled {
            run,
            seen: Some(seen),
            outcome: RunOutcome::Silent,
            found: "nothing new",
            sources_read: &[],
            tokens: Some(7),
            cost_usd: None,
            entry: None,
            end,
            at: 1001,
        }
    }

    #[test]
    fn claim_is_won_by_one_claimer() {
        let (_dir, store, ada, _, task, run) = running_check();
        assert_eq!((task.state, task.attempts), (TaskState::Running, 1));
        assert_eq!(store.running_tasks().unwrap()[0].1, run);
        let chat = store.main_chat(ada).unwrap().id;
        let follow_up = NewTask {
            kind: TaskKind::FollowUp,
            why: "look",
            due_at: 5,
            local_time: "x",
            time_zone: "UTC",
            set_by: SetBy::Jet,
        };
        let id = store.add_follow_up(ada, chat, &follow_up).unwrap();
        let claims: Vec<_> = (0..2)
            .map(|_| {
                let store = store.clone();
                std::thread::spawn(move || store.claim_task(id, 5).unwrap())
            })
            .map(|claimer| claimer.join().unwrap())
            .collect();
        assert_eq!(claims.iter().flatten().count(), 1, "{claims:?}");
        assert_eq!(store.claim_task(id, 5).unwrap(), None);
        assert_eq!(
            store.task_runs(ada, 10).unwrap().len(),
            2,
            "one run for each task"
        );
    }

    #[test]
    fn stale_commit_is_refused() {
        let version_of =
            |store: &Store, task: &AgentTask| store.task(task.id).unwrap().unwrap().version;
        for case in ["cancelled", "moved", "objective"] {
            let (_dir, store, ada, objective, task, run) = running_check();
            let seen = Versions {
                task: task.version,
                objective: Some((objective, 1)),
            };
            let next = NewTask {
                kind: TaskKind::Check,
                why: "later",
                due_at: 9000,
                local_time: "x",
                time_zone: "UTC",
                set_by: SetBy::Jet,
            };
            match case {
                "cancelled" => store
                    .with(|db| db.execute("UPDATE agent_tasks SET state = 'cancelled', version = version + 1", []))
                    .map(drop)
                    .unwrap(),
                "moved" => store
                    .with(|db| db.execute("UPDATE agent_tasks SET state = 'scheduled', due_at = 5000, version = version + 1", []))
                    .map(drop)
                    .unwrap(),
                _ => {
                    store
                        .edit_objective(ada, objective, &Edit { title: Some("New"), deliverable: None, status: None, sources: None }, 1001)
                        .unwrap();
                }
            }
            let before = version_of(&store, &task);
            let settlement = store
                .settle(silent(run, seen, TaskEnd::Done(Some(next))))
                .unwrap();
            let after = store.task(task.id).unwrap().unwrap();
            let runs = store.task_runs(ada, 5).unwrap();
            match case {
                "cancelled" => {
                    assert!(matches!(settlement, Settlement::Stale(Stale::Task)));
                    assert_eq!(after.state, TaskState::Cancelled);
                    assert_eq!(runs[0].outcome, Some(RunOutcome::Stale));
                }
                "moved" => {
                    assert!(matches!(settlement, Settlement::Stale(Stale::Task)));
                    assert_eq!((after.state, after.due_at), (TaskState::Scheduled, 5000));
                    assert_eq!(runs[0].outcome, Some(RunOutcome::Stale));
                }
                _ => {
                    assert!(matches!(settlement, Settlement::Stale(Stale::Objective)));
                    assert_eq!(after.state, TaskState::Running, "nothing was written");
                    assert_eq!(runs[0].outcome, None);
                }
            }
            assert_eq!(after.version, before, "{case}: the task was left as it was");
            assert_eq!(
                store.agent_tasks(ada).unwrap().len(),
                1,
                "{case}: no next task"
            );
        }
    }

    #[test]
    fn a_settled_check_of_a_closed_objective_is_never_set_back_to_waiting() {
        let (_dir, store, ada, objective, task, run) = running_check();
        store
            .close_objective(ada, objective, ObjectiveStatus::Done, None, 1001)
            .unwrap();
        let seen = Versions {
            task: task.version,
            objective: None,
        };
        let wait = NewTask {
            kind: TaskKind::Check,
            why: "again",
            due_at: 2000,
            local_time: "x",
            time_zone: "UTC",
            set_by: SetBy::Default,
        };
        store
            .settle(silent(
                run,
                seen,
                TaskEnd::Wait {
                    with: wait,
                    counted: true,
                },
            ))
            .unwrap();
        assert_eq!(
            store.task(task.id).unwrap().unwrap().state,
            TaskState::Cancelled
        );
    }

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
