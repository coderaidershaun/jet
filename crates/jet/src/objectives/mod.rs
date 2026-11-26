//! The objectives a user is working towards and the tasks Jet sets itself: the rules above the
//! store. It turns the local dates and times Jet writes into stored ones, works out duration and
//! days left when they are read, and acts for one user only.

mod inbox;
mod pane;
mod sharing;
mod task_list;
mod time;

use crate::chat::TurnOwner;
use crate::scheduler::Signals;
use crate::store::{
    AgentTask, CancelOutcome, ChatId, Edit, NewNote, NewObjective, NewSource, NewStep, NewTask,
    Note, NoteStatus, Objective, ObjectiveId, ObjectiveStatus, Person, Run, Scheduled, SetBy,
    Source, Step, StepId, Store, StoreError, Tap, TaskId, TaskKind, TaskState, Team, UserId,
};
pub(crate) use inbox::InboxError;
pub(crate) use pane::Pane;
use serde::Serialize;
pub(crate) use sharing::{Directory, DirectoryChange};
use std::sync::Arc;
use task_list::TaskEdit;
pub(crate) use task_list::{
    DONE_KEPT_DAYS, DonePage, GoalPatch, Mark, TaskAdd, TaskList, TaskListError, TaskPatch, Written,
};
pub(crate) use time::TimeError;

/// How many of an objective's newest notes `list` shows.
const NOTES_SHOWN: usize = 10;
/// How many runs `tasks_list` shows.
const RUNS_SHOWN: usize = 20;
/// How many times a write is tried when the database is busy.
const WRITE_TRIES: usize = 3;
const UTC: &str = "UTC";
/// A check Jet sets for itself is at least this far away, so a confused model cannot loop.
const MIN_NEXT_CHECK_MINUTES: u64 = 10;
/// The longest name of a team, in characters.
const TEAM_NAME_LIMIT: usize = 60;

/// The current time in Unix seconds. Tests set their own.
pub(crate) type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// Whether `name` is an IANA time zone name that the server knows.
pub(crate) fn is_time_zone(name: &str) -> bool {
    time::zone(name).is_ok()
}

/// The clock a test sets: the host reads Unix seconds from this file each time it asks for the
/// time, and uses the real time while the file is missing or empty.
const TEST_CLOCK_VARIABLE: &str = "JET_TEST_CLOCK_FILE";

/// The clock of the file that `JET_TEST_CLOCK_FILE` names, when the host was started with one.
pub(crate) fn test_clock() -> Option<Clock> {
    let path = std::path::PathBuf::from(std::env::var_os(TEST_CLOCK_VARIABLE)?);
    let real = system_clock();
    Some(Arc::new(move || {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| text.trim().parse().ok())
            .unwrap_or_else(|| real())
    }))
}

pub(crate) fn system_clock() -> Clock {
    Arc::new(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_secs())
    })
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum ObjectiveError {
    #[error(
        "Jet does not know the user's time zone yet, because no message of theirs has carried it. Ask the user to send another message, then try again"
    )]
    NoTimeZone,
    #[error(transparent)]
    Time(#[from] TimeError),
    #[error(
        "the due date {due} is before the start date {start}; the objective's dates must run forwards"
    )]
    DatesBackwards { start: String, due: String },
    #[error("the user has no objective {id}; objectives_list shows their ids")]
    NoSuchObjective { id: i64 },
    #[error("the user has no step {step}; objectives_list shows the step ids")]
    NoSuchStep { step: i64 },
    #[error("objective {id} is closed and cannot be edited; create a new objective instead")]
    Closed { id: i64 },
    #[error(
        "the next check must be at least {MIN_NEXT_CHECK_MINUTES} minutes away, and {local} is sooner; pick a later time"
    )]
    CheckTooSoon { local: String },
    #[error("only a check that is running can record what it found")]
    NotOnACheck,
    #[error("the user has no task {id}; tasks_list shows their ids")]
    NoSuchTask { id: i64 },
    #[error("task {id} is {state}, so it cannot be cancelled")]
    TaskNotWaiting { id: i64, state: &'static str },
    #[error(
        "the open check of this objective is running now and cannot be moved; set the next one after it ends"
    )]
    CheckRunning,
    #[error("the command changes nothing; give a new start date, a new due date, or both")]
    NoNewDate,
    #[error("the command changes nothing; give the step a new title, a new due date, or both")]
    NothingToChange,
    #[error(
        "only the deployment's admin may name an app as a source, because an app reads one account for everyone. Leave it out, or ask the admin"
    )]
    AppSourceAdminOnly,
    #[error(
        "{tool} is not marked read-only by its app, and a source may only be read. Pick a tool that only reads, or leave this source out"
    )]
    AppToolNotReadOnly { tool: String },
    #[error("the user has no note {id} on that objective; objectives_list shows the note ids")]
    NoSuchNote { id: i64 },
    #[error("there is no user {id}; people_list shows the ids")]
    NoSuchUser { id: i64 },
    #[error("there is no team {id}; people_list shows the ids")]
    NoSuchTeam { id: i64 },
    #[error("only an admin may change the people and teams of the organisation")]
    NotAdmin,
    #[error("a team called `{name}` exists already")]
    TeamNameTaken { name: String },
    #[error("a team's name is between 1 and {TEAM_NAME_LIMIT} characters")]
    BadTeamName,
    #[error("a user cannot be their own manager")]
    ManagesSelf,
    #[error("an objective is not shared with its owner; leave the owner out")]
    ShareWithOwner,
    #[error(
        "the card would be empty: name someone to share with, or the objective is shared with nobody"
    )]
    NothingToShare,
    #[error("the user has no share card {id}")]
    NoSuchProposal { id: i64 },
    #[error("share card {id} is {state} and cannot be tapped")]
    ProposalNotOpen { id: i64, state: &'static str },
    #[error("a ticked person or team is not on the card")]
    NotOnCard,
    #[error("the database failed")]
    Store(#[from] StoreError),
}

impl ObjectiveError {
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::NoTimeZone => "noTimeZone",
            Self::Time(TimeError::Unreadable { .. }) => "badTime",
            Self::Time(TimeError::UnknownZone { .. }) => "badTimeZone",
            Self::Time(TimeError::DoesNotExist { .. }) => "timeDoesNotExist",
            Self::Time(TimeError::InThePast { .. }) => "timeInThePast",
            Self::DatesBackwards { .. } => "datesBackwards",
            Self::NoSuchObjective { .. } => "noSuchObjective",
            Self::Closed { .. } => "objectiveClosed",
            Self::NoSuchStep { .. } => "noSuchStep",
            Self::NoSuchTask { .. } => "noSuchTask",
            Self::TaskNotWaiting { .. } => "taskNotWaiting",
            Self::CheckTooSoon { .. } => "checkTooSoon",
            Self::NotOnACheck => "notOnACheck",
            Self::CheckRunning => "checkRunning",
            Self::AppSourceAdminOnly => "adminOnly",
            Self::AppToolNotReadOnly { .. } => "notReadOnly",
            Self::NoNewDate => "noNewDate",
            Self::NothingToChange => "nothingToChange",
            Self::NoSuchNote { .. } => "noSuchNote",
            Self::NoSuchUser { .. } => "noSuchUser",
            Self::NoSuchTeam { .. } => "noSuchTeam",
            Self::NotAdmin => "adminOnly",
            Self::TeamNameTaken { .. } => "teamNameTaken",
            Self::BadTeamName => "badTeamName",
            Self::ManagesSelf => "managesSelf",
            Self::ShareWithOwner => "shareWithOwner",
            Self::NothingToShare => "nothingToShare",
            Self::NoSuchProposal { .. } => "noSuchProposal",
            Self::ProposalNotOpen { .. } => "proposalNotOpen",
            Self::NotOnCard => "notOnCard",
            Self::Store(StoreError::DuplicateCheck) => "duplicateCheck",
            Self::Store(_) => "store",
        }
    }
}

