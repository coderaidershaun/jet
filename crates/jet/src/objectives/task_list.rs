//! The rules of the task list: its days in the user's zone, the date a move gives a task, which
//! changes raise a goal's version, and the one line per changed task that Jet is told.

use super::{ObjectiveError, Objectives, WRITE_TRIES, time};
use crate::store::{
    ChatId, Day, Days, ListGoal, ListState, ListTask, NewStep, ObjectiveId, ObjectiveStatus, Place,
    Refused, StepId, StoreError, TaskWrite, Told, UserId,
};
use serde::{Deserialize, Deserializer, Serialize};

/// How long the done pile keeps a done task before the scheduler deletes it.
pub(crate) const DONE_KEPT_DAYS: u64 = 90;
const DAY_SECONDS: u64 = 24 * 60 * 60;
/// How many done tasks one read, or one page of the pile, carries.
const DONE_PAGE: usize = 100;
const TASK_TITLE_LIMIT: usize = 300;
const GOAL_TITLE_LIMIT: usize = 200;

/// Why a change from the task list was refused. Every refusal comes before the first write.
#[derive(Debug, thiserror::Error)]
pub(crate) enum TaskListError {
    #[error("The page sent a change Jet cannot read")]
    BadBody,
    #[error("A title needs 1 to {limit} characters")]
    BadTitle { limit: usize },
    #[error("That is not a day of the list")]
    BadDay,
    #[error("That is not a state of a task")]
    BadState,
    #[error("Nothing to change")]
    NothingToChange,
    #[error("That task is no longer in your list")]
    TaskGone,
    #[error("That goal is no longer in your list")]
    GoalGone,
    #[error("That goal is closed")]
    GoalClosed,
    #[error("The database failed")]
    Store(#[from] StoreError),
}

impl TaskListError {
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::BadBody => "badBody",
            Self::BadTitle { .. } => "badTitle",
            Self::BadDay => "badDay",
            Self::BadState => "badState",
            Self::NothingToChange => "nothingToChange",
            Self::TaskGone => "taskGone",
            Self::GoalGone => "goalGone",
            Self::GoalClosed => "goalClosed",
            Self::Store(_) => "store",
        }
    }

    /// The same refusal in the words of Jet's tools.
    pub(super) fn for_jet(self, goal: Option<ObjectiveId>, step: StepId) -> ObjectiveError {
        let goal = goal.map_or(0, |goal| goal.0);
        match self {
            Self::GoalGone => ObjectiveError::NoSuchObjective { id: goal },
            Self::GoalClosed => ObjectiveError::Closed { id: goal },
            Self::Store(error) => ObjectiveError::Store(error),
            _ => ObjectiveError::NoSuchStep { step: step.0 },
        }
    }
}

impl From<Refused> for TaskListError {
    fn from(refused: Refused) -> Self {
        match refused {
            Refused::TaskGone => Self::TaskGone,
            Refused::GoalGone => Self::GoalGone,
            Refused::GoalClosed => Self::GoalClosed,
            Refused::Changed => Self::Store(StoreError::Contended),
        }
    }
}

/// Reads a field that may be left out, so that a `null` in it is a value of its own.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    field: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(field).map(Some)
}

/// A task the page adds.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskAdd {
    title: String,
    day: String,
    goal_id: Option<i64>,
}

/// A change the page makes to one task. A field left out stays as it is; `goalId: null` means no
/// goal and `after: null` means first in the day.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskPatch {
    title: Option<String>,
    #[serde(default, deserialize_with = "present")]
    goal_id: Option<Option<i64>>,
    state: Option<String>,
    day: Option<String>,
    #[serde(default, deserialize_with = "present")]
    after: Option<Option<i64>>,
}

/// A change the page makes to one goal.
#[derive(Debug, Deserialize)]
pub(crate) struct GoalPatch {
    title: Option<String>,
    state: Option<String>,
}

/// What the page draws, and the answer of every write.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskList {
    /// `None` when the days are in UTC.
    time_zone: Option<String>,
    today: String,
    tomorrow: String,
    main_chat_id: ChatId,
    done_kept_days: u64,
    done_count: u64,
    /// The task a write touched.
    changed: Option<StepId>,
    goals: Vec<ListGoal>,
    tasks: Vec<ListTask>,
    done: Vec<ListTask>,
}

