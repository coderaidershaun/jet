//! Runs one check from claim to commit: reads the facts, starts the turn, holds the answer to the
//! evidence rule, and settles the run, the entry and the next task in one transaction.

use super::{Scheduler, brief::Gathered, inbox::Before};
use crate::lock;
use crate::objectives::ObjectiveError;
use crate::store::{
    AgentTask, ChatId, NewTask, RunId, RunOutcome, SetBy, Settled, Settlement, Source, SourceKind,
    Stale, StoreError, TaskEnd, TaskKind, Versions,
};
use crate::tool_facade::{CheckSpec, Checked, read_label};
use agent::{CheckDone, NewEntry, Role, ToolCall, WakeError};
use std::collections::HashSet;

/// A task that was cut off or failed is tried this many times in all.
const MAX_ATTEMPTS: u64 = 3;
/// How long after a restart, or a failure of the provider, a task waits before it runs again.
const AFTER_INTERRUPTION_SECONDS: u64 = 60;
const AFTER_FAILURE_SECONDS: u64 = 5 * 60;
/// A check that could not read a source tries once more after this long.
const AFTER_HELD_SECONDS: u64 = 15 * 60;
/// A check that the user's message stopped runs again after this long.
const AFTER_USER_WROTE_SECONDS: u64 = 10 * 60;
/// A check whose objective changed under it runs again on the new facts after this long, at most
/// this many times in a row.
const AFTER_STALE_SECONDS: u64 = 60;
const STALE_RERUNS: usize = 3;
/// A quiet check of a colleague's message that names no time looks again this long after.
const ITEM_AGAIN_SECONDS: u64 = 4 * 60 * 60;
/// When Jet sets no next check, the server sets one this long after.
const DEFAULT_NEXT_SECONDS: u64 = 24 * 60 * 60;

/// A moment a task waits for, with the words that go with it.
struct Later {
    due_at: u64,
    local_time: String,
    time_zone: String,
    why: String,
    set_by: SetBy,
}

impl Later {
    fn task(&self, kind: TaskKind) -> NewTask<'_> {
        NewTask {
            kind,
            why: &self.why,
            due_at: self.due_at,
            local_time: &self.local_time,
            time_zone: &self.time_zone,
            set_by: self.set_by,
        }
    }
}

/// What becomes of the task.
enum Ending {
    /// It is done, and this follows it.
    Next(Option<Later>),
    Wait {
        later: Later,
        counted: bool,
    },
    Failed,
}

/// How a check ended, before it is settled.
struct Verdict {
    outcome: RunOutcome,
    found: String,
    read: Vec<String>,
    tokens: Option<u64>,
    cost_usd: Option<f64>,
    entry: Option<NewEntry>,
    ending: Ending,
}

impl Scheduler {
    /// Puts back the tasks that were running when the server stopped: each waits a minute with
    /// the attempt counted, and the third time one is cut off it fails, with one notice. A task
    /// that brings up a colleague's message waits again without counting and is never given up.
    pub(super) fn recover(&self) -> Result<(), StoreError> {
        let now = (self.clock)();
        for (task, run) in self.store.running_tasks()? {
            let title = self.title_of(&task)?;
            let verdict = self.give_up_or_wait(
                &task,
                now,
                AFTER_INTERRUPTION_SECONDS,
                (
                    RunOutcome::Interrupted,
                    "the server stopped during the check",
                ),
                &title,
            )?;
            self.settle(&task, run, None, verdict)?;
        }
        Ok(())
    }

