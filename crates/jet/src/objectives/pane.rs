//! What the right-hand plan pane reads and what its one-tap controls do. Every tap acts only on
//! the signed-in user's own things, is kept as a line Jet is told before the user's next message,
//! and answers another user's thing as a thing that does not exist.

use super::{
    ObjectiveError, ObjectiveId, ObjectiveStatus, ObjectiveView, Objectives, Run, Step, StepId,
    TaskId, TaskState, UserId, time,
};
use crate::store::{AgentTask, ChatId, SetBy, SharedNote, Sharing, Snoozed};
use serde::Serialize;

/// An objective as its owner sees it in the pane.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaneObjective {
    #[serde(flatten)]
    view: ObjectiveView,
    /// True while it is shared with nobody.
    private: bool,
    shared_with: Sharing,
}

/// One of Jet's open tasks, with the objective it belongs to.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaneTask {
    #[serde(flatten)]
    task: AgentTask,
    objective_title: Option<String>,
    /// The server chose this time because Jet set none.
    is_default: bool,
}

/// An objective a colleague shared with the signed-in user: nothing private, no chat.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ColleagueObjective {
    owner: String,
    id: ObjectiveId,
    title: String,
    due: String,
    status: ObjectiveStatus,
    days_left: i64,
    steps: Vec<Step>,
    latest: Option<SharedNote>,
}

/// Everything the pane draws, in one read.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Pane {
    time_zone: Option<String>,
    objectives: Vec<PaneObjective>,
    tasks: Vec<PaneTask>,
    runs: Vec<Run>,
    shared_with_me: Vec<ColleagueObjective>,
}

impl Objectives {
    pub(crate) fn pane(&self, user: UserId) -> Result<Pane, ObjectiveError> {
        let objectives = self
            .list(user)?
            .into_iter()
            .map(|view| {
                let shared_with = self.sharing(user, view.objective.id)?;
                Ok(PaneObjective {
                    private: shared_with.people.is_empty() && shared_with.teams.is_empty(),
                    shared_with,
                    view,
                })
            })
            .collect::<Result<Vec<_>, ObjectiveError>>()?;
        let all = self.tasks(user)?;
        let title = |task: &AgentTask| {
            let id = task.objective_id?;
            objectives
                .iter()
                .find(|found| found.view.objective.id == id)
                .map(|found| found.view.objective.title.clone())
        };
        let tasks = all
            .tasks
            .into_iter()
            .filter(|task| matches!(task.state, TaskState::Scheduled | TaskState::Running))
            .map(|task| PaneTask {
                objective_title: title(&task),
                is_default: task.set_by == SetBy::Default,
                task,
            })
            .collect();
        Ok(Pane {
            time_zone: self.store.time_zone(user)?,
            tasks,
            runs: all.runs,
            shared_with_me: self.shared_with_me(user)?,
            objectives,
        })
    }

    fn shared_with_me(&self, viewer: UserId) -> Result<Vec<ColleagueObjective>, ObjectiveError> {
        let mut found = Vec::new();
        for (owner, name) in self.store.sharers(viewer)? {
            for view in self.shared_with(viewer, owner)? {
                let mut shared = view.shared;
                found.push(ColleagueObjective {
                    owner: name.clone(),
                    days_left: view.days_left,
                    latest: shared.notes.pop(),
                    id: shared.id,
                    title: shared.title,
                    due: shared.due,
                    status: shared.status,
                    steps: shared.steps,
                });
            }
        }
        Ok(found)
    }

    /// Ticks or unticks one of the user's steps by a tap.
    pub(crate) fn tap_step(
        &self,
        user: UserId,
        objective: ObjectiveId,
        step: StepId,
        is_done: bool,
    ) -> Result<ObjectiveView, ObjectiveError> {
        let view = self.tick_step(user, objective, step, is_done)?;
        let title = view
            .steps
            .iter()
            .find(|found| found.id == step)
            .map_or("", |found| found.title.as_str());
        let how = if is_done { "done" } else { "not done" };
        let line = format!(
            "[The user tapped step \"{title}\" of \"{}\" in the pane: it is now marked {how}.]",
            view.objective.title
        );
        self.told(user, view.objective.chat_id, &line)?;
        Ok(view)
    }