/// An older page of the done pile.
#[derive(Debug, Serialize)]
pub(crate) struct DonePage {
    done: Vec<ListTask>,
    more: bool,
}

/// A write's answer, and the goals whose viewers are told of it.
pub(crate) struct Written {
    pub(crate) list: TaskList,
    pub(crate) goals: Vec<ObjectiveId>,
}

/// How a change moves a task's status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mark {
    NotStarted,
    Started,
    Done,
    /// Done no more: back to started, or to not started when it never was.
    NotDone,
}

impl Mark {
    fn apply(
        self,
        (started, done): (Option<u64>, Option<u64>),
        now: u64,
    ) -> (Option<u64>, Option<u64>) {
        match self {
            Self::NotStarted => (None, None),
            Self::Started => (started.or(Some(now)), None),
            Self::Done => (started, done.or(Some(now))),
            Self::NotDone => (started, None),
        }
    }
}

fn progress((started, done): (Option<u64>, Option<u64>)) -> ListState {
    match (started, done) {
        (_, Some(_)) => ListState::Done,
        (Some(_), None) => ListState::InProgress,
        (None, None) => ListState::NotStarted,
    }
}

/// One change of a task, from the page or from Jet. A field left `None` stays as it is.
#[derive(Debug, Default)]
pub(crate) struct TaskEdit {
    pub(super) title: Option<String>,
    pub(super) goal: Option<Option<ObjectiveId>>,
    pub(super) mark: Option<Mark>,
    /// The date Jet sets for the task.
    pub(super) date: Option<String>,
    /// The day the page moves the task to.
    pub(super) day: Option<Day>,
    /// Where the page moves the task in its day: after this task, or first with `Some(None)`.
    pub(super) after: Option<Option<StepId>>,
}

impl TaskPatch {
    fn edit(self) -> Result<TaskEdit, TaskListError> {
        let edit = TaskEdit {
            title: self
                .title
                .as_deref()
                .map(|title| checked_title(title, TASK_TITLE_LIMIT).map(str::to_owned))
                .transpose()?,
            goal: self.goal_id.map(|goal| goal.map(ObjectiveId)),
            mark: self.state.as_deref().map(mark_named).transpose()?,
            date: None,
            day: self.day.as_deref().map(day_named).transpose()?,
            after: self.after.map(|after| after.map(StepId)),
        };
        let nothing = edit.title.is_none()
            && edit.goal.is_none()
            && edit.mark.is_none()
            && edit.day.is_none()
            && edit.after.is_none();
        if nothing {
            return Err(TaskListError::NothingToChange);
        }
        Ok(edit)
    }
}

fn checked_title(title: &str, limit: usize) -> Result<&str, TaskListError> {
    let title = title.trim();
    if (1..=limit).contains(&title.chars().count()) {
        Ok(title)
    } else {
        Err(TaskListError::BadTitle { limit })
    }
}

fn day_named(name: &str) -> Result<Day, TaskListError> {
    match name {
        "today" => Ok(Day::Today),
        "tomorrow" => Ok(Day::Tomorrow),
        "later" => Ok(Day::Later),
        _ => Err(TaskListError::BadDay),
    }
}

fn mark_named(name: &str) -> Result<Mark, TaskListError> {
    match name {
        "not_started" => Ok(Mark::NotStarted),
        "in_progress" => Ok(Mark::Started),
        "done" => Ok(Mark::Done),
        _ => Err(TaskListError::BadState),
    }
}

/// The date a task moved to `day` gets. A task moved to Today or Tomorrow takes that date, so a
/// carried task that is moved stops being carried. One moved to Later keeps its date when it is in
/// Later already, and has no date otherwise.
fn moved_date(day: Day, now: Day, date: Option<&str>, days: &Days) -> Option<String> {
    match day {
        Day::Today => Some(days.today.clone()),
        Day::Tomorrow => Some(days.tomorrow.clone()),
        Day::Later if now == Day::Later => date.map(str::to_owned),
        Day::Later => None,
    }
}

/// What a line says about one task.
struct TaskWords<'a> {
    id: StepId,
    title: &'a str,
    goal: Option<&'a str>,
    state: ListState,
    date: Option<&'a str>,
}

