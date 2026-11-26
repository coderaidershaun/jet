//! The task list: every task of a user, under a goal or under none, read from the `task_list` and
//! `task_list_goals` views and written in the user's one order, each write with what Jet is told.

use super::objectives::touch;
use super::pane::{Told, record_task_line};
use super::steps::insert_all;
use super::text_enum::text_enum;
use super::{
    ChatId, NewStep, ObjectiveId, ObjectiveStatus, StepId, Store, StoreError, UserId, seconds,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::Serialize;

text_enum!(ListState {
    NotStarted = "not_started",
    InProgress = "in_progress",
    Done = "done",
});

text_enum!(Day {
    Today = "today",
    Tomorrow = "tomorrow",
    Later = "later",
});

/// Today's and tomorrow's dates in the user's zone, `YYYY-MM-DD`, that a read is worked out with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Days {
    pub(crate) today: String,
    pub(crate) tomorrow: String,
}

impl Day {
    /// The day an open task dated `date` is in. A date that has passed is today's, carried over.
    pub(crate) fn of(date: Option<&str>, days: &Days) -> Self {
        // Dates in this form sort the way they run.
        match date {
            Some(date) if date <= days.today.as_str() => Self::Today,
            Some(date) if date == days.tomorrow => Self::Tomorrow,
            _ => Self::Later,
        }
    }
}

/// A task as the task list shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListTask {
    pub(crate) id: StepId,
    pub(crate) title: String,
    pub(crate) goal_id: Option<ObjectiveId>,
    pub(crate) goal_title: Option<String>,
    /// The chat a change of the task is told in: its goal's, or the main chat.
    pub(crate) chat_id: ChatId,
    pub(crate) date: Option<String>,
    /// `None` once the task is done.
    pub(crate) day: Option<Day>,
    /// True for an open task dated before today; `None` once the task is done.
    pub(crate) late: Option<bool>,
    pub(crate) state: ListState,
    pub(crate) started_at: Option<u64>,
    pub(crate) done_at: Option<u64>,
}

/// An open goal of the task list, with its tasks counted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListGoal {
    pub(crate) id: ObjectiveId,
    pub(crate) title: String,
    pub(crate) deliverable: String,
    pub(crate) chat_id: ChatId,
    pub(crate) due: String,
    /// Days from today to the due date; negative once it has passed.
    pub(crate) days_left: i64,
    pub(crate) status: ObjectiveStatus,
    pub(crate) state: ListState,
    pub(crate) tasks: u64,
    pub(crate) done: u64,
}

/// What one read of the task list gives.
#[derive(Debug)]
pub(crate) struct ListRead {
    pub(crate) main_chat: ChatId,
    pub(crate) goals: Vec<ListGoal>,
    /// The open tasks, in the user's order.
    pub(crate) tasks: Vec<ListTask>,
    /// The newest done tasks, newest first.
    pub(crate) done: Vec<ListTask>,
    /// Every done task the pile keeps.
    pub(crate) done_count: u64,
}

/// Why a write to the task list was refused. Nothing was written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Refused {
    TaskGone,
    GoalGone,
    GoalClosed,
    /// The task changed after it was read; read it again and work the change out anew.
    Changed,
}

/// Where a moved task goes among the open tasks of its day.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Place {
    First,
    Last,
    After(StepId),
}

/// Everything a change leaves on a task, worked out from the task as it was read.
pub(crate) struct TaskWrite<'a> {
    pub(crate) title: &'a str,
    pub(crate) goal: Option<ObjectiveId>,
    pub(crate) date: Option<&'a str>,
    pub(crate) started_at: Option<u64>,
    pub(crate) done_at: Option<u64>,
    /// `None` keeps the task's place.
    pub(crate) place: Option<Place>,
    /// The goals whose version the change raises, so a check that read them runs again.
    pub(crate) touch: &'a [ObjectiveId],
}

/// The users and goals whose tasks a purge deleted.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Purged {
    pub(crate) users: Vec<UserId>,
    pub(crate) goals: Vec<ObjectiveId>,
}