    /// Moves a waiting task of the user's to the next 08:00 in their zone.
    pub(crate) fn tap_snooze(&self, user: UserId, id: TaskId) -> Result<AgentTask, ObjectiveError> {
        let old = self.task(user, id)?;
        let zone = self.store.time_zone(user)?.unwrap_or(old.time_zone);
        let (due_at, local) = time::next_morning(&zone, self.now())?;
        match self.write(|| {
            self.store
                .snooze_task(user, id, (due_at, &local, &zone), self.now())
        })? {
            Snoozed::Moved => {}
            Snoozed::NotWaiting(state) => {
                return Err(ObjectiveError::TaskNotWaiting {
                    id: id.0,
                    state: state.as_str(),
                });
            }
            Snoozed::Missing => return Err(ObjectiveError::NoSuchTask { id: id.0 }),
        }
        let task = self.task(user, id)?;
        let line = format!(
            "[The user tapped Snooze in the pane on your task \"{}\": it now falls due at {local} ({zone}).]",
            task.why
        );
        self.told(user, task.chat_id, &line)?;
        Ok(task)
    }

    /// Cancels a waiting task of the user's by a tap.
    pub(crate) fn tap_cancel(&self, user: UserId, id: TaskId) -> Result<AgentTask, ObjectiveError> {
        let task = self.cancel(user, id)?;
        let line = format!(
            "[The user tapped Cancel in the pane on your task \"{}\": it is cancelled.]",
            task.why
        );
        self.told(user, task.chat_id, &line)?;
        Ok(task)
    }

    /// Keeps the tap of flipping a note between private and shared, for Jet to be told of.
    pub(crate) fn note_flipped(
        &self,
        user: UserId,
        objective: ObjectiveId,
        note: i64,
        is_private: bool,
    ) -> Result<(), ObjectiveError> {
        let found = self
            .store
            .objective(user, objective)?
            .ok_or(ObjectiveError::NoSuchObjective { id: objective.0 })?;
        let moved = self
            .store
            .update_notes(user, objective)?
            .into_iter()
            .find(|found| found.id == note)
            .map_or_else(String::new, |found| found.moved);
        let how = if is_private { "private" } else { "shared" };
        let line = format!(
            "[The user tapped your note \"{moved}\" on \"{}\" in the pane: it is now {how}.]",
            found.title
        );
        self.told(user, found.chat_id, &line)
    }