impl<'a> TaskWords<'a> {
    fn of(task: &'a ListTask) -> Self {
        Self {
            id: task.id,
            title: &task.title,
            goal: task.goal_title.as_deref(),
            state: task.state,
            date: task.date.as_deref(),
        }
    }

    /// ` of the goal "…"` for a task under a goal, and nothing for one under none.
    fn of_goal(&self) -> String {
        self.goal
            .map_or_else(String::new, |goal| format!(" of the goal \"{goal}\""))
    }
}

/// A goal in a line: `the goal "…"`, or `no goal`.
fn goal_words(goal: Option<&str>) -> String {
    goal.map_or_else(
        || "no goal".to_owned(),
        |goal| format!("the goal \"{goal}\""),
    )
}

/// A change the user made outside a chat, as the line Jet is told before their next message in
/// the chat it concerns. A line may be told days later, so it names dates, never "today".
enum TaskChange<'a> {
    /// The task as it is now; `added` while Jet has not heard of it.
    Task {
        task: TaskWords<'a>,
        added: bool,
    },
    /// The task moved out of the goal `from`.
    Left {
        task: TaskWords<'a>,
        from: Option<&'a str>,
    },
    Deleted {
        task: TaskWords<'a>,
    },
    GoalRenamed {
        old: &'a str,
        new: &'a str,
    },
    /// The goal was marked done with `open` of its tasks not done.
    GoalDone {
        title: &'a str,
        open: usize,
    },
}

impl TaskChange<'_> {
    fn line(&self) -> String {
        match self {
            Self::Task { task, added } => {
                let verb = if *added { "added" } else { "changed" };
                let state = match task.state {
                    ListState::NotStarted => "not started",
                    ListState::InProgress => "in progress",
                    ListState::Done => "done",
                };
                let date = task.date.map_or_else(
                    || "later, with no day".to_owned(),
                    |date| time::date(date).map_or_else(|_| date.to_owned(), time::in_words),
                );
                format!(
                    "[The user {verb} the task \"{}\" (step {}){} in their task list: {state}, for {date}.]",
                    task.title,
                    task.id.0,
                    task.of_goal()
                )
            }
            Self::Left { task, from } => format!(
                "[The user moved the task \"{}\" (step {}) from {} to {}.]",
                task.title,
                task.id.0,
                goal_words(*from),
                goal_words(task.goal)
            ),
            Self::Deleted { task } => format!(
                "[The user deleted the task \"{}\" (step {}){}.]",
                task.title,
                task.id.0,
                task.of_goal()
            ),
            Self::GoalRenamed { old, new } => {
                format!("[The user renamed the goal \"{old}\" to \"{new}\".]")
            }
            Self::GoalDone { title, open } => {
                let left = match open {
                    0 => String::new(),
                    open => format!(" {open} of its tasks were still open and left the list."),
                };
                format!(
                    "[The user marked the goal \"{title}\" done. Its waiting checks are cancelled.{left}]"
                )
            }
        }
    }
}

/// Whether a change is told to Jet: the page's are, Jet's own are not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Teller {
    Page,
    Jet,
}

impl Objectives {
    /// The user's zone as the list names it, and today and tomorrow there. A user whose zone the
    /// server does not know is shown the days of UTC.
    fn days(&self, user: UserId) -> Result<(Option<String>, Days), StoreError> {
        let known = self
            .store
            .time_zone(user)?
            .and_then(|name| time::zone(&name).ok().map(|zone| (name, zone)));
        let (name, zone) = known.map_or((None, jiff::tz::TimeZone::UTC), |(name, zone)| {
            (Some(name), zone)
        });
        let today = time::today(&zone, self.now());
        let tomorrow = today.tomorrow().unwrap_or(today);
        let days = Days {
            today: today.to_string(),
            tomorrow: tomorrow.to_string(),
        };
        Ok((name, days))
    }

    /// The time after which a done task stays in the pile.
    pub(crate) fn done_kept_since(&self) -> u64 {
        self.now().saturating_sub(DONE_KEPT_DAYS * DAY_SECONDS)
    }

    pub(crate) fn task_list(&self, user: UserId) -> Result<TaskList, TaskListError> {
        self.task_list_after(user, None)
    }