/// A moment Jet picked, as the user's local time, and why.
pub(crate) struct Check {
    pub(crate) at: String,
    pub(crate) why: String,
}

pub(crate) struct Create {
    pub(crate) title: String,
    pub(crate) deliverable: String,
    /// Today when left out.
    pub(crate) start: Option<String>,
    pub(crate) due: String,
    pub(crate) steps: Vec<NewStep>,
    pub(crate) sources: Vec<NewSource>,
    pub(crate) first_check: Check,
}

/// A new title, a new due date, or both, for one step.
#[derive(Debug, Clone)]
pub(crate) struct StepChange {
    pub(crate) title: Option<String>,
    pub(crate) due: Option<String>,
}

pub(crate) struct Update {
    pub(crate) status: NoteStatus,
    pub(crate) moved: String,
    pub(crate) blockers: String,
    pub(crate) is_private: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ObjectiveView {
    #[serde(flatten)]
    pub(crate) objective: Objective,
    /// Days from the start date to the due date.
    duration_days: i64,
    /// Days from today, in the user's zone, to the due date; negative once it has passed.
    pub(crate) days_left: i64,
    pub(crate) steps: Vec<Step>,
    pub(crate) sources: Vec<Source>,
    /// The newest notes, oldest first.
    pub(crate) notes: Vec<Note>,
    /// The tasks that are waiting or running.
    tasks: Vec<AgentTask>,
}

/// What Jet is answered after a step command.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum StepAnswer {
    Objective(ObjectiveView),
    /// A task under no objective lives in the user's main chat, which the answer names.
    #[serde(untagged)]
    Loose {
        step: Step,
        chat: NamedChat,
    },
}

/// The id and the title of a chat, as an answer names it.
#[derive(Debug, Serialize)]
pub(crate) struct NamedChat {
    id: ChatId,
    title: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct TasksView {
    tasks: Vec<AgentTask>,
    runs: Vec<Run>,
}

#[derive(Clone)]
pub(crate) struct Objectives {
    store: Store,
    clock: Clock,
    /// Tells the scheduler that a task changed.
    signals: Signals,
}

impl Objectives {
    pub(crate) fn new(store: Store, clock: Clock) -> Self {
        Self {
            store,
            clock,
            signals: Signals::default(),
        }
    }

    pub(crate) fn with_signals(self, signals: Signals) -> Self {
        Self { signals, ..self }
    }

    /// The next check Jet picked for itself, at its local time `at`: the instant, the local time as
    /// written and the zone. It must be at least ten minutes away.
    pub(crate) fn next_check(
        &self,
        user: UserId,
        at: &str,
    ) -> Result<(u64, String, String), ObjectiveError> {
        let zone = self.zone_name(user)?;
        let earliest = self.now() + MIN_NEXT_CHECK_MINUTES * 60;
        match time::to_utc(at, &zone, earliest - 1) {
            Ok((due_at, local)) => Ok((due_at, local, zone)),
            Err(TimeError::InThePast { local, .. }) => Err(ObjectiveError::CheckTooSoon { local }),
            Err(error) => Err(error.into()),
        }
    }

