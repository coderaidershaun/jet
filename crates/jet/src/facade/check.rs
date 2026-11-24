//! The binding of a check turn. A check may only read: it reads GitHub, Jet's own records and the
//! app tools its objective names as sources, and it records what it found with `tasks_update`
//! `checked`. The record waits in the binding until the server commits the check, so a check
//! that is stopped or dropped writes nothing.

use super::{Binding, Facade, handler::Handler};
use crate::chat::{TurnContext, TurnOwner};
use crate::store::{Source, SourceKind, TaskId};
use agent::{McpConnection, TurnIdentity};
use serde_json::{Value, json};
use std::collections::HashSet;

/// What a check turn is bound to.
pub(crate) struct CheckSpec {
    pub owner: TurnOwner,
    pub task: TaskId,
    /// The sources of the task's objective; a follow-up has none.
    pub sources: Vec<Source>,
    pub reads_web: bool,
}

/// What a check read and recorded, staged in its binding.
#[derive(Clone, Default)]
pub(crate) struct CheckState {
    sources: Vec<Source>,
    pub(super) staged: Option<Checked>,
    read: Vec<String>,
}

/// What Jet recorded with `tasks_update` `checked`: what it found, and when it looks next.
#[derive(Debug, Clone)]
pub(crate) struct Checked {
    pub found: String,
    pub next: Option<NextCheck>,
}

#[derive(Debug, Clone)]
pub(crate) struct NextCheck {
    pub due_at: u64,
    pub local_time: String,
    pub time_zone: String,
    pub why: String,
}

/// What the binding holds when the check is over.
pub(crate) struct CheckResult {
    pub staged: Option<Checked>,
    /// The sources that a successful call read, as `read_label` writes them.
    pub read: HashSet<String>,
}

/// How a successful read of a GitHub or app source is named, so a call and a source meet. Pages
/// and searches are read by the provider's own web tools, which the facade does not see.
pub(crate) fn read_label(source: &Source) -> Option<String> {
    match source.kind {
        SourceKind::Github => Some(format!("github {}", source.target.to_lowercase())),
        SourceKind::App => Some(format!("app {} {}", source.target, source.detail)),
        SourceKind::Jet | SourceKind::Web => None,
    }
}

impl Facade {
    /// Binds a check turn, which has no user message and no browser behind it.
    pub(crate) fn bind_check(&self, spec: CheckSpec) -> McpConnection {
        let identity = TurnIdentity {
            request_id: format!("check-{}", spec.task.0),
            client_id: "server".to_owned(),
            turn_id: uuid::Uuid::new_v4().to_string(),
            request: Value::Null,
        };
        let token = uuid::Uuid::new_v4().to_string();
        crate::lock(&self.bindings).insert(
            token.clone(),
            Binding {
                turn: TurnContext::from(&identity),
                calls: HashSet::new(),
                reads_web: spec.reads_web,
                owner: spec.owner,
                has_read_strangers: false,
                check: Some(CheckState {
                    sources: spec.sources,
                    ..CheckState::default()
                }),
            },
        );
        McpConnection {
            url: crate::lock(&self.url).clone(),
            token,
        }
    }

    /// Ends the binding of a check turn and gives what it read and recorded.
    pub(crate) fn finish_check(&self, connection: &McpConnection) -> CheckResult {
        let binding = crate::lock(&self.bindings).remove(&connection.token);
        crate::lock(&self.sessions).retain(|_, bound| bound != &connection.token);
        let state = binding
            .map(|binding| {
                for id in binding.calls {
                    self.mcp.cancel_request(&id);
                }
                binding.check.unwrap_or_default()
            })
            .unwrap_or_default();
        CheckResult {
            staged: state.staged,
            read: state.read.into_iter().collect(),
        }
    }
}

impl Handler {
    /// Why a call on a check is refused, or `None` when the check may make it. A check may read
    /// GitHub and Jet's own records, call a tool that its objective names as a source while the
    /// app still marks it read-only, and record what it found. Every other tool is refused,
    /// those that change something, share or send among them.
    pub(super) async fn refuse_on_check(
        &self,
        name: &str,
        arguments: &Value,
        check: &CheckState,
        binding: &Binding,
    ) -> Option<Value> {
        let refusal = |kind: &str, message: &str| Some(json!({"kind": kind, "message": message}));
        match name {
            "github_activity" | "tasks_list" | "chats_read" | "people_list" => None,
            "objectives_list" if arguments.get("owner").is_none() => None,
            "tasks_update" if arguments["command"]["action"] == "checked" => None,
            "tools_call" | "tools_describe" => {
                let named = |key: &str| arguments[key].as_str().unwrap_or_default();
                let is_source = check.sources.iter().any(|source| {
                    source.kind == SourceKind::App
                        && source.target == named("appId")
                        && source.detail == named("tool")
                });
                if !is_source {
                    return refusal(
                        "notASource",
                        "a check calls only an app tool that its objective names as a source",
                    );
                }
                if name == "tools_call" && !self.read_only(arguments, binding).await {
                    return refusal(
                        "notReadOnly",
                        "the app no longer marks this tool read-only, so a check may not call it",
                    );
                }
                None
            }
            _ => refusal(
                "checkIsReadOnly",
                "a check may only read: it reads GitHub, Jet's own records and the objective's source tools, and records what it found with tasks_update `checked`. Tell the user in your check-in what you wanted to do",
            ),
        }
    }

    /// Notes that a call of the check came back with a result, for the sources it read.
    pub(super) fn note_read(&self, token: &str, name: &str, arguments: &Value, result: &Value) {
        let label = match name {
            "github_activity" => format!(
                "github {}",
                arguments["repo"]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase()
            ),
            "tools_call" if result["isError"] != true => format!(
                "app {} {}",
                arguments["appId"].as_str().unwrap_or_default(),
                arguments["tool"].as_str().unwrap_or_default()
            ),
            _ => return,
        };
        if let Some(check) = crate::lock(&self.0.bindings)
            .get_mut(token)
            .and_then(|binding| binding.check.as_mut())
        {
            check.read.push(label);
        }
    }
}