const COLUMNS: &str = "id, title, goal_id, goal_title, chat_id, date, state, started_at, done_at";

fn read_task(row: &rusqlite::Row, days: &Days) -> rusqlite::Result<ListTask> {
    let time = |at: usize| {
        row.get::<_, Option<i64>>(at)
            .map(|t| t.map(i64::unsigned_abs))
    };
    let date: Option<String> = row.get(5)?;
    let done_at = time(8)?;
    let open = done_at.is_none();
    Ok(ListTask {
        id: StepId(row.get(0)?),
        title: row.get(1)?,
        goal_id: row.get::<_, Option<i64>>(2)?.map(ObjectiveId),
        goal_title: row.get(3)?,
        chat_id: ChatId(row.get(4)?),
        day: open.then(|| Day::of(date.as_deref(), days)),
        late: open.then(|| {
            date.as_deref()
                .is_some_and(|date| date < days.today.as_str())
        }),
        date,
        state: row.get(6)?,
        started_at: time(7)?,
        done_at,
    })
}

fn find_task(
    db: &Connection,
    user: UserId,
    id: StepId,
    days: &Days,
) -> rusqlite::Result<Option<ListTask>> {
    db.query_row(
        &format!("SELECT {COLUMNS} FROM task_list WHERE id = ?1 AND user_id = ?2"),
        params![id.0, user.0],
        |row| read_task(row, days),
    )
    .optional()
}

fn done_tasks(
    db: &Connection,
    user: UserId,
    days: &Days,
    (since, before, limit): (u64, (i64, StepId), usize),
) -> rusqlite::Result<Vec<ListTask>> {
    db.prepare(&format!(
        "SELECT {COLUMNS} FROM task_list
         WHERE user_id = ?1 AND done_at > ?2 AND (done_at < ?3 OR (done_at = ?3 AND id < ?4))
         ORDER BY done_at DESC, id DESC LIMIT ?5"
    ))?
    .query_map(
        params![
            user.0,
            seconds(since),
            before.0,
            before.1.0,
            i64::try_from(limit).unwrap_or(i64::MAX)
        ],
        |row| read_task(row, days),
    )?
    .collect()
}

/// Refuses a goal that is not the user's, or is closed.
fn open_goal(
    db: &Connection,
    user: UserId,
    goal: ObjectiveId,
) -> rusqlite::Result<Option<Refused>> {
    let status: Option<ObjectiveStatus> = db
        .query_row(
            "SELECT status FROM objectives WHERE id = ?1 AND user_id = ?2",
            params![goal.0, user.0],
            |row| row.get(0),
        )
        .optional()?;
    Ok(match status {
        None => Some(Refused::GoalGone),
        Some(ObjectiveStatus::Done | ObjectiveStatus::Dropped) => Some(Refused::GoalClosed),
        Some(_) => None,
    })
}