    /// Runs the check of a task that was just claimed.
    pub(super) fn check(&self, task: &AgentTask, run: RunId, now: u64) -> Result<(), StoreError> {
        let settings = self.store.settings(task.user)?;
        let gathered = match self.gather(task, &settings.persona.name) {
            Ok(gathered) => gathered,
            Err(ObjectiveError::Store(error)) => return Err(error),
            Err(error) => {
                let title = self.title_of(task)?;
                let found = format!("the facts could not be read: {error}");
                let verdict = self.give_up_or_wait(
                    task,
                    now,
                    AFTER_FAILURE_SECONDS,
                    (RunOutcome::Failed, &found),
                    &title,
                )?;
                return self.settle(task, run, None, verdict);
            }
        };
        if let Some((item, _)) = &gathered.item {
            let verdict = match self.before_item(task, item, &settings)? {
                Before::BringUp => None,
                Before::Answered => Some(without_entry(
                    RunOutcome::Spoke,
                    "answered from the objectives shared with the sender",
                )),
                Before::Closed => Some(without_entry(
                    RunOutcome::Silent,
                    "the item ended before the check",
                )),
                Before::Interrupted => Some(self.give_up_or_wait(
                    task,
                    self.now(),
                    AFTER_INTERRUPTION_SECONDS,
                    (
                        RunOutcome::Interrupted,
                        "the server stopped during the check",
                    ),
                    &gathered.title,
                )?),
            };
            if let Some(verdict) = verdict {
                return self.settle(task, run, None, verdict);
            }
        }
        let mut verdict = self.decide(task, &gathered, &settings, now)?;
        // A colleague's message is never given up: a failed check says nothing and tries again.
        if gathered.item.is_some() && matches!(verdict.ending, Ending::Failed) {
            verdict.entry = None;
            verdict.ending = Ending::Wait {
                later: self.keep(task, self.now() + ITEM_AGAIN_SECONDS),
                counted: false,
            };
        }
        let settled = self.settle_with(task, run, Some(gathered.versions), verdict)?;
        if let (Some((item, _)), Some(chats)) = (&gathered.item, self.chats.upgrade()) {
            chats.pane_changed(item.from);
        }
        if matches!(settled, Settlement::Stale(Stale::Objective)) {
            self.rerun_on_fresh_facts(task, run)?;
        }
        Ok(())
    }

    /// Starts the turn and turns its answer into a verdict.
    fn decide(
        &self,
        task: &AgentTask,
        gathered: &Gathered,
        settings: &crate::settings::Settings,
        now: u64,
    ) -> Result<Verdict, StoreError> {
        let held = |found: &str| self.held(task, found, Vec::new(), now);
        let has_web_source = gathered
            .sources
            .iter()
            .any(|source| source.kind == SourceKind::Web);
        if has_web_source && !settings.model.reads_web() {
            return held(
                "this provider has its web tools off, so it cannot read the web source of this objective",
            );
        }
        let title = &gathered.title;
        let Some(chat) = self
            .chats
            .upgrade()
            .and_then(|chats| chats.chat(task.user, Some(task.chat_id)).ok())
        else {
            return self.give_up_or_wait(
                task,
                now,
                AFTER_INTERRUPTION_SECONDS,
                (RunOutcome::Interrupted, "the server is closing"),
                title,
            );
        };
        let failed = |found: String| {
            self.give_up_or_wait(
                task,
                self.now(),
                AFTER_FAILURE_SECONDS,
                (RunOutcome::Failed, &found),
                title,
            )
        };
        let transport = match chat.transport_for(settings.model) {
            Ok(transport) => transport,
            Err(error) => return failed(error.to_string()),
        };
        let notes = self.store.notes(task.user)?;
        let connection = self.facade.bind_check(CheckSpec {
            owner: crate::chat::TurnOwner {
                user: task.user,
                chat: task.chat_id,
            },
            task: task.id,
            sources: gathered.sources.clone(),
            reads_web: settings.model.reads_web(),
            colleague_text: gathered.item.is_some(),
        });
        let start = agent::CheckStart {
            persona: &settings.persona,
            notes: &notes,
            model: settings.model,
            effort: settings.effort,
            brief: self.brief(task, gathered),
            mcp: connection.clone(),
            hosts: page_hosts(&gathered.sources),
            time_limit: (!settings.model.reads_web()).then_some(self.time_limit),
        };
        let turn = match agent::start_check(&*transport, &start) {
            Ok(turn) => turn,
            Err(error) => {
                self.facade.finish_check(&connection);
                return failed(error.to_string());
            }
        };
        self.signals.attach(turn.stopper(), &self.stopping);
        let result = turn.finish();
        let state = self.facade.finish_check(&connection);
        let now = self.now();
        match result {
            Ok(done) => self.answered(task, gathered, done, state.staged, &state.read, now),
            Err(error @ (WakeError::TimeLimit | WakeError::OverBudget { .. })) => {
                Ok(Self::cut_short(title, &error.to_string()))
            }
            // The server is stopping, or the user wrote (settle then makes it a preempted run).
            Err(WakeError::Stopped) => Ok(self.give_up_or_wait(
                task,
                now,
                AFTER_INTERRUPTION_SECONDS,
                (
                    RunOutcome::Interrupted,
                    "the server stopped during the check",
                ),
                title,
            )?),
            Err(error) => failed(error.to_string()),
        }
    }