    fn task_list_after(
        &self,
        user: UserId,
        changed: Option<StepId>,
    ) -> Result<TaskList, TaskListError> {
        let (time_zone, days) = self.days(user)?;
        let read = self
            .store
            .task_list(user, &days, (self.done_kept_since(), DONE_PAGE))?;
        Ok(TaskList {
            time_zone,
            today: days.today,
            tomorrow: days.tomorrow,
            main_chat_id: read.main_chat,
            done_kept_days: DONE_KEPT_DAYS,
            done_count: read.done_count,
            changed,
            goals: read.goals,
            tasks: read.tasks,
            done: read.done,
        })
    }

    /// The done tasks older than the pair `before` (done at, id), newest first.
    pub(crate) fn done_page(
        &self,
        user: UserId,
        before: (u64, StepId),
    ) -> Result<DonePage, TaskListError> {
        let (_, days) = self.days(user)?;
        let mut done =
            self.store
                .done_tasks(user, &days, (self.done_kept_since(), before, DONE_PAGE + 1))?;
        let more = done.len() > DONE_PAGE;
        done.truncate(DONE_PAGE);
        Ok(DonePage { done, more })
    }

    /// The title and chat of the goal a task is under, or the main chat for a task under none.
    fn told_in(
        &self,
        user: UserId,
        goal: Option<ObjectiveId>,
    ) -> Result<(Option<String>, ChatId), TaskListError> {
        let Some(goal) = goal else {
            return Ok((None, self.store.main_chat(user)?.id));
        };
        let found = self
            .store
            .objective(user, goal)?
            .ok_or(TaskListError::GoalGone)?;
        match found.status {
            ObjectiveStatus::Done | ObjectiveStatus::Dropped => Err(TaskListError::GoalClosed),
            ObjectiveStatus::Active | ObjectiveStatus::Paused => {
                Ok((Some(found.title), found.chat_id))
            }
        }
    }

    /// Adds a task from the page, last in its day.
    pub(crate) fn add_task(&self, user: UserId, add: TaskAdd) -> Result<Written, TaskListError> {
        let title = checked_title(&add.title, TASK_TITLE_LIMIT)?;
        let day = day_named(&add.day)?;
        let goal = add.goal_id.map(ObjectiveId);
        let (goal_title, chat) = self.told_in(user, goal)?;
        let (_, days) = self.days(user)?;
        let date = moved_date(day, Day::Later, None, &days);
        let line = |id, _| {
            let task = TaskWords {
                id,
                title,
                goal: goal_title.as_deref(),
                state: ListState::NotStarted,
                date: date.as_deref(),
            };
            TaskChange::Task { task, added: true }.line()
        };
        let told = Told::Kept {
            chat,
            line: &line,
            is_add: true,
            left: None,
        };
        let step = NewStep {
            title: title.to_owned(),
            due: date.clone(),
        };
        let id = self.write(|| {
            self.store
                .add_list_task(user, (&step, goal), Some(&told), self.now())
        })??;
        Ok(Written {
            list: self.task_list_after(user, Some(id))?,
            goals: goal.into_iter().collect(),
        })
    }

    /// Changes one task from the page.
    pub(crate) fn change_task(
        &self,
        user: UserId,
        id: StepId,
        patch: TaskPatch,
    ) -> Result<Written, TaskListError> {
        let edit = patch.edit()?;
        let goals = self.edit_task(user, id, &edit, Teller::Page)?;
        Ok(Written {
            list: self.task_list_after(user, Some(id))?,
            goals,
        })
    }