    fn told(&self, user: UserId, chat: ChatId, line: &str) -> Result<(), ObjectiveError> {
        self.write(|| self.store.record_tap(user, chat, line, self.now()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::{Chats, TurnOwner, TurnTools};
    use crate::files::Files;
    use crate::objectives::{Check, Create, Update};
    use crate::scheduler::Signals;
    use crate::store::{
        NewStep, NewTask, NoteStatus, ObjectiveChat, RunId, RunOutcome, Settled, Store, TaskEnd,
        test_store,
    };
    use agent::{McpConnection, TurnIdentity};
    use serde_json::Value;
    use std::{sync::Arc, time::Duration};

    // 2026-01-01 00:00 UTC.
    const NOW: u64 = 1_767_225_600;

    fn objectives(store: &Store) -> Objectives {
        Objectives::new(store.clone(), Arc::new(|| NOW))
    }

    /// Makes an objective with one step and a check for `owner`, in their main chat.
    fn create(store: &Store, objectives: &Objectives, owner: UserId, title: &str) -> ObjectiveView {
        store.set_time_zone(owner, "Europe/London").unwrap();
        let chat = store.main_chat(owner).unwrap().id;
        objectives
            .create(
                TurnOwner { user: owner, chat },
                Create {
                    title: title.into(),
                    deliverable: format!("{title} delivered"),
                    start: Some("2026-01-01".into()),
                    due: "2026-02-01".into(),
                    steps: vec![NewStep {
                        title: "First step".into(),
                        due: None,
                    }],
                    sources: Vec::new(),
                    first_check: Check {
                        at: "2026-01-05T09:00".into(),
                        why: "see whether the first step is done".into(),
                    },
                    chat: ObjectiveChat::This,
                },
            )
            .unwrap()
    }

    #[test]
    fn the_pane_payload_is_the_fixture() {
        let (_dir, store, ada, bob) = test_store();
        let objectives = objectives(&store);
        let mine = create(&store, &objectives, ada, "Ship the kite");
        let theirs = create(&store, &objectives, bob, "Plan the launch");
        for (moved, is_private) in [("Frame is half built", false), ("Doubt it will fly", true)] {
            let update = Update {
                status: NoteStatus::AtRisk,
                moved: moved.into(),
                blockers: "wind".into(),
                is_private,
            };
            objectives.note(ada, mine.objective.id, update).unwrap();
        }
        objectives
            .note(
                bob,
                theirs.objective.id,
                Update {
                    status: NoteStatus::OnTrack,
                    moved: "Venue found".into(),
                    blockers: String::new(),
                    is_private: false,
                },
            )
            .unwrap();
        let (people, _) = objectives.people().unwrap();
        let card = |owner: UserId, objective: &ObjectiveView, with: UserId| {
            let chat = store.main_chat(owner).unwrap().id;
            let card = objectives
                .propose_share(
                    TurnOwner { user: owner, chat },
                    objective.objective.id,
                    &[with],
                    &[],
                )
                .unwrap();
            objectives
                .apply_share(owner, card.id, &[with], &[])
                .unwrap();
        };
        assert_eq!(people.len(), 2);
        card(ada, &mine, bob);
        card(bob, &theirs, ada);
        let task = store.agent_tasks(ada).unwrap()[0].id;
        let run = store.claim_task(task, NOW + 10_000_000).unwrap().unwrap();
        end_run(
            &store,
            ada,
            run,
            (RunOutcome::Spoke, "The frame is built", Some(1200)),
            true,
        );

        let read = serde_json::to_value(objectives.pane(ada).unwrap()).unwrap();
        if std::env::var_os("WRITE_FIXTURE").is_some() {
            let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/pane.json");
            std::fs::write(path, serde_json::to_string_pretty(&read).unwrap() + "\n").unwrap();
        }
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/pane.json")).unwrap();
        assert_eq!(read, fixture, "{read:#}");
    }

    /// Ends the run of the user's first task: the task waits again at its own time, or is done.
    fn end_run(
        store: &Store,
        user: UserId,
        run: RunId,
        (outcome, found, tokens): (RunOutcome, &str, Option<u64>),
        waits: bool,
    ) {
        let task = store.agent_tasks(user).unwrap().remove(0);
        let again = NewTask {
            kind: task.kind,
            why: &task.why,
            due_at: task.due_at,
            local_time: &task.local_time,
            time_zone: &task.time_zone,
            set_by: task.set_by,
        };
        let sources = if tokens.is_some() {
            vec!["github octo/kite".to_owned()]
        } else {
            Vec::new()
        };
        let end = if waits {
            TaskEnd::Wait {
                with: again,
                counted: true,
            }
        } else {
            TaskEnd::Done(None)
        };
        store
            .settle(Settled {
                run,
                seen: None,
                outcome,
                found,
                sources_read: &sources,
                tokens,
                cost_usd: None,
                entry: None,
                end,
                at: NOW + 10_000_100,
            })
            .unwrap();
    }

    struct NoTools;
    impl TurnTools for NoTools {
        fn bind(&self, _: &TurnIdentity, _: bool, _: TurnOwner) -> McpConnection {
            unreachable!("no turn runs in this test")
        }
        fn revoke(&self, _: TurnOwner, _: &str) {}
        fn shutdown(&self) {}
    }

    #[test]
    fn pane_changed_publishes_pane_changed_to_that_users_stream_only() {
        let (dir, store, ada, bob) = test_store();
        let objectives = objectives(&store);
        let made = create(&store, &objectives, ada, "Ship the kite");
        let task = made.tasks[0].id;
        let chats = Chats::new(
            store.clone(),
            Arc::new(NoTools),
            Files::new(store.clone()),
            dir.path().into(),
            Duration::ZERO,
            Signals::default(),
        );
        let (_, mut events) = chats
            .chat(ada, None)
            .unwrap()
            .subscribe(None, None)
            .unwrap();
        let (_, mut others) = chats
            .chat(bob, None)
            .unwrap()
            .subscribe(None, None)
            .unwrap();
        let run = store.claim_task(task, NOW + 10_000_000).unwrap().unwrap();
        end_run(&store, ada, run, (RunOutcome::Silent, "", None), false);
        chats.pane_changed(ada);
        assert_eq!(events.try_recv().unwrap().event["kind"], "paneChanged");
        assert!(others.try_recv().is_err(), "another user hears nothing");
    }
}