    /// The check ended with an answer: hold it to the evidence rule, then post it or stay silent.
    fn answered(
        &self,
        task: &AgentTask,
        gathered: &Gathered,
        done: CheckDone,
        staged: Option<Checked>,
        read: &HashSet<String>,
        now: u64,
    ) -> Result<Verdict, StoreError> {
        let (read_sources, unread) = sort_sources(&gathered.sources, read, &done.tools);
        if !unread.is_empty() {
            let found = format!("could not read {}", unread.join(", "));
            return self.held(task, &found, read_sources, now);
        }
        let text = done.text.trim();
        let silent = text.is_empty() || text.contains(agent::SILENT);
        let found = staged.as_ref().map_or_else(
            || {
                if silent {
                    "nothing worth saying".to_owned()
                } else {
                    "posted a check-in".to_owned()
                }
            },
            |staged| staged.found.clone(),
        );
        let next = staged.and_then(|staged| staged.next);
        let later = match (next, task.kind) {
            (Some(next), _) => Some(Later {
                due_at: next.due_at,
                local_time: next.local_time,
                time_zone: next.time_zone,
                why: next.why,
                set_by: SetBy::Jet,
            }),
            (None, TaskKind::Check) => Some(self.default_next(task, now)),
            (None, TaskKind::FollowUp) => None,
        };
        let entry = (!silent).then(|| NewEntry {
            role: Role::Jet,
            mood: done.mood,
            tools: done.tools,
            colleague: gathered.item.as_ref().map(|(_, quote)| quote.clone()),
            ..NewEntry::user_text(text)
        });
        // A colleague's message is never dropped by a quiet check: it comes back, at the time Jet
        // gave or a few hours later, until the user has seen it or it expires.
        let ending = match (gathered.item.is_some() && silent, later) {
            (true, later) => Ending::Wait {
                later: later.unwrap_or_else(|| self.keep(task, now + ITEM_AGAIN_SECONDS)),
                counted: false,
            },
            (false, later) => Ending::Next(later),
        };
        Ok(Verdict {
            outcome: if silent {
                RunOutcome::Silent
            } else {
                RunOutcome::Spoke
            },
            found,
            read: read_sources,
            tokens: Some(done.tokens),
            cost_usd: done.cost_usd,
            entry,
            ending,
        })
    }

    /// A check that could not read every outside source posts nothing. The task tries once more,
    /// and when the second try is held too it is done, with the default next check.
    fn held(
        &self,
        task: &AgentTask,
        found: &str,
        read: Vec<String>,
        now: u64,
    ) -> Result<Verdict, StoreError> {
        let tried_before = self.store.past_outcomes(task.id)?.first() == Some(&RunOutcome::Held);
        let ending = if tried_before {
            Ending::Next(Some(self.default_next(task, now)))
        } else {
            Ending::Wait {
                later: self.keep(task, now + AFTER_HELD_SECONDS),
                counted: true,
            }
        };
        Ok(Verdict {
            outcome: RunOutcome::Held,
            found: found.to_owned(),
            read,
            tokens: None,
            cost_usd: None,
            entry: None,
            ending,
        })
    }

    /// A check that reached its money or time limit fails at once, with one notice.
    fn cut_short(title: &str, found: &str) -> Verdict {
        Verdict {
            outcome: RunOutcome::Failed,
            found: found.to_owned(),
            read: Vec::new(),
            tokens: None,
            cost_usd: None,
            entry: Some(notice(&format!(
                "My check on \"{title}\" ran longer than it should, so I stopped it. Want me to try again?"
            ))),
            ending: Ending::Failed,
        }
    }