/// Puts the task at its place among the open tasks of its day, and numbers the user's tasks from 1
/// again. A task of a closed goal that is not done is in no day.
fn place_task(
    tx: &Transaction,
    user: UserId,
    step: StepId,
    place: Place,
    days: &Days,
) -> rusqlite::Result<()> {
    let mut rows: Vec<(StepId, i64, Option<Day>)> = tx
        .prepare(
            "SELECT s.id, s.position, s.due_date,
                    s.done_at IS NULL AND (s.objective_id IS NULL OR o.status IN ('active', 'paused'))
             FROM objective_steps s LEFT JOIN objectives o ON o.id = s.objective_id
             WHERE s.user_id = ?1 ORDER BY s.position, s.id",
        )?
        .query_map([user.0], |row| {
            let date: Option<String> = row.get(2)?;
            let open: bool = row.get(3)?;
            Ok((
                StepId(row.get(0)?),
                row.get(1)?,
                open.then(|| Day::of(date.as_deref(), days)),
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let Some(at) = rows.iter().position(|row| row.0 == step) else {
        return Ok(());
    };
    let moved = rows.remove(at);
    let in_day = |row: &(StepId, i64, Option<Day>)| row.2.is_some() && row.2 == moved.2;
    let index = match place {
        Place::Last => rows.len(),
        Place::First => rows.iter().position(in_day).unwrap_or(rows.len()),
        Place::After(id) => rows
            .iter()
            .position(|row| row.0 == id && in_day(row))
            .map_or(rows.len(), |found| found + 1),
    };
    rows.insert(index, moved);
    for (position, (id, old, _)) in (1..).zip(&rows) {
        if *old != position {
            tx.execute(
                "UPDATE objective_steps SET position = ?2 WHERE id = ?1",
                params![id.0, position],
            )?;
        }
    }
    Ok(())
}

/// Reads the task again inside the write and refuses the write when it is gone or has changed.
fn unchanged(
    tx: &Transaction,
    user: UserId,
    before: &ListTask,
    days: &Days,
) -> rusqlite::Result<Option<Refused>> {
    Ok(match find_task(tx, user, before.id, days)? {
        None => Some(Refused::TaskGone),
        Some(now) if now != *before => Some(Refused::Changed),
        Some(_) => None,
    })
}

impl Store {
    /// The user's open goals and tasks, and the newest `page` done tasks of those done after
    /// `done_since`, all in one read.
    pub(crate) fn task_list(
        &self,
        user: UserId,
        days: &Days,
        (done_since, page): (u64, usize),
    ) -> Result<ListRead, StoreError> {
        self.with(|db| {
            let main_chat = db.query_row(
                "SELECT id FROM chats WHERE user_id = ?1 AND kind = 'main'",
                [user.0],
                |row| Ok(ChatId(row.get(0)?)),
            )?;
            let goals = db
                .prepare(
                    "SELECT id, title, deliverable, chat_id, due,
                            CAST(julianday(due) - julianday(?2) AS INTEGER), status, state, tasks, done
                     FROM task_list_goals WHERE user_id = ?1 ORDER BY due, id",
                )?
                .query_map(params![user.0, days.today], |row| {
                    Ok(ListGoal {
                        id: ObjectiveId(row.get(0)?),
                        title: row.get(1)?,
                        deliverable: row.get(2)?,
                        chat_id: ChatId(row.get(3)?),
                        due: row.get(4)?,
                        days_left: row.get(5)?,
                        status: row.get(6)?,
                        state: row.get(7)?,
                        tasks: row.get::<_, i64>(8)?.unsigned_abs(),
                        done: row.get::<_, i64>(9)?.unsigned_abs(),
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            let tasks = db
                .prepare(&format!(
                    "SELECT {COLUMNS} FROM task_list WHERE user_id = ?1 AND done_at IS NULL
                     ORDER BY position, id"
                ))?
                .query_map([user.0], |row| read_task(row, days))?
                .collect::<rusqlite::Result<_>>()?;
            let newest = (i64::MAX, StepId(i64::MAX));
            let done = done_tasks(db, user, days, (done_since, newest, page))?;
            let done_count: i64 = db.query_row(
                "SELECT count(*) FROM task_list WHERE user_id = ?1 AND done_at > ?2",
                params![user.0, seconds(done_since)],
                |row| row.get(0),
            )?;
            Ok(ListRead {
                main_chat,
                goals,
                tasks,
                done,
                done_count: done_count.unsigned_abs(),
            })
        })
    }

    /// The next done tasks after the pair `before` (done at, id), newest first, of those done
    /// after `done_since`: at most `limit`.
    pub(crate) fn done_tasks(
        &self,
        user: UserId,
        days: &Days,
        (done_since, before, limit): (u64, (u64, StepId), usize),
    ) -> Result<Vec<ListTask>, StoreError> {
        self.with(|db| {
            done_tasks(
                db,
                user,
                days,
                (done_since, (seconds(before.0), before.1), limit),
            )
        })
    }

    /// The user's task as the list shows it; `None` when the list does not show it.
    pub(crate) fn list_task(
        &self,
        user: UserId,
        id: StepId,
        days: &Days,
    ) -> Result<Option<ListTask>, StoreError> {
        self.with(|db| find_task(db, user, id, days))
    }

    /// Adds a task last in the user's order, under `goal` or under none.
    pub(crate) fn add_list_task(
        &self,
        user: UserId,
        (step, goal): (&NewStep, Option<ObjectiveId>),
        told: Option<&Told>,
        at: u64,
    ) -> Result<Result<StepId, Refused>, StoreError> {
        self.try_with(|db| {
            let tx = db.transaction()?;
            if let Some(goal) = goal {
                if let Some(refused) = open_goal(&tx, user, goal)? {
                    return Ok(Err(refused));
                }
                touch(&tx, user, goal, at)?;
            }
            let id = insert_all(&tx, user, goal, std::slice::from_ref(step))?;
            if let Some(told) = told {
                record_task_line(&tx, user, id, told, at)?;
            }
            tx.commit()?;
            Ok(Ok(id))
        })
    }

    /// Writes `write` over the task, as long as it is still as `before` shows it.
    pub(crate) fn change_list_task(
        &self,
        user: UserId,
        (before, write): (&ListTask, &TaskWrite),
        (days, told): (&Days, Option<&Told>),
        at: u64,
    ) -> Result<Result<(), Refused>, StoreError> {
        self.try_with(|db| {
            let tx = db.transaction()?;
            if let Some(refused) = unchanged(&tx, user, before, days)? {
                return Ok(Err(refused));
            }
            if let Some(goal) = write.goal.filter(|goal| Some(*goal) != before.goal_id)
                && let Some(refused) = open_goal(&tx, user, goal)?
            {
                return Ok(Err(refused));
            }
            tx.execute(
                "UPDATE objective_steps SET title = ?2, objective_id = ?3, due_date = ?4,
                     started_at = ?5, done_at = ?6
                 WHERE id = ?1",
                params![
                    before.id.0,
                    write.title,
                    write.goal.map(|goal| goal.0),
                    write.date,
                    write.started_at.map(seconds),
                    write.done_at.map(seconds)
                ],
            )?;
            if let Some(place) = write.place {
                place_task(&tx, user, before.id, place, days)?;
            }
            for goal in write.touch {
                touch(&tx, user, *goal, at)?;
            }
            if let Some(told) = told {
                record_task_line(&tx, user, before.id, told, at)?;
            }
            tx.commit()?;
            Ok(Ok(()))
        })
    }

    /// Deletes the task, as long as it is still as `before` shows it, and raises its goal's
    /// version.
    pub(crate) fn delete_list_task(
        &self,
        user: UserId,
        before: &ListTask,
        (days, told): (&Days, &Told),
        at: u64,
    ) -> Result<Result<(), Refused>, StoreError> {
        self.try_with(|db| {
            let tx = db.transaction()?;
            if let Some(refused) = unchanged(&tx, user, before, days)? {
                return Ok(Err(refused));
            }
            tx.execute("DELETE FROM objective_steps WHERE id = ?1", [before.id.0])?;
            if let Some(goal) = before.goal_id {
                touch(&tx, user, goal, at)?;
            }
            record_task_line(&tx, user, before.id, told, at)?;
            tx.commit()?;
            Ok(Ok(()))
        })
    }

    /// Deletes the tasks done before `cutoff` that are under no goal, or under a goal closed before
    /// it. A task of a goal that is still open, and a task that is not done, stay.
    pub(crate) fn purge_task_list(&self, cutoff: u64) -> Result<Purged, StoreError> {
        self.with(|db| {
            let gone = db
                .prepare(
                    "DELETE FROM objective_steps
                     WHERE done_at IS NOT NULL AND done_at < ?1
                       AND (objective_id IS NULL OR objective_id IN (
                            SELECT id FROM objectives
                            WHERE status IN ('done', 'dropped') AND closed_at < ?1))
                     RETURNING user_id, objective_id",
                )?
                .query_map([seconds(cutoff)], |row| {
                    Ok((
                        UserId(row.get(0)?),
                        row.get::<_, Option<i64>>(1)?.map(ObjectiveId),
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut purged = Purged::default();
            for (user, goal) in gone {
                if !purged.users.contains(&user) {
                    purged.users.push(user);
                }
                if let Some(goal) = goal.filter(|goal| !purged.goals.contains(goal)) {
                    purged.goals.push(goal);
                }
            }
            Ok(purged)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::{MIGRATIONS, apply};
    use rusqlite::Connection;

    /// The number of rows of every table, by name.
    fn counts(db: &Connection) -> Vec<(String, i64)> {
        let names: Vec<String> = db
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        names
            .into_iter()
            .map(|name| {
                let count = db
                    .query_row(&format!("SELECT count(*) FROM \"{name}\""), [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                (name, count)
            })
            .collect()
    }

    type StepRow = (i64, i64, String, Option<String>, Option<i64>);

    fn steps(db: &Connection) -> Vec<StepRow> {
        db.prepare(
            "SELECT id, objective_id, title, due_date, done_at FROM objective_steps ORDER BY id",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
    }

    /// Runs 0014 on a database at 0013 and checks that it kept every row of every table, every
    /// step with its id, goal, title, date and done mark, each goal's order and every foreign key,
    /// and that new ids go on from the largest. Gives the row counts before and after.
    fn migrate_and_check(db: &mut Connection) -> Vec<(String, i64)> {
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 13);
        let before = counts(db);
        let old_steps = steps(db);
        let old_order: Vec<i64> = db
            .prepare(
                "SELECT s.id FROM objective_steps s JOIN objectives o ON o.id = s.objective_id
                 ORDER BY o.user_id, s.objective_id, s.position, s.id",
            )
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        // Only 0014: the migrations after it add tables of their own.
        apply(db, MIGRATIONS[13], 14).unwrap();

        let after = counts(db);
        let added: Vec<_> = after.iter().filter(|row| !before.contains(row)).collect();
        assert!(
            added.iter().all(|(name, _)| name == "sqlite_sequence"),
            "only sqlite_sequence is new: {added:?}"
        );
        assert_eq!(steps(db), old_steps, "every step is as it was");
        let new_order: Vec<i64> = db
            .prepare("SELECT id FROM objective_steps ORDER BY user_id, position, id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            new_order, old_order,
            "each user's order keeps each goal's order"
        );
        let owners: i64 = db
            .query_row(
                "SELECT count(*) FROM objective_steps s JOIN objectives o ON o.id = s.objective_id
                 WHERE s.user_id IS NOT o.user_id",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(owners, 0, "each step belongs to its objective's owner");
        let broken: i64 = db
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(broken, 0, "no foreign key is broken");
        let largest = old_steps.iter().map(|step| step.0).max().unwrap_or(0);
        let sequence: i64 = db
            .query_row(
                "SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'objective_steps'), 0)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sequence, largest, "the next id goes on from the largest");
        let tx = db.transaction().unwrap();
        tx.execute(
            "INSERT INTO objective_steps (user_id, position, title) SELECT id, 1, 'new' FROM users LIMIT 1",
            [],
        )
        .unwrap();
        assert_eq!(tx.last_insert_rowid(), largest + 1);
        drop(tx);
        after
    }

    fn database_at_0013() -> Connection {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        for (index, sql) in MIGRATIONS.iter().take(13).enumerate() {
            apply(&mut db, sql, index + 1).unwrap();
        }
        db
    }

    #[test]
    fn the_bundled_sqlite_runs_returning_and_window_functions() {
        let db = Connection::open_in_memory().unwrap();
        let version: String = db
            .query_row("SELECT sqlite_version()", [], |row| row.get(0))
            .unwrap();
        let parts: Vec<u32> = version
            .split('.')
            .map(|part| part.parse().unwrap())
            .collect();
        assert!(
            parts[..2] >= [3, 37][..],
            "{version} has STRICT, RETURNING and windows"
        );
        db.execute_batch("CREATE TABLE t (n INTEGER) STRICT; INSERT INTO t VALUES (2), (1);")
            .unwrap();
        let numbered: Vec<i64> = db
            .prepare("SELECT row_number() OVER (ORDER BY n) FROM t ORDER BY n")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(numbered, [1, 2]);
        let gone: i64 = db
            .query_row("DELETE FROM t WHERE n = 1 RETURNING n", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(gone, 1);
    }

    #[test]
    fn migration_0014_keeps_every_row_id_order_and_key() {
        let mut db = database_at_0013();
        db.execute_batch(
            "INSERT INTO users (id, email, display_name, password_hash) VALUES
                 (1, 'ada@example.com', 'Ada', 'x'), (2, 'bob@example.com', 'Bob', 'x');
             INSERT INTO chats (id, user_id, kind, created_at) VALUES
                 (1, 1, 'main', 0), (2, 2, 'main', 0), (3, 1, 'objective', 0), (4, 1, 'objective', 0), (5, 2, 'objective', 0);
             INSERT INTO objectives (id, user_id, chat_id, title, deliverable, start_date, due_date, status, created_at, updated_at, closed_at) VALUES
                 (7, 1, 4, 'Kite', 'A kite', '2026-01-01', '2026-02-01', 'active', 0, 0, NULL),
                 (3, 1, 3, 'Party', 'A party', '2026-01-01', '2026-02-01', 'done', 0, 0, 5),
                 (9, 2, 5, 'Hire', 'A hire', '2026-01-01', '2026-02-01', 'paused', 0, 0, NULL);
             INSERT INTO objective_steps (id, objective_id, position, title, due_date, done_at) VALUES
                 (12, 7, 2, 'Fly it', NULL, NULL),
                 (4, 7, 1, 'Build the frame', '2026-01-10', 100),
                 (5, 3, 1, 'Book the venue', NULL, 50),
                 (20, 9, 1, 'Write the brief', '2026-01-03', NULL),
                 (21, 9, 1, 'Interview', NULL, NULL),
                 (30, 7, 3, 'Gone', NULL, NULL);
             DELETE FROM objective_steps WHERE id = 30;
             INSERT INTO teams (id, name) VALUES (1, 'Kites');
             INSERT INTO objective_shares (objective_id, user_id) VALUES (7, 2);
             INSERT INTO objective_shares (objective_id, team_id) VALUES (9, 1);
             INSERT INTO pane_taps (user_id, chat_id, line, at) VALUES (1, 4, '[a tap]', 1);
             INSERT INTO agent_tasks (id, user_id, chat_id, objective_id, kind, why, due_at, local_time, time_zone, set_by, created_at, updated_at)
                 VALUES (1, 1, 4, 7, 'check', 'look', 10, '2026-01-02T09:00', 'UTC', 'jet', 0, 0);
             INSERT INTO task_runs (task_id, started_at) VALUES (1, 5);",
        )
        .unwrap();
        let after = migrate_and_check(&mut db);
        assert!(after.contains(&("objective_steps".to_owned(), 5)));
        let ada: Vec<(i64, i64)> = db
            .prepare("SELECT id, position FROM objective_steps WHERE user_id = 1 ORDER BY position")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            ada,
            [(5, 1), (4, 2), (12, 3)],
            "goal 3 first, then goal 7 in its order"
        );
        let tap: (Option<i64>, i64) = db
            .query_row("SELECT step_id, step_added FROM pane_taps", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(tap, (None, 0), "an old tap is about no task");
    }

    /// Runs the same check on a copy of a real data directory's database, named by
    /// `JET_MIGRATION_COPY`. Run it with `cargo test -- --ignored` on a copy, never the original.
    #[test]
    #[ignore = "needs a copy of a real database in JET_MIGRATION_COPY"]
    fn migration_0014_keeps_a_real_database_whole() {
        let path = std::env::var("JET_MIGRATION_COPY").expect("JET_MIGRATION_COPY names a copy");
        let mut db = Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        let before = counts(&db);
        let after = migrate_and_check(&mut db);
        for (name, is) in &after {
            let was = before.iter().find(|row| &row.0 == name).map(|row| row.1);
            println!("{name}: {was:?} -> {is}");
        }
    }
}
