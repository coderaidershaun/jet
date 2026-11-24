//! Reads, from the database at the moment a check starts, the facts the check's brief states and
//! the versions that the result is held to.

use super::Scheduler;
use crate::objectives::ObjectiveError;
use crate::store::{AgentTask, Item, Source, SourceKind, Versions};
use agent::{CheckFacts, CheckInState, Colleague, ColleagueFacts, ObjectiveFacts, Role, StepFacts};

/// The most entries of the chat that are read to answer the questions of the brief.
const ENTRIES_READ: usize = 200;

pub(super) struct Gathered {
    pub facts: CheckFacts,
    pub versions: Versions,
    pub sources: Vec<Source>,
    /// What the check's notices call the task: the objective's title, or the task's reason.
    pub title: String,
    /// The colleague's message the task brings to the user, and the quote that goes with it.
    pub item: Option<(Item, Colleague)>,
}

impl Scheduler {
    /// The facts of a running task. The objective is read first, so a change made while the facts
    /// are read moves its version past the one the result is held to.
    pub(super) fn gather(&self, task: &AgentTask, name: &str) -> Result<Gathered, ObjectiveError> {
        let user = task.user;
        let now = self.objectives.now();
        let objective = task
            .objective_id
            .map(|id| self.objectives.show(user, id))
            .transpose()?;
        let entries = self.store.entries(task.chat_id, Some(ENTRIES_READ))?;
        let when = |ms: u64| self.objectives.describe(user, ms / 1000);

        let after_last_check_in = entries
            .iter()
            .rposition(|entry| entry.role == Role::Jet && entry.check.is_some())
            .map_or(&entries[..0], |at| &entries[at..]);
        let last_check_in = match after_last_check_in.first() {
            None => CheckInState::None,
            Some(_) if after_last_check_in.iter().any(|e| e.role == Role::User) => {
                CheckInState::Answered
            }
            Some(posted) => match posted.reaction_by(Role::User) {
                Some(emoji) => CheckInState::Reacted(emoji.to_owned()),
                None if self.store.unread(task.chat_id)? > 0 => CheckInState::Unread,
                None => CheckInState::Unanswered,
            },
        };
        let unanswered = entries
            .iter()
            .rev()
            .take_while(|entry| entry.role == Role::Jet)
            .filter(|entry| entry.check.is_some() && entry.reaction_by(Role::User).is_none())
            .count();
        let last_user_message = entries
            .iter()
            .rev()
            .find(|entry| entry.role == Role::User)
            .map(|entry| when(entry.at))
            .transpose()?;

        let (objective_facts, versions, sources, title) = match &objective {
            Some(view) => (
                Some(ObjectiveFacts {
                    title: view.objective.title.clone(),
                    deliverable: view.objective.deliverable.clone(),
                    start: view.objective.start.clone(),
                    due: view.objective.due.clone(),
                    days_left: view.days_left,
                    steps: view
                        .steps
                        .iter()
                        .map(|step| StepFacts {
                            title: step.title.clone(),
                            done: step.done_at.is_some(),
                            due: step.due.clone(),
                        })
                        .collect(),
                    sources: view.sources.iter().map(describe_source).collect(),
                    last_note: view.notes.last().map(|note| {
                        let mut text = note.status.map_or(note.moved.clone(), |status| {
                            format!("{}: {}", status.as_str(), note.moved)
                        });
                        if !note.blockers.is_empty() {
                            text.push_str(&format!(" (blockers: {})", note.blockers));
                        }
                        text
                    }),
                }),
                Some((view.objective.id, view.objective.version)),
                view.sources.clone(),
                view.objective.title.clone(),
            ),
            None => (None, None, Vec::new(), task.why.clone()),
        };
        let item = self
            .store
            .item_of_task(task.id)?
            .map(|item| self.objectives.quote(&item).map(|quote| (item, quote)))
            .transpose()?;
        let facts = CheckFacts {
            local_time: self.objectives.describe(user, now)?,
            why: task.why.clone(),
            set_on: self.objectives.describe(user, task.created_at)?,
            late_seconds: now.saturating_sub(task.due_at),
            objective: objective_facts,
            last_check_in,
            unanswered,
            last_user_message,
            entries: entries
                .into_iter()
                .filter(|entry| !entry.text.trim().is_empty())
                .map(|entry| (entry.role, entry.text))
                .collect(),
            jet_name: name.to_owned(),
            colleague: item.as_ref().map(|(_, quote)| ColleagueFacts {
                item: quote.item,
                from: quote.name.clone(),
                kind: quote.kind.clone(),
                sent: self.objectives.describe(user, quote.at).unwrap_or_default(),
                text: quote.text.clone(),
            }),
        };
        Ok(Gathered {
            facts,
            versions: Versions {
                task: task.version,
                objective: versions,
            },
            sources,
            title,
            item,
        })
    }
}

fn describe_source(source: &Source) -> String {
    match (source.kind, source.detail.as_str()) {
        (SourceKind::Jet, _) => "Jet's own records: this objective, its notes and this chat".into(),
        (SourceKind::Github, login) => format!(
            "GitHub repository {} (the user's login is {login}); read it with github_activity",
            source.target
        ),
        (SourceKind::Web, "page") => format!("Web page {}", source.target),
        (SourceKind::Web, _) => format!("Web search for: {}", source.target),
        (SourceKind::App, tool) => format!(
            "Tool {tool} of the app {}; read it with tools_call",
            source.target
        ),
    }
}