    /// The user's local time at `at`, such as `Tue 24 Nov 2026, 09:00 (Europe/London)`, for words
    /// the user reads. A user whose zone the server does not know yet is shown in UTC.
    pub(crate) fn describe(&self, user: UserId, at: u64) -> Result<String, ObjectiveError> {
        let name = self
            .store
            .time_zone(user)?
            .unwrap_or_else(|| UTC.to_owned());
        Ok(time::describe(&name, at)?)
    }

    /// The local time `YYYY-MM-DDTHH:MM` of `at` in the user's zone, as a task keeps it.
    pub(crate) fn local_time(&self, zone: &str, at: u64) -> Result<String, ObjectiveError> {
        Ok(time::local(zone, at)?)
    }

    /// Every objective of the user, with its steps, sources, notes and open tasks.
    pub(crate) fn list(&self, user: UserId) -> Result<Vec<ObjectiveView>, ObjectiveError> {
        let tasks = self.store.agent_tasks(user)?;
        self.store
            .objectives(user)?
            .into_iter()
            .map(|objective| self.view(user, objective, &tasks))
            .collect()
    }

    pub(crate) fn create(
        &self,
        owner: TurnOwner,
        new: Create,
    ) -> Result<ObjectiveView, ObjectiveError> {
        let now = self.now();
        let zone = self.zone_name(owner.user)?;
        let today = time::today(&time::zone(&zone)?, now);
        let start = match &new.start {
            Some(start) => time::date(start)?,
            None => today,
        };
        let due = time::date(&new.due)?;
        let dates = format!("From {} to {}.", time::in_words(start), time::in_words(due));
        let (start, due) = (start.to_string(), due.to_string());
        check_forwards(&start, &due)?;
        let steps = checked_steps(new.steps.clone())?;
        let (due_at, local_time) = time::to_utc(&new.first_check.at, &zone, now)?;
        let summary = summary(&new, &steps, &dates);
        let line = format!(
            "I have recorded the objective \"{}\". It has its own chat now.",
            new.title
        );
        let created = self.write(|| {
            self.store.create_objective(&NewObjective {
                user: owner.user,
                agreed_in: owner.chat,
                title: &new.title,
                deliverable: &new.deliverable,
                start: &start,
                due: &due,
                steps: &steps,
                sources: &new.sources,
                check: NewTask {
                    kind: TaskKind::Check,
                    why: &new.first_check.why,
                    due_at,
                    local_time: &local_time,
                    time_zone: &zone,
                    set_by: SetBy::Jet,
                },
                summary: &summary,
                line: &line,
                at: now,
            })
        })?;
        self.show(owner.user, created.objective)
    }

    /// Refuses a change to an objective that is done or dropped, so its history stays as closed.
    fn refuse_closed(&self, user: UserId, id: ObjectiveId) -> Result<(), ObjectiveError> {
        let status = self.store.objective(user, id)?.map(|found| found.status);
        match status {
            Some(ObjectiveStatus::Done | ObjectiveStatus::Dropped) => {
                Err(ObjectiveError::Closed { id: id.0 })
            }
            _ => Ok(()),
        }
    }

    pub(crate) fn edit(
        &self,
        user: UserId,
        id: ObjectiveId,
        edit: &Edit,
    ) -> Result<ObjectiveView, ObjectiveError> {
        self.refuse_closed(user, id)?;
        self.write(|| self.store.edit_objective(user, id, edit, self.now()))?
            .ok_or(ObjectiveError::NoSuchObjective { id: id.0 })?;
        self.show(user, id)
    }

    /// Adds a step last in the user's order: under the objective `id`, or under none.
    pub(crate) fn add_step(
        &self,
        user: UserId,
        id: Option<ObjectiveId>,
        step: NewStep,
    ) -> Result<StepAnswer, ObjectiveError> {
        if let Some(id) = id {
            self.refuse_closed(user, id)?;
        }
        let step = checked_steps(vec![step])?.remove(0);
        let added = self.write(|| {
            self.store
                .add_list_task(user, (&step, id), None, self.now())
        })?;
        let added = added.map_err(|refused| TaskListError::from(refused).for_jet(id, StepId(0)))?;
        self.step_answer(user, id, added)
    }

    /// Marks one of the user's steps started, done, not done or not started.
    pub(crate) fn mark_step(
        &self,
        user: UserId,
        id: Option<ObjectiveId>,
        step: StepId,
        mark: Mark,
    ) -> Result<StepAnswer, ObjectiveError> {
        let goal = self.step_goal(user, id, step)?;
        let edit = TaskEdit {
            mark: Some(mark),
            ..TaskEdit::default()
        };
        self.edit_step_for_jet(user, (goal, step), &edit)?;
        self.step_answer(user, goal, step)
    }

    /// Gives one step a new title, a new due date, or both, as when a step slips.
    pub(crate) fn edit_step(
        &self,
        user: UserId,
        id: Option<ObjectiveId>,
        step: StepId,
        change: StepChange,
    ) -> Result<StepAnswer, ObjectiveError> {
        if change.title.is_none() && change.due.is_none() {
            return Err(ObjectiveError::NothingToChange);
        }
        let goal = self.step_goal(user, id, step)?;
        let edit = TaskEdit {
            title: change.title,
            date: change
                .due
                .map(|due| time::date(&due).map(|date| date.to_string()))
                .transpose()?,
            ..TaskEdit::default()
        };
        self.edit_step_for_jet(user, (goal, step), &edit)?;
        self.step_answer(user, goal, step)
    }