    /// A run that was cut off or failed: the task waits `delay` seconds and the attempt counts,
    /// unless it was the last attempt, and then the task fails with one notice. A task that
    /// brings up a colleague's message is never given up: it waits and the attempt is not counted.
    fn give_up_or_wait(
        &self,
        task: &AgentTask,
        now: u64,
        delay: u64,
        (outcome, found): (RunOutcome, &str),
        title: &str,
    ) -> Result<Verdict, StoreError> {
        if self.store.item_of_task(task.id)?.is_some() {
            return Ok(Verdict {
                outcome,
                found: found.to_owned(),
                read: Vec::new(),
                tokens: None,
                cost_usd: None,
                entry: None,
                ending: Ending::Wait {
                    later: self.keep(task, now + ITEM_AGAIN_SECONDS),
                    counted: false,
                },
            });
        }
        let last = task.attempts >= MAX_ATTEMPTS;
        Ok(Verdict {
            outcome,
            found: found.to_owned(),
            read: Vec::new(),
            tokens: None,
            cost_usd: None,
            entry: last.then(|| {
                notice(&format!(
                    "I couldn't finish my check on \"{title}\", so I've stopped trying. Want me to try again?"
                ))
            }),
            ending: if last {
                Ending::Failed
            } else {
                Ending::Wait {
                    later: self.keep(task, now + delay),
                    counted: true,
                }
            },
        })
    }

    fn now(&self) -> u64 {
        (self.clock)()
    }

    /// The user wrote in the chat: nothing is posted and the check runs again later.
    fn preempted(&self, task: &AgentTask) -> Verdict {
        Verdict {
            outcome: RunOutcome::Preempted,
            found: "the user wrote in this chat, so the check stopped and runs again later".into(),
            read: Vec::new(),
            tokens: None,
            cost_usd: None,
            entry: None,
            ending: Ending::Wait {
                later: self.keep(task, self.now() + AFTER_USER_WROTE_SECONDS),
                counted: false,
            },
        }
    }

    /// The same task, waiting for a new moment.
    fn keep(&self, task: &AgentTask, due_at: u64) -> Later {
        Later {
            due_at,
            local_time: self
                .objectives
                .local_time(&task.time_zone, due_at)
                .unwrap_or_default(),
            time_zone: task.time_zone.clone(),
            why: task.why.clone(),
            set_by: task.set_by,
        }
    }

    fn default_next(&self, task: &AgentTask, now: u64) -> Later {
        let due_at = now + DEFAULT_NEXT_SECONDS;
        Later {
            why: "Jet set no next check".into(),
            set_by: SetBy::Default,
            ..self.keep(task, due_at)
        }
    }

    fn title_of(&self, task: &AgentTask) -> Result<String, StoreError> {
        Ok(match task.objective_id {
            Some(id) => self
                .store
                .objective(task.user, id)?
                .map_or_else(|| task.why.clone(), |objective| objective.title),
            None => task.why.clone(),
        })
    }

    /// Settles a run, and tells the open page of the chat about the entry it wrote.
    fn settle(
        &self,
        task: &AgentTask,
        run: RunId,
        seen: Option<Versions>,
        verdict: Verdict,
    ) -> Result<(), StoreError> {
        self.settle_with(task, run, seen, verdict).map(drop)
    }

    fn settle_with(
        &self,
        task: &AgentTask,
        run: RunId,
        seen: Option<Versions>,
        verdict: Verdict,
    ) -> Result<Settlement, StoreError> {
        // One lock holds the run's commit and the user's message apart: a message that came
        // while the check ran turns the verdict into a preempted run, so no check-in is posted
        // after it.
        let running = lock(&self.signals.0.running);
        let verdict = match running.as_ref() {
            Some(running) if running.preempted && verdict.outcome != RunOutcome::Preempted => {
                self.preempted(task)
            }
            _ => verdict,
        };
        let now = self.now();
        let end = match &verdict.ending {
            Ending::Next(later) => TaskEnd::Done(later.as_ref().map(|later| later.task(task.kind))),
            Ending::Wait { later, counted } => TaskEnd::Wait {
                with: later.task(task.kind),
                counted: *counted,
            },
            Ending::Failed => TaskEnd::Failed,
        };
        let settlement = self.store.settle(Settled {
            run,
            seen,
            outcome: verdict.outcome,
            found: &verdict.found,
            sources_read: &verdict.read,
            tokens: verdict.tokens,
            cost_usd: verdict.cost_usd,
            entry: verdict.entry,
            end,
            at: now,
        })?;
        if let Settlement::Applied(Some(entry)) = &settlement {
            self.announce(task.user, task.chat_id, entry);
        }
        // The run and the next task are on the user's pane, unless nothing was written.
        if !matches!(settlement, Settlement::Stale(Stale::Objective))
            && let Some(chats) = self.chats.upgrade()
        {
            chats.pane_changed(task.user);
        }
        Ok(settlement)
    }