    /// Changes one task by the rules of the list, and tells Jet when the page made the change.
    /// Gives the goals the task was and is under, whose viewers are told.
    pub(crate) fn edit_task(
        &self,
        user: UserId,
        id: StepId,
        edit: &TaskEdit,
        teller: Teller,
    ) -> Result<Vec<ObjectiveId>, TaskListError> {
        for _ in 0..WRITE_TRIES {
            let (_, days) = self.days(user)?;
            let before = self
                .store
                .list_task(user, id, &days)?
                .ok_or(TaskListError::TaskGone)?;
            if before.goal_id.is_some() {
                self.told_in(user, before.goal_id)?;
            }
            let goal = edit.goal.unwrap_or(before.goal_id);
            let (goal_title, chat) = match goal == before.goal_id {
                true => (before.goal_title.clone(), before.chat_id),
                false => self.told_in(user, goal)?,
            };
            let title = edit.title.as_deref().unwrap_or(&before.title);
            let was = (before.started_at, before.done_at);
            let (started_at, done_at) = edit.mark.map_or(was, |mark| mark.apply(was, self.now()));
            let now_in = Day::of(before.date.as_deref(), &days);
            let to = edit.day.unwrap_or(now_in);
            let is_move = edit.day.is_some() || edit.after.is_some();
            let date = match (&edit.date, is_move) {
                (Some(date), _) => Some(date.clone()),
                (None, true) => moved_date(to, now_in, before.date.as_deref(), &days),
                (None, false) => before.date.clone(),
            };
            let place = match edit.after {
                Some(None) => Some(Place::First),
                Some(Some(after)) => Some(Place::After(after)),
                None if to != now_in => Some(Place::Last),
                None => None,
            };
            let fields_changed = title != before.title
                || goal != before.goal_id
                || date != before.date
                || (started_at, done_at) != was;
            if !fields_changed && place.is_none() {
                return Ok(Vec::new());
            }
            let state = progress((started_at, done_at));
            let day = done_at.is_none().then(|| Day::of(date.as_deref(), &days));
            let is_told = teller == Teller::Page
                && (title != before.title
                    || goal != before.goal_id
                    || state != before.state
                    || day != before.day);
            let mut goals: Vec<ObjectiveId> = before.goal_id.into_iter().collect();
            goals.extend(goal.filter(|goal| Some(*goal) != before.goal_id));
            let touch: &[ObjectiveId] = if fields_changed { &goals } else { &[] };
            let words = |id| TaskWords {
                id,
                title,
                goal: goal_title.as_deref(),
                state,
                date: date.as_deref(),
            };
            let line = |id, added| {
                TaskChange::Task {
                    task: words(id),
                    added,
                }
                .line()
            };
            let left = (goal != before.goal_id).then(|| {
                let from = before.goal_title.as_deref();
                (
                    before.chat_id,
                    TaskChange::Left {
                        task: words(id),
                        from,
                    }
                    .line(),
                )
            });
            let told = is_told.then_some(Told::Kept {
                chat,
                line: &line,
                is_add: false,
                left,
            });
            let write = TaskWrite {
                title,
                goal,
                date: date.as_deref(),
                started_at,
                done_at,
                place,
                touch,
            };
            let written = self.write(|| {
                self.store.change_list_task(
                    user,
                    (&before, &write),
                    (&days, told.as_ref()),
                    self.now(),
                )
            })?;
            match written {
                Ok(()) => return Ok(goals),
                Err(Refused::Changed) => continue,
                Err(refused) => return Err(refused.into()),
            }
        }
        Err(StoreError::Contended.into())
    }

    /// Deletes one task from the page.
    pub(crate) fn delete_task(&self, user: UserId, id: StepId) -> Result<Written, TaskListError> {
        for _ in 0..WRITE_TRIES {
            let (_, days) = self.days(user)?;
            let before = self
                .store
                .list_task(user, id, &days)?
                .ok_or(TaskListError::TaskGone)?;
            let told = Told::Deleted {
                chat: before.chat_id,
                line: TaskChange::Deleted {
                    task: TaskWords::of(&before),
                }
                .line(),
            };
            let deleted = self.write(|| {
                self.store
                    .delete_list_task(user, &before, (&days, &told), self.now())
            })?;
            match deleted {
                Ok(()) => {
                    return Ok(Written {
                        list: self.task_list_after(user, None)?,
                        goals: before.goal_id.into_iter().collect(),
                    });
                }
                Err(Refused::Changed) => continue,
                Err(refused) => return Err(refused.into()),
            }
        }
        Err(StoreError::Contended.into())
    }

