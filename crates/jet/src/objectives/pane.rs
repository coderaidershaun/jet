//! What the right-hand plan pane reads and what its one-tap controls do. Every tap acts only on
//! the signed-in user's own things, is kept as a line Jet is told before the user's next message,
//! and answers another user's thing as a thing that does not exist.

use super::{
    ObjectiveError, ObjectiveId, ObjectiveStatus, ObjectiveView, Objectives, Run, Step, TaskId,
    TaskKind, TaskState, UserId, time,
};
use crate::store::{AgentTask, ChatId, Sent, SetBy, SharedNote, Sharing, Snoozed};

/// How many of the user's newest sent items the pane lists.
const SENT_SHOWN: usize = 50;
use serde::Serialize;

/// The line Jet is told when the user taps Cancel on a task.
pub(super) fn cancel_line(task: &AgentTask) -> String {
    format!(
        "[The user tapped Cancel in the pane on your task \"{}\": it is cancelled.]",
        task.why
    )
}

/// An objective as its owner sees it in the pane.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaneObjective {
    #[serde(flatten)]
    view: ObjectiveView,
    /// True while it is shared with nobody.
    private: bool,
    shared_with: Sharing,
    /// False when no check of it waits or runs, so Jet will not look in by itself.
    has_open_check: bool,
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
    /// Where a tap on Snooze would move it, in Unix seconds.
    snooze_at: u64,
}

/// A past run, with what its row is headed by and the check-in it opens.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaneRun {
    #[serde(flatten)]
    run: Run,
    /// The objective's title, or "Follow-up" for a task with no objective.
    title: String,
    objective_id: Option<ObjectiveId>,
    /// Why Jet set the task.
    why: String,
    /// The chat that holds the check-in.
    chat_id: ChatId,
    /// The emoji the user put on the check-in.
    reaction: Option<String>,
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
    runs: Vec<PaneRun>,
    shared_with_me: Vec<ColleagueObjective>,
    /// What the user sent to colleagues' Jets, newest first.
    sent: Vec<Sent>,
}