    fn announce(&self, user: crate::store::UserId, chat: ChatId, entry: &agent::Entry) {
        let shown = agent::ShownEntry {
            html: agent::render_markdown(&entry.text),
            entry: entry.clone(),
        };
        if let Some(runtime) = self
            .chats
            .upgrade()
            .and_then(|chats| chats.chat(user, Some(chat)).ok())
        {
            runtime.announce(&shown);
        }
    }

    /// Only the objective changed while the check ran: its result is dropped and the check runs
    /// again on the fresh facts, not counted as an attempt, up to three times in a row. After
    /// that the task is done with the default next check.
    fn rerun_on_fresh_facts(&self, task: &AgentTask, run: RunId) -> Result<(), StoreError> {
        let now = self.now();
        let stale_before = self
            .store
            .past_outcomes(task.id)?
            .iter()
            .take_while(|outcome| **outcome == RunOutcome::Stale)
            .count();
        let ending = if stale_before >= STALE_RERUNS {
            Ending::Next(Some(self.default_next(task, now)))
        } else {
            Ending::Wait {
                later: self.keep(task, now + AFTER_STALE_SECONDS),
                counted: false,
            }
        };
        let verdict = Verdict {
            outcome: RunOutcome::Stale,
            found: "the objective changed while the check ran, so its result was dropped".into(),
            read: Vec::new(),
            tokens: None,
            cost_usd: None,
            entry: None,
            ending,
        };
        self.settle(task, run, None, verdict)
    }
}

/// A run that ends with no check-in and no next task.
fn without_entry(outcome: RunOutcome, found: &str) -> Verdict {
    Verdict {
        outcome,
        found: found.to_owned(),
        read: Vec::new(),
        tokens: None,
        cost_usd: None,
        entry: None,
        ending: Ending::Next(None),
    }
}

fn notice(text: &str) -> NewEntry {
    NewEntry {
        role: Role::Jet,
        ..NewEntry::user_text(text)
    }
}

/// The hosts of the objective's web page sources: the only pages a check may read.
fn page_hosts(sources: &[Source]) -> Vec<String> {
    sources
        .iter()
        .filter(|source| source.kind == SourceKind::Web && source.detail == "page")
        .filter_map(|source| {
            url::Url::parse(&source.target)
                .ok()?
                .host_str()
                .map(str::to_owned)
        })
        .collect()
}

/// Which sources this run read with success, as the run record names them, and which it did not.
/// A repository and an app tool are read when the facade saw a call succeed; a page when a
/// page read on the same host and under the same path came back; a search topic when any
/// search came back with results. Jet's own records are always read: the brief states them.
fn sort_sources(
    sources: &[Source],
    read: &HashSet<String>,
    tools: &[ToolCall],
) -> (Vec<String>, Vec<String>) {
    let web = |tool: &'static str| {
        tools
            .iter()
            .filter(move |call| call.server == "web" && call.tool == tool && call.ok)
    };
    let page_read = |page: &str| {
        let Ok(page) = url::Url::parse(page) else {
            return false;
        };
        web("fetch").any(|call| {
            call.input["url"]
                .as_str()
                .and_then(|text| url::Url::parse(text).ok())
                .is_some_and(|url| {
                    url.host_str() == page.host_str() && url.path().starts_with(page.path())
                })
        })
    };
    let (mut done, mut missing) = (Vec::new(), Vec::new());
    for source in sources {
        let (label, was_read) = match (source.kind, source.detail.as_str()) {
            (SourceKind::Jet, _) => ("jet".to_owned(), true),
            (SourceKind::Github | SourceKind::App, _) => {
                let label = read_label(source).unwrap_or_default();
                let was_read = read.contains(&label);
                (label, was_read)
            }
            (SourceKind::Web, "page") => {
                (format!("web {}", source.target), page_read(&source.target))
            }
            (SourceKind::Web, _) => (
                format!("web search {}", source.target),
                web("search").next().is_some(),
            ),
        };
        if was_read {
            done.push(label)
        } else {
            missing.push(label)
        }
    }
    (done, missing)
}