    /// The objective the user's step is under, or `None` for a task under none. A step that is
    /// not the user's, or not under `id` when Jet named one, is refused, and so is a closed one.
    fn step_goal(
        &self,
        user: UserId,
        id: Option<ObjectiveId>,
        step: StepId,
    ) -> Result<Option<ObjectiveId>, ObjectiveError> {
        let no_step = ObjectiveError::NoSuchStep { step: step.0 };
        let goal = self.store.step_objective(user, step)?.ok_or(no_step)?;
        if id.is_some_and(|id| goal != Some(id)) {
            return Err(ObjectiveError::NoSuchStep { step: step.0 });
        }
        if let Some(goal) = goal {
            self.refuse_closed(user, goal)?;
        }
        Ok(goal)
    }

    /// What Jet is answered after a step changed: its objective, or the step under no objective
    /// with the main chat.
    fn step_answer(
        &self,
        user: UserId,
        goal: Option<ObjectiveId>,
        step: StepId,
    ) -> Result<StepAnswer, ObjectiveError> {
        let Some(goal) = goal else {
            let no_step = ObjectiveError::NoSuchStep { step: step.0 };
            let step = self.store.step(user, step)?.ok_or(no_step)?;
            let main = self.store.main_chat(user)?;
            let chat = NamedChat {
                id: main.id,
                title: main.title,
            };
            return Ok(StepAnswer::Loose { step, chat });
        };
        Ok(StepAnswer::Objective(self.show(user, goal)?))
    }

    /// The user's tasks under no objective: the open ones, and those the done pile keeps.
    pub(crate) fn loose_steps(&self, user: UserId) -> Result<Vec<Step>, ObjectiveError> {
        Ok(self.store.loose_steps(user, self.done_kept_since())?)
    }

    /// Moves the start date, the due date or both, and notes in words what moved and why. The
    /// steps keep their dates.
    pub(crate) fn change_dates(
        &self,
        user: UserId,
        id: ObjectiveId,
        start: Option<&str>,
        due: Option<&str>,
        reason: &str,
    ) -> Result<ObjectiveView, ObjectiveError> {
        self.refuse_closed(user, id)?;
        let objective = self
            .store
            .objective(user, id)?
            .ok_or(ObjectiveError::NoSuchObjective { id: id.0 })?;
        let new_start = start.map_or(Ok(objective.start.clone()), |text| {
            time::date(text).map(|date| date.to_string())
        })?;
        let new_due = due.map_or(Ok(objective.due.clone()), |text| {
            time::date(text).map(|date| date.to_string())
        })?;
        check_forwards(&new_start, &new_due)?;
        let words = |day: &str| time::date(day).map(time::in_words);
        let mut moved = Vec::new();
        for (name, old, new) in [
            ("start", &objective.start, &new_start),
            ("due", &objective.due, &new_due),
        ] {
            if old != new {
                moved.push(format!("{name} {} (was {})", words(new)?, words(old)?));
            }
        }
        if moved.is_empty() {
            return Err(ObjectiveError::NoNewDate);
        }
        let note = NewNote {
            status: None,
            moved: "Dates changed".into(),
            blockers: String::new(),
            new_dates: format!("{}. Reason: {reason}", moved.join(", ")),
            is_private: false,
            entry_id: None,
        };
        self.write(|| {
            self.store
                .change_dates(user, id, (&new_start, &new_due), &note, self.now())
        })?
        .ok_or(ObjectiveError::NoSuchObjective { id: id.0 })?;
        self.show(user, id)
    }

    pub(crate) fn note(
        &self,
        user: UserId,
        id: ObjectiveId,
        update: Update,
    ) -> Result<ObjectiveView, ObjectiveError> {
        let note = NewNote {
            status: Some(update.status),
            moved: update.moved,
            blockers: update.blockers,
            new_dates: String::new(),
            is_private: update.is_private,
            entry_id: None,
        };
        self.write(|| self.store.add_update_note(user, id, &note, self.now()))?
            .ok_or(ObjectiveError::NoSuchObjective { id: id.0 })?;
        self.show(user, id)
    }

    /// Ends the objective as done or dropped. Its waiting checks are cancelled.
    pub(crate) fn close(
        &self,
        user: UserId,
        id: ObjectiveId,
        status: ObjectiveStatus,
        summary: Option<String>,
    ) -> Result<ObjectiveView, ObjectiveError> {
        self.refuse_closed(user, id)?;
        let note = summary.map(|moved| NewNote {
            status: (status == ObjectiveStatus::Done).then_some(NoteStatus::Done),
            moved,
            blockers: String::new(),
            new_dates: String::new(),
            is_private: false,
            entry_id: None,
        });
        self.write(|| {
            self.store
                .close_objective(user, id, status, note.as_ref(), self.now())
        })?
        .ok_or(ObjectiveError::NoSuchObjective { id: id.0 })?;
        self.show(user, id)
    }

    /// Jet's tasks for the user, and the newest runs.
    pub(crate) fn tasks(&self, user: UserId) -> Result<TasksView, ObjectiveError> {
        Ok(TasksView {
            tasks: self.store.agent_tasks(user)?,
            runs: self.store.task_runs(user, RUNS_SHOWN)?,
        })
    }