impl Pane {
    /// What the pane shows anyone but an admin: no tokens or cost of a run.
    pub(crate) fn without_admin_detail(mut self) -> Self {
        for run in &mut self.runs {
            run.run.tokens = None;
            run.run.cost_usd = None;
        }
        self
    }
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
                    has_open_check: view.tasks.iter().any(|task| task.kind == TaskKind::Check),
                    shared_with,
                    view,
                })
            })
            .collect::<Result<Vec<_>, ObjectiveError>>()?;
        let zone = self.store.time_zone(user)?;
        let all = self.tasks(user)?;
        let title = |task: &AgentTask| {
            let id = task.objective_id?;
            objectives
                .iter()
                .find(|found| found.view.objective.id == id)
                .map(|found| found.view.objective.title.clone())
        };
        let runs = self.runs(all.runs, &all.tasks, title)?;
        let tasks = all
            .tasks
            .into_iter()
            .filter(|task| matches!(task.state, TaskState::Scheduled | TaskState::Running))
            .map(|task| {
                let zone = zone.as_deref().unwrap_or(&task.time_zone);
                Ok(PaneTask {
                    objective_title: title(&task),
                    is_default: task.set_by == SetBy::Default,
                    snooze_at: self.snooze_to(&task, zone)?.0,
                    task,
                })
            })
            .collect::<Result<Vec<_>, ObjectiveError>>()?;
        Ok(Pane {
            time_zone: zone,
            tasks,
            runs,
            shared_with_me: self.shared_with_me(user)?,
            sent: self.store.sent_items(user, SENT_SHOWN)?,
            objectives,
        })
    }

    fn runs(
        &self,
        runs: Vec<Run>,
        tasks: &[AgentTask],
        title: impl Fn(&AgentTask) -> Option<String>,
    ) -> Result<Vec<PaneRun>, ObjectiveError> {
        let mut rows = Vec::new();
        for run in runs {
            let Some(task) = tasks.iter().find(|task| task.id == run.task_id) else {
                continue;
            };
            let reaction = match run.entry_id {
                Some(entry) => self.store.user_reaction(task.chat_id, entry)?,
                None => None,
            };
            rows.push(PaneRun {
                title: title(task).unwrap_or_else(|| "Follow-up".to_owned()),
                objective_id: task.objective_id,
                why: task.why.clone(),
                chat_id: task.chat_id,
                reaction,
                run,
            });
        }
        Ok(rows)
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

    /// A snooze lands on the next 08:00 after the task's own time, or after now when that has
    /// passed, so it never brings a check forward.
    fn snooze_to(&self, task: &AgentTask, zone: &str) -> Result<(u64, String), ObjectiveError> {
        Ok(time::next_morning(zone, self.now().max(task.due_at))?)
    }

    /// Moves a waiting task of the user's to the next 08:00 in their zone after its own time.
    pub(crate) fn tap_snooze(&self, user: UserId, id: TaskId) -> Result<AgentTask, ObjectiveError> {
        let old = self.task(user, id)?;
        let zone = self
            .store
            .time_zone(user)?
            .unwrap_or_else(|| old.time_zone.clone());
        let (due_at, local) = self.snooze_to(&old, &zone)?;
        let line = format!(
            "[The user tapped Snooze in the pane on your task \"{}\": it now falls due at {local} ({zone}).]",
            old.why
        );
        let tap = Some((old.chat_id, line.as_str()));
        match self.write(|| {
            self.store
                .snooze_task(user, id, (due_at, &local, &zone), (self.now(), tap))
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
        self.task(user, id)
    }

    /// Cancels a waiting task of the user's by a tap.
    pub(crate) fn tap_cancel(&self, user: UserId, id: TaskId) -> Result<AgentTask, ObjectiveError> {
        let task = self.task(user, id)?;
        let line = cancel_line(&task);
        self.cancel_told(user, id, Some((task.chat_id, line.as_str())))
    }

    /// Flips a note between private and shared by a tap, and keeps the line Jet is told of it.
    pub(crate) fn flip_note(
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
        self.set_note_private(
            user,
            objective,
            note,
            is_private,
            Some((found.chat_id, line.as_str())),
        )
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
        ItemKind, NewStep, NewTask, NoteStatus, RunId, RunOutcome, Settled, Store, TaskEnd,
        test_store,
    };
    use agent::{McpConnection, NewEntry, Reaction, Role, TurnIdentity};
    use serde_json::{Value, json};
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
            (
                RunOutcome::Spoke,
                "The frame is built",
                Some(1200),
                Some("How is the frame coming along?"),
            ),
            true,
        );
        react(&store, ada, "👍");

        let chat = store.main_chat(ada).unwrap().id;
        let asked = TurnOwner { user: ada, chat };
        let card = objectives
            .propose_send(
                asked,
                bob,
                ItemKind::Question,
                "When is the venue booked?",
                None,
            )
            .unwrap();
        objectives.tap_send(ada, card.id).unwrap();
        let done = create(&store, &objectives, ada, "Paint the kite")
            .objective
            .id;
        objectives
            .close(ada, done, ObjectiveStatus::Done, None)
            .unwrap();

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
    /// `said` is the check-in it posts.
    fn end_run(
        store: &Store,
        user: UserId,
        run: RunId,
        (outcome, found, tokens, said): (RunOutcome, &str, Option<u64>, Option<&str>),
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
                entry: said.map(|text| NewEntry {
                    role: Role::Jet,
                    ..NewEntry::user_text(text)
                }),
                end,
                at: NOW + 10_000_100,
            })
            .unwrap();
    }

    #[test]
    fn a_user_who_is_not_an_admin_reads_no_cost() {
        let (_dir, store, ada, _) = test_store();
        let objectives = objectives(&store);
        let made = create(&store, &objectives, ada, "Ship the kite");
        let run = store
            .claim_task(made.tasks[0].id, NOW + 10_000_000)
            .unwrap()
            .unwrap();
        end_run(
            &store,
            ada,
            run,
            (RunOutcome::Silent, "", Some(5), None),
            false,
        );
        let read = objectives.pane(ada).unwrap();
        assert_eq!(serde_json::to_value(&read).unwrap()["runs"][0]["tokens"], 5);
        let read = serde_json::to_value(read.without_admin_detail()).unwrap();
        assert_eq!(read["runs"][0]["tokens"], Value::Null);
    }

    #[test]
    fn snooze_never_lands_earlier_than_the_tasks_own_time() {
        let (_dir, store, ada, _) = test_store();
        let objectives = objectives(&store);
        let id = create(&store, &objectives, ada, "Ship the kite").tasks[0].id;
        // NOW is Thu 1 Jan 2026, 00:00 in London. (the task's own time, where a snooze lands)
        for (due, lands) in [
            ("2026-01-05T09:00", "2026-01-06T08:00"),
            ("2026-01-05T17:30", "2026-01-06T08:00"),
            ("2026-01-05T07:00", "2026-01-05T08:00"),
            ("2026-01-01T03:00", "2026-01-01T08:00"),
        ] {
            let chat = store.main_chat(ada).unwrap().id;
            let check = Check {
                at: due.into(),
                why: "look again".into(),
            };
            let objective = objectives.list(ada).unwrap()[0].objective.id;
            let (task, _) = objectives
                .schedule(TurnOwner { user: ada, chat }, Some(objective), check)
                .unwrap();
            let named = objectives.pane(ada).unwrap().tasks[0].snooze_at;
            let snoozed = objectives.tap_snooze(ada, id).unwrap();
            assert_eq!(snoozed.local_time, lands, "a check due {due}");
            assert!(
                snoozed.due_at > task.due_at && snoozed.due_at > NOW,
                "{due}"
            );
            assert_eq!(named, snoozed.due_at, "the pane names where {due} lands");
        }
    }

    /// The user puts `emoji` on the last entry of the chat of their first task.
    fn react(store: &Store, user: UserId, emoji: &str) {
        let chat = store.agent_tasks(user).unwrap()[0].chat_id;
        let mut entry = store.entries(chat, None).unwrap().pop().unwrap();
        entry.reactions.push(Reaction {
            by: Role::User,
            emoji: emoji.into(),
            at: 1,
        });
        store.replace_entry(chat, &entry).unwrap();
    }

    #[test]
    fn pane_run_has_title_chat_entry_and_reaction() {
        let (_dir, store, ada, _) = test_store();
        let objectives = objectives(&store);
        let made = create(&store, &objectives, ada, "Ship the kite");
        let run = store
            .claim_task(made.tasks[0].id, NOW + 10_000_000)
            .unwrap()
            .unwrap();
        let said = Some("How is the frame coming along?");
        end_run(
            &store,
            ada,
            run,
            (RunOutcome::Spoke, "x", Some(5), said),
            false,
        );
        react(&store, ada, "👍");
        let chat = store.main_chat(ada).unwrap().id;
        let check = Check {
            at: "2026-01-02T09:00".into(),
            why: "ask how the talk went".into(),
        };
        let (follow_up, _) = objectives
            .schedule(TurnOwner { user: ada, chat }, None, check)
            .unwrap();
        let run = store
            .claim_task(follow_up.id, NOW + 10_000_000)
            .unwrap()
            .unwrap();
        end_run(
            &store,
            ada,
            run,
            (RunOutcome::Silent, "", None, None),
            false,
        );

        let read = serde_json::to_value(objectives.pane(ada).unwrap()).unwrap();
        let row = |run: &Value| {
            let keys = [
                "title",
                "objectiveId",
                "why",
                "chatId",
                "entryId",
                "reaction",
            ];
            keys.map(|key| run[key].clone())
        };
        assert_eq!(
            row(&read["runs"][0]),
            [
                json!("Follow-up"),
                Value::Null,
                json!("ask how the talk went"),
                json!(chat.0),
                Value::Null,
                Value::Null
            ]
        );
        let entry = store.entries(made.objective.chat_id, None).unwrap()[1].id;
        assert_eq!(
            row(&read["runs"][1]),
            [
                json!("Ship the kite"),
                json!(made.objective.id.0),
                json!("see whether the first step is done"),
                json!(made.objective.chat_id.0),
                json!(entry.number()),
                json!("👍")
            ]
        );
        assert_eq!(
            read["objectives"][0]["hasOpenCheck"], false,
            "its check is done"
        );
    }

    struct NoTools;
    impl TurnTools for NoTools {
        fn bind(&self, _: &TurnIdentity, _: bool, _: TurnOwner) -> McpConnection {
            unreachable!("no turn runs in this test")
        }
        fn colleague_text_read(&self, _: TurnOwner, _: &str, _: bool) {}
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
        end_run(
            &store,
            ada,
            run,
            (RunOutcome::Silent, "", None, None),
            false,
        );
        chats.pane_changed(ada);
        assert_eq!(events.try_recv().unwrap().event["kind"], "paneChanged");
        assert!(others.try_recv().is_err(), "another user hears nothing");
    }
}