    /// Renames a goal from the page, marks it done, or both.
    pub(crate) fn change_goal(
        &self,
        user: UserId,
        id: ObjectiveId,
        patch: GoalPatch,
    ) -> Result<Written, TaskListError> {
        let title = patch
            .title
            .as_deref()
            .map(|title| checked_title(title, GOAL_TITLE_LIMIT))
            .transpose()?;
        let close = match patch.state.as_deref() {
            None => false,
            Some("done") => true,
            Some(_) => return Err(TaskListError::BadState),
        };
        if title.is_none() && !close {
            return Err(TaskListError::NothingToChange);
        }
        let (old, chat) = self.told_in(user, Some(id))?;
        let old = old.unwrap_or_default();
        let new = title.filter(|new| *new != old);
        let renamed = new.map(|new| TaskChange::GoalRenamed { old: &old, new }.line());
        let done = if close {
            let open = self
                .store
                .steps(user, id)?
                .iter()
                .filter(|step| step.done_at.is_none())
                .count();
            let title = title.unwrap_or(&old);
            Some(TaskChange::GoalDone { title, open }.line())
        } else {
            None
        };
        let rename = new
            .zip(renamed.as_deref())
            .map(|(new, line)| (new, Some((chat, line))));
        let close = done.as_deref().map(|line| Some((chat, line)));
        self.write(|| {
            self.store
                .rename_and_close(user, id, (rename, close), self.now())
        })?
        .ok_or(TaskListError::GoalGone)?;
        Ok(Written {
            list: self.task_list_after(user, None)?,
            goals: vec![id],
        })
    }

    /// Changes one of the user's steps for Jet: the step under `goal`, or a task under no goal.
    pub(crate) fn edit_step_for_jet(
        &self,
        user: UserId,
        (goal, step): (Option<ObjectiveId>, StepId),
        edit: &TaskEdit,
    ) -> Result<(), ObjectiveError> {
        self.edit_task(user, step, edit, Teller::Jet)
            .map(drop)
            .map_err(|error| error.for_jet(goal, step))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::test_store;
    use std::sync::Arc;

    #[test]
    fn a_change_and_its_line_commit_together() {
        let (dir, store, ada, _) = test_store();
        let objectives = Objectives::new(store, Arc::new(|| 1_767_225_600));
        let add = TaskAdd {
            title: "Call the bank".into(),
            day: "today".into(),
            goal_id: None,
        };
        let id = objectives.add_task(ada, add).unwrap().list.tasks[0].id;
        rusqlite::Connection::open(dir.path().join("jet.sqlite3"))
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER no_taps BEFORE INSERT ON pane_taps BEGIN SELECT RAISE(ABORT, 'full'); END",
            )
            .unwrap();
        let done = TaskPatch {
            state: Some("done".into()),
            ..TaskPatch::default()
        };
        assert!(objectives.change_task(ada, id, done).is_err());
        let list = objectives.task_list(ada).unwrap();
        assert_eq!(list.tasks[0].done_at, None, "the task was not marked done");
    }

    #[test]
    fn marks_move_the_status_as_the_page_and_jet_ask() {
        let (started, done) = (Some(5), Some(9));
        let rows = [
            (Mark::NotStarted, (started, done), (None, None)),
            (Mark::Started, (None, None), (Some(1), None)),
            (Mark::Started, (started, done), (started, None)),
            (Mark::Done, (started, None), (started, Some(1))),
            (Mark::Done, (None, done), (None, done)),
            (Mark::NotDone, (started, done), (started, None)),
        ];
        for (mark, was, is) in rows {
            assert_eq!(mark.apply(was, 1), is, "{mark:?} on {was:?}");
        }
    }

    #[test]
    fn a_move_dates_the_task_by_its_new_day() {
        let days = Days {
            today: "2026-11-25".into(),
            tomorrow: "2026-11-26".into(),
        };
        let carried = Some("2026-11-24");
        assert_eq!(
            moved_date(Day::Today, Day::Today, carried, &days).as_deref(),
            Some("2026-11-25"),
            "a carried task that is moved stops being carried"
        );
        assert_eq!(
            moved_date(Day::Tomorrow, Day::Today, carried, &days).as_deref(),
            Some("2026-11-26")
        );
        let friday = Some("2026-12-04");
        assert_eq!(
            moved_date(Day::Later, Day::Later, friday, &days).as_deref(),
            friday
        );
        assert_eq!(moved_date(Day::Later, Day::Today, carried, &days), None);
    }
}