    /// Sets the objective's check, moving the open one when there is one. Without an objective
    /// it sets a follow-up that lands in the chat of the turn. Gives the task and whether an
    /// existing check was moved.
    pub(crate) fn schedule(
        &self,
        owner: TurnOwner,
        objective: Option<ObjectiveId>,
        check: Check,
    ) -> Result<(AgentTask, bool), ObjectiveError> {
        let now = self.now();
        let zone = self.zone_name(owner.user)?;
        let (due_at, local_time) = time::to_utc(&check.at, &zone, now)?;
        let task = |kind| NewTask {
            kind,
            why: &check.why,
            due_at,
            local_time: &local_time,
            time_zone: &zone,
            set_by: SetBy::Jet,
        };
        let (id, moved) = match objective {
            Some(objective) => {
                let new = task(TaskKind::Check);
                match self.write(|| self.store.schedule_check(owner.user, objective, &new, now))? {
                    Scheduled::Added(id) => (id, false),
                    Scheduled::Moved(id) => (id, true),
                    Scheduled::Running(_) => return Err(ObjectiveError::CheckRunning),
                    Scheduled::NoObjective => {
                        return Err(ObjectiveError::NoSuchObjective { id: objective.0 });
                    }
                }
            }
            None => {
                let new = task(TaskKind::FollowUp);
                let id =
                    self.write(|| self.store.add_follow_up(owner.user, owner.chat, &new, now))?;
                (id, false)
            }
        };
        Ok((self.task(owner.user, id)?, moved))
    }

    pub(crate) fn cancel(&self, user: UserId, id: TaskId) -> Result<AgentTask, ObjectiveError> {
        self.cancel_told(user, id, None)
    }

    /// Cancels the task and keeps `tap`, the line Jet is told of it, in the same write.
    pub(crate) fn cancel_told(
        &self,
        user: UserId,
        id: TaskId,
        tap: Tap,
    ) -> Result<AgentTask, ObjectiveError> {
        match self.write(|| self.store.cancel_task(user, id, (self.now(), tap)))? {
            CancelOutcome::Cancelled => self.task(user, id),
            CancelOutcome::NotWaiting(state) => Err(ObjectiveError::TaskNotWaiting {
                id: id.0,
                state: state.as_str(),
            }),
            CancelOutcome::Missing => Err(ObjectiveError::NoSuchTask { id: id.0 }),
        }
    }

    /// The user's time zone name, as their page last sent it.
    pub(crate) fn zone_name(&self, user: UserId) -> Result<String, ObjectiveError> {
        self.store
            .time_zone(user)?
            .ok_or(ObjectiveError::NoTimeZone)
    }

    /// Only the admin may name an app as a source.
    pub(crate) fn require_admin(&self, user: UserId) -> Result<(), ObjectiveError> {
        match self.store.user(user)? {
            Some(user) if user.is_admin => Ok(()),
            _ => Err(ObjectiveError::AppSourceAdminOnly),
        }
    }

    /// Every user and team of the organisation.
    pub(crate) fn people(&self) -> Result<(Vec<Person>, Vec<Team>), ObjectiveError> {
        Ok(self.store.directory()?)
    }

    pub(crate) fn now(&self) -> u64 {
        (self.clock)()
    }

    pub(crate) fn task(&self, user: UserId, id: TaskId) -> Result<AgentTask, ObjectiveError> {
        self.store
            .agent_tasks(user)?
            .into_iter()
            .find(|task| task.id == id)
            .ok_or(ObjectiveError::NoSuchTask { id: id.0 })
    }

    pub(crate) fn show(
        &self,
        user: UserId,
        id: ObjectiveId,
    ) -> Result<ObjectiveView, ObjectiveError> {
        let objective = self
            .store
            .objective(user, id)?
            .ok_or(ObjectiveError::NoSuchObjective { id: id.0 })?;
        self.view(user, objective, &self.store.agent_tasks(user)?)
    }

    fn view(
        &self,
        user: UserId,
        objective: Objective,
        tasks: &[AgentTask],
    ) -> Result<ObjectiveView, ObjectiveError> {
        let zone = match self.store.time_zone(user)? {
            Some(name) => time::zone(&name)?,
            None => time::zone(UTC)?,
        };
        let (start, due) = (time::date(&objective.start)?, time::date(&objective.due)?);
        let mut notes = self.store.update_notes(user, objective.id)?;
        notes.drain(..notes.len().saturating_sub(NOTES_SHOWN));
        Ok(ObjectiveView {
            duration_days: time::days_between(start, due),
            days_left: time::days_between(time::today(&zone, self.now()), due),
            steps: self.store.steps(user, objective.id)?,
            sources: self.store.sources(user, objective.id)?,
            notes,
            tasks: tasks
                .iter()
                .filter(|task| {
                    task.objective_id == Some(objective.id)
                        && matches!(task.state, TaskState::Scheduled | TaskState::Running)
                })
                .cloned()
                .collect(),
            objective,
        })
    }

    /// Runs a write again when the database was busy, up to a few times.
    fn write<T>(&self, mut call: impl FnMut() -> Result<T, StoreError>) -> Result<T, StoreError> {
        let mut tries = 1;
        loop {
            match call() {
                Err(error) if error.is_busy() && tries < WRITE_TRIES => tries += 1,
                result => {
                    if result.is_ok() {
                        self.signals.changed();
                    }
                    return result;
                }
            }
        }
    }
}

fn check_forwards(start: &str, due: &str) -> Result<(), ObjectiveError> {
    // Dates in this form sort the way they run.
    if due < start {
        return Err(ObjectiveError::DatesBackwards {
            start: start.to_owned(),
            due: due.to_owned(),
        });
    }
    Ok(())
}

/// The steps with their due dates read and written in one form.
fn checked_steps(steps: Vec<NewStep>) -> Result<Vec<NewStep>, ObjectiveError> {
    steps
        .into_iter()
        .map(|step| {
            let due = step
                .due
                .map(|due| time::date(&due).map(|date| date.to_string()))
                .transpose()?;
            Ok(NewStep { due, ..step })
        })
        .collect()
}

/// The first entry of an objective's own chat, as Markdown: a single line break would join the
/// dates to the deliverable, so each part is a paragraph.
fn summary(new: &Create, steps: &[NewStep], dates: &str) -> String {
    let mut text = format!(
        "{}\n\nDeliverable: {}\n\n{dates}",
        new.title, new.deliverable
    );
    if !steps.is_empty() {
        text.push('\n');
    }
    for (number, step) in (1..).zip(steps) {
        text.push_str(&format!("\n{number}. {}", step.title));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{ChatKind, NewStep, SourceKind, test_store};
    use std::sync::atomic::{AtomicU64, Ordering};

    // 2026-01-01 00:00 UTC.
    const START: u64 = 1_767_225_600;

    struct World {
        _dir: tempfile::TempDir,
        objectives: Objectives,
        store: Store,
        ada: TurnOwner,
        bob: TurnOwner,
    }

    fn world() -> World {
        let (dir, store, ada, bob) = test_store();
        let ticking = Arc::new(AtomicU64::new(START));
        let objectives = Objectives::new(
            store.clone(),
            Arc::new(move || ticking.fetch_add(1, Ordering::SeqCst)),
        );
        let main = |user| TurnOwner {
            user,
            chat: store.main_chat(user).unwrap().id,
        };
        World {
            objectives,
            ada: main(ada),
            bob: main(bob),
            store: store.clone(),
            _dir: dir,
        }
    }

    fn kite() -> Create {
        Create {
            title: "Ship the kite".into(),
            deliverable: "A kite that flies".into(),
            start: Some("2026-02-01".into()),
            due: "2026-03-01".into(),
            steps: ["Build the frame", "Fly it"]
                .map(|title| NewStep {
                    title: title.into(),
                    due: None,
                })
                .into(),
            sources: vec![NewSource {
                kind: SourceKind::Jet,
                target: String::new(),
                detail: String::new(),
            }],
            first_check: Check {
                at: "2026-02-10T09:00".into(),
                why: "see whether the frame is built".into(),
            },
        }
    }

    fn check_of(view: &ObjectiveView) -> &AgentTask {
        &view.tasks[0]
    }

    #[test]
    fn tasks_schedule_moves_open_check() {
        let world = world();
        let view = world.objectives.create(world.ada, kite()).unwrap();
        let first = check_of(&view).clone();
        assert_eq!(
            (first.local_time.as_str(), first.time_zone.as_str()),
            ("2026-02-10T09:00", "Europe/London")
        );
        assert_eq!(
            first.due_at, 1_770_714_000,
            "09:00 in London in winter is 09:00 UTC"
        );

        let later = Check {
            at: "2026-02-12T17:30".into(),
            why: "the user said Thursday".into(),
        };
        let (moved, was_moved) = world
            .objectives
            .schedule(world.ada, Some(view.objective.id), later)
            .unwrap();
        assert!(was_moved);
        assert_eq!(moved.id, first.id);
        assert_eq!(moved.version, first.version + 1);

        let open = world.objectives.tasks(world.ada.user).unwrap().tasks;
        assert_eq!(open.len(), 1, "{open:?}");

        world.objectives.cancel(world.ada.user, first.id).unwrap();
        let (added, was_moved) = world
            .objectives
            .schedule(
                world.ada,
                Some(view.objective.id),
                Check {
                    at: "2026-02-20T09:00".into(),
                    why: "again".into(),
                },
            )
            .unwrap();
        assert!(!was_moved);
        assert_ne!(added.id, first.id);
    }

    #[test]
    fn every_change_raises_the_version() {
        let world = world();
        let ada = world.ada.user;
        let view = world.objectives.create(world.ada, kite()).unwrap();
        let id = view.objective.id;
        let version = || world.objectives.list(ada).unwrap()[0].objective.version;
        let mut seen = vec![version()];
        let step = view.steps[0].id;
        let edit = Edit {
            title: Some("Ship the red kite"),
            ..Edit::default()
        };
        let o = &world.objectives;
        o.edit(ada, id, &edit).unwrap();
        seen.push(version());
        o.add_step(
            ada,
            Some(id),
            NewStep {
                title: "Photograph it".into(),
                due: Some("2026-02-27".into()),
            },
        )
        .unwrap();
        seen.push(version());
        o.mark_step(ada, Some(id), step, Mark::Done).unwrap();
        seen.push(version());
        o.change_dates(ada, id, None, Some("2026-03-08"), "the wind")
            .unwrap();
        seen.push(version());
        let update = Update {
            status: NoteStatus::AtRisk,
            moved: "frame half built".into(),
            blockers: "no glue".into(),
            is_private: true,
        };
        o.note(ada, id, update).unwrap();
        seen.push(version());
        o.close(ada, id, ObjectiveStatus::Done, None).unwrap();
        seen.push(version());
        assert_eq!(seen, [1, 2, 3, 4, 5, 6, 7]);

        let task = check_of_open(&world, ada);
        assert!(task.is_none(), "closing cancels the waiting check");
        let tasks = o.tasks(ada).unwrap().tasks;
        assert_eq!(
            (tasks[0].state, tasks[0].version),
            (TaskState::Cancelled, 2)
        );
    }

    #[test]
    fn a_done_objective_has_its_closed_at() {
        let world = world();
        let ada = world.ada.user;
        let id = world
            .objectives
            .create(world.ada, kite())
            .unwrap()
            .objective
            .id;
        assert_eq!(
            world.objectives.show(ada, id).unwrap().objective.closed_at,
            None
        );
        let closed = world
            .objectives
            .close(ada, id, ObjectiveStatus::Done, None)
            .unwrap();
        let at = closed
            .objective
            .closed_at
            .expect("a done objective says when it closed");
        assert!(
            at > START && at == closed.objective.updated_at,
            "{closed:?}"
        );
    }

    #[test]
    fn step_edit_changes_date_and_title_raises_version_and_refuses_another_user() {
        let world = world();
        let o = &world.objectives;
        let made = o.create(world.ada, kite()).unwrap();
        let (id, step) = (made.objective.id, made.steps[0].id);
        let change = StepChange {
            title: Some("Build the red frame".into()),
            due: Some("2026-02-20".into()),
        };
        let StepAnswer::Objective(edited) = o
            .edit_step(world.ada.user, Some(id), step, change.clone())
            .unwrap()
        else {
            panic!("a step of an objective is answered with its objective");
        };
        assert_eq!(
            (
                edited.steps[0].title.as_str(),
                edited.steps[0].due.as_deref()
            ),
            ("Build the red frame", Some("2026-02-20"))
        );
        assert_eq!(edited.objective.version, made.objective.version + 1);
        assert_eq!(
            edited.steps[1], made.steps[1],
            "the other step is as it was"
        );

        let refused = o
            .edit_step(world.bob.user, Some(id), step, change)
            .unwrap_err();
        assert_eq!(refused.kind(), "noSuchStep");
        let nothing = StepChange {
            title: None,
            due: None,
        };
        let empty = o
            .edit_step(world.ada.user, Some(id), step, nothing)
            .unwrap_err();
        assert_eq!(empty.kind(), "nothingToChange");
        assert_eq!(
            o.show(world.ada.user, id).unwrap().objective.version,
            edited.objective.version
        );
    }

    fn check_of_open(world: &World, user: UserId) -> Option<AgentTask> {
        world.objectives.list(user).unwrap()[0]
            .tasks
            .first()
            .cloned()
    }

    #[test]
    fn a_closed_objective_is_not_reopened_by_edit() {
        let world = world();
        let view = world.objectives.create(world.ada, kite()).unwrap();
        let id = view.objective.id;
        world
            .objectives
            .close(world.ada.user, id, ObjectiveStatus::Done, None)
            .unwrap();
        let edit = Edit {
            status: Some(ObjectiveStatus::Active),
            ..Edit::default()
        };
        assert_eq!(
            world
                .objectives
                .edit(world.ada.user, id, &edit)
                .unwrap_err()
                .kind(),
            "objectiveClosed"
        );
    }

    #[test]
    fn dates_need_to_run_forwards_and_the_note_keeps_the_reason() {
        let world = world();
        let view = world.objectives.create(world.ada, kite()).unwrap();
        let id = view.objective.id;
        let backwards =
            world
                .objectives
                .change_dates(world.ada.user, id, Some("2026-04-01"), None, "late");
        assert_eq!(backwards.unwrap_err().kind(), "datesBackwards");
        let moved = world
            .objectives
            .change_dates(
                world.ada.user,
                id,
                Some("2026-02-15"),
                Some("2026-03-15"),
                "starting a week late",
            )
            .unwrap();
        assert_eq!((moved.duration_days, moved.objective.version), (28, 2));
        assert_eq!(
            moved.notes[0].new_dates,
            "start Sun 15 Feb 2026 (was Sun 1 Feb 2026), due Sun 15 Mar 2026 (was Sun 1 Mar 2026). Reason: starting a week late"
        );
        // Only what moved is said, and a date that is the one already kept moves nothing.
        let due = |day| {
            let moved = world.objectives.change_dates(
                world.ada.user,
                id,
                Some("2026-02-15"),
                Some(day),
                "slipped",
            );
            moved.map(|view| view.notes.last().unwrap().new_dates.clone())
        };
        assert_eq!(
            due("2026-03-22").unwrap(),
            "due Sun 22 Mar 2026 (was Sun 15 Mar 2026). Reason: slipped"
        );
        assert_eq!(due("2026-03-22").unwrap_err().kind(), "noNewDate");
    }

    #[test]
    fn objective_reads_are_owner_only() {
        let world = world();
        let made = world.objectives.create(world.ada, kite()).unwrap();
        let (id, task) = (made.objective.id, made.tasks[0].id);
        world
            .objectives
            .note(
                world.ada.user,
                id,
                Update {
                    status: NoteStatus::OnTrack,
                    moved: "x".into(),
                    blockers: String::new(),
                    is_private: true,
                },
            )
            .unwrap();
        let (store, bob) = (&world.store, world.bob.user);
        assert_eq!(store.objectives(bob).unwrap(), []);
        assert_eq!(store.objective(bob, id).unwrap(), None);
        assert_eq!(store.steps(bob, id).unwrap(), []);
        assert_eq!(store.sources(bob, id).unwrap(), []);
        assert_eq!(store.update_notes(bob, id).unwrap(), []);
        assert_eq!(store.agent_tasks(bob).unwrap(), []);
        assert_eq!(store.task_runs(bob, 10).unwrap(), []);
        // Nor can another user change any of it.
        let o = &world.objectives;
        assert_eq!(
            o.mark_step(bob, Some(id), made.steps[0].id, Mark::Done)
                .unwrap_err()
                .kind(),
            "noSuchStep"
        );
        assert_eq!(
            o.close(bob, id, ObjectiveStatus::Dropped, None)
                .unwrap_err()
                .kind(),
            "noSuchObjective"
        );
        assert_eq!(o.cancel(bob, task).unwrap_err().kind(), "noSuchTask");
        assert_eq!(o.list(bob).unwrap().len(), 0);
        assert_eq!(
            o.list(world.ada.user).unwrap()[0].objective.status,
            ObjectiveStatus::Active
        );
    }

    #[test]
    fn create_in_the_main_chat_makes_the_chat_and_leaves_a_line() {
        let world = world();
        let main = world.ada.chat;
        let view = world.objectives.create(world.ada, kite()).unwrap();
        let chat = view.objective.chat_id;
        assert_ne!(chat, main);
        let made = world.store.chat(world.ada.user, chat).unwrap().unwrap();
        assert_eq!(
            (made.kind, made.title.as_str()),
            (ChatKind::Objective, "Ship the kite")
        );
        let first = world.store.entries(chat, None).unwrap();
        assert_eq!(first.len(), 1);
        assert!(
            first[0].text.contains("A kite that flies")
                && first[0].text.contains("1. Build the frame")
        );
        assert!(
            first[0]
                .text
                .contains("A kite that flies\n\nFrom Sun 1 Feb 2026 to Sun 1 Mar 2026."),
            "the dates are in words, in a paragraph of their own: {}",
            first[0].text
        );
        let line = world.store.entries(main, None).unwrap();
        assert!(line[0].text.contains("Ship the kite"));
        assert_eq!(
            check_of(&view).chat_id,
            chat,
            "the check lands in the objective's chat"
        );
    }

    #[test]
    fn a_closed_or_missing_objective_gets_no_check_and_no_zone_means_no_time() {
        let world = world();
        let view = world.objectives.create(world.ada, kite()).unwrap();
        world
            .objectives
            .close(
                world.ada.user,
                view.objective.id,
                ObjectiveStatus::Dropped,
                None,
            )
            .unwrap();
        let check = || Check {
            at: "2026-02-20T09:00".into(),
            why: "again".into(),
        };
        let refused = world
            .objectives
            .schedule(world.ada, Some(view.objective.id), check());
        assert_eq!(refused.unwrap_err().kind(), "noSuchObjective");
        let stranger = world
            .objectives
            .schedule(world.bob, Some(view.objective.id), check());
        assert_eq!(stranger.unwrap_err().kind(), "noSuchObjective");

        let (_dir, store, ada, _) = test_store();
        store.set_time_zone(ada, "Mars/Olympus").unwrap();
        let objectives = Objectives::new(store.clone(), Arc::new(|| START));
        let owner = TurnOwner {
            user: ada,
            chat: store.main_chat(ada).unwrap().id,
        };
        assert_eq!(
            objectives
                .schedule(owner, None, check())
                .unwrap_err()
                .kind(),
            "badTimeZone"
        );
    }

    #[test]
    fn a_follow_up_is_stamped_with_the_time_it_was_set() {
        let w = world();
        let check = Check {
            at: "2026-02-20T09:00".into(),
            why: "again".into(),
        };
        let (task, _) = w.objectives.schedule(w.ada, None, check).unwrap();
        assert!(task.created_at >= START, "created at {}", task.created_at);
    }

    #[test]
    fn a_closed_objective_keeps_its_steps_dates_and_status() {
        let w = world();
        let ada = w.ada.user;
        let made = w.objectives.create(w.ada, kite()).unwrap();
        let id = made.objective.id;
        let step = made.steps[0].id;
        let closed = w
            .objectives
            .close(ada, id, ObjectiveStatus::Done, None)
            .unwrap();
        let refused = [
            w.objectives
                .add_step(
                    ada,
                    Some(id),
                    NewStep {
                        title: "late".into(),
                        due: None,
                    },
                )
                .map(drop),
            w.objectives
                .mark_step(ada, Some(id), step, Mark::Done)
                .map(drop),
            w.objectives
                .change_dates(ada, id, None, Some("2027-01-01"), "late")
                .map(drop),
            w.objectives
                .close(ada, id, ObjectiveStatus::Dropped, None)
                .map(drop),
        ];
        for result in refused {
            assert_eq!(result.unwrap_err().kind(), "objectiveClosed");
        }
        let after = w.objectives.show(ada, id).unwrap();
        assert_eq!(
            (after.objective.status, after.objective.closed_at),
            (ObjectiveStatus::Done, closed.objective.closed_at)
        );
    }
}
