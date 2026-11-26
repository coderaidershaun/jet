//! Route provider requests through the host registry and shared HTTP client.
use super::{Binding, Facade, HEADER, handoff, marks, tools};
use crate::chat::RunningCall;
use crate::files::{ExportRequest, Range, Reading};
use crate::store::{ObjectiveId, UserId};
use crate::{lock, on_worker};
use agent::{
    apps::{AppId, RegistryCommand},
    mcp::{ToolRequest, ToolTarget},
};
use rmcp::{RoleServer, ServerHandler, model::*, service::RequestContext};
use serde_json::to_value;
use serde_json::{Map, Value, json};
use std::{collections::HashMap, fmt::Display, sync::Arc};
use tokio::sync::mpsc;

const SEARCHED_APP_LIMIT: usize = 128;
const FOUND_TOOL_LIMIT: usize = 200;
/// The progress updates that may wait for the chat. Further ones are dropped.
const PROGRESS_QUEUE: usize = 16;

#[derive(Clone)]
pub(super) struct Handler(pub Arc<Facade>);
impl ServerHandler for Handler {
    fn get_info(&self) -> ServerConfig {
        let mut info = ServerConfig::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.instructions = Some("All enabled apps are globally available. Search concise summaries, describe schemas, then call with appId and real tool name. Registry actions return authoritative persisted outcomes.".into());
        info
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, rmcp::ErrorData> {
        Ok(ListToolsResult {
            tools: tools::definitions().to_vec(),
            ..Default::default()
        })
    }
    async fn call_tool(
        &self,
        params: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, rmcp::ErrorData> {
        let parts = context
            .extensions
            .get::<axum::http::request::Parts>()
            .ok_or_else(expired)?;
        let token = parts
            .headers
            .get(HEADER)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(expired)?
            .to_owned();
        let binding = self.0.binding(&token).ok_or_else(expired)?;
        let arguments = Value::Object(params.arguments.unwrap_or_default());
        tools::validate(&params.name, &arguments)?;
        if let Some(check) = &binding.check
            && let Some(refusal) = self
                .refuse_on_check(&params.name, &arguments, check, &binding)
                .await
        {
            return Ok(CallToolResult::structured_error(json!({"error": refusal})).into());
        }
        if params.name == "files_read" {
            return Ok(match self.read_file(&arguments, &binding).await {
                Ok(result) => result,
                Err(error) => CallToolResult::structured_error(json!({"error":error})),
            }
            .into());
        }
        if let Some(refusal) = self
            .refuse_after_web_text(&params.name, &arguments, &binding, &context)
            .await
        {
            let error = json!({"kind": refusal.kind(), "message": refusal.to_string()});
            return Ok(CallToolResult::structured_error(json!({"error": error})).into());
        }
        let sent = binding.check.is_some().then(|| arguments.clone());
        let result = self
            .execute(&params.name, arguments, &token, binding, context)
            .await;
        if let (Some(sent), Ok(value)) = (&sent, &result) {
            self.note_read(&token, &params.name, sent, value);
        }
        Ok(match result {
            Ok(value) if value["isError"] == true => CallToolResult::structured_error(value),
            Ok(value) => CallToolResult::structured(value),
            Err(error) => CallToolResult::structured_error(json!({"error":error})),
        }
        .into())
    }
}
/// Why a call that could change something, or send the user's data out, was refused after the
/// turn read web text. A web page can hold instructions from a stranger, so only the user's next
/// message can allow such a call.
#[derive(Debug, thiserror::Error)]
enum WriteRefused {
    #[error(
        "this reply has read web text or a colleague's words, so Jet refuses changes to apps, people, shares and the sources of an objective, removing a file, sending to colleagues, and app tools that are not read-only, until the user's next message. Tell the user exactly what you wanted to do, so their next message can allow it"
    )]
    WriteAfterWebText,
    #[error(
        "this call names no tool use, so Jet cannot tell whether web text came before it. Tell the user exactly what you wanted to do, so their next message can allow it"
    )]
    NoToolUseId,
    #[error(
        "the reply ended before Jet could check what it had read. Tell the user exactly what you wanted to do, so their next message can allow it"
    )]
    TurnEnded,
}

impl WriteRefused {
    fn kind(&self) -> &'static str {
        match self {
            WriteRefused::WriteAfterWebText => "writeAfterWebText",
            WriteRefused::NoToolUseId => "noToolUseId",
            WriteRefused::TurnEnded => "turnEnded",
        }
    }
}

fn expired() -> rmcp::ErrorData {
    rmcp::ErrorData::invalid_request("initiating turn has expired", None)
}
pub(super) fn message(error: impl Display) -> Value {
    json!({"message":error.to_string()})
}
impl Handler {
    /// Reads part of a file. A picture comes back as an image block with its facts beside it as
    /// text, and no structured result, so the picture's bytes never reach the saved transcript.
    async fn read_file(
        &self,
        arguments: &Value,
        binding: &Binding,
    ) -> Result<CallToolResult, Value> {
        let number = |key: &str| {
            arguments[key]
                .as_u64()
                .and_then(|number| usize::try_from(number).ok())
        };
        let range = Range {
            sheet: arguments["sheet"].as_str().map(str::to_owned),
            start: number("start"),
            count: number("count"),
        };
        let id = arguments["id"].as_str().unwrap_or_default();
        let user = binding.owner.user;
        let (about, reading) = self.0.files.read(user, id, &range).await.map_err(message)?;
        Ok(match reading {
            Reading::Image {
                data,
                width,
                height,
            } => {
                let facts = json!({"id":about.id,"name":about.name,"kind":about.kind,"details":about.details,"context":about.context,"note":"a picture has no text to read; this is what Jet knows about it","mime":"image/jpeg","width":width,"height":height});
                CallToolResult::success(vec![
                    ContentBlock::image(data, "image/jpeg"),
                    ContentBlock::text(facts.to_string()),
                ])
            }
            text => {
                let mut reading = json!(text);
                reading["id"] = json!(about.id);
                reading["name"] = json!(about.name);
                CallToolResult::structured(reading)
            }
        })
    }

    /// The arguments for the tool, with each `{"$file": id}` replaced by the address of that file.
    /// A file the model cannot see is refused here, so the tool is never called with its address.
    async fn with_file_addresses(
        &self,
        arguments: &Value,
        binding: &Binding,
    ) -> Result<Map<String, Value>, Value> {
        let ids: Vec<String> = handoff::file_ids(arguments)
            .into_iter()
            .map(str::to_owned)
            .collect();
        let mut addressed = arguments.clone();
        if !ids.is_empty() {
            let files = self.0.files.clone();
            let user = binding.owner.user;
            let visible = on_worker(move || {
                ids.into_iter()
                    .map(|id| match files.visible_id(user, &id) {
                        Some(file) => Ok((id, file)),
                        None => Err(id),
                    })
                    .collect::<Result<HashMap<_, _>, _>>()
            })
            .await
            .map_err(message)?
            .map_err(|id| {
                message(format!(
                    "`$file` names no file in this conversation: {id}. Use files_list to find the file's id."
                ))
            })?;
            let origin = self.0.origin().map_err(message)?;
            handoff::swap_for_addresses(&mut addressed, &origin, &visible, &self.0.keys);
        }
        match addressed {
            Value::Object(fields) => Ok(fields),
            _ => Ok(Map::new()),
        }
    }

    /// Refuses `apps_update`, `people_update`, `tasks_update` with `send`, `objectives_update` with
    /// `propose_share` or with sources to add or change, and a
    /// `tools_call` whose tool is not marked read-only, once the turn has read web text,
    /// `github_activity`, a colleague's shared objectives (`objectives_list` with `owner`) or a
    /// colleague's message, which the turn's prompt or its binding says. It first waits until the turn's stream has passed
    /// this call's own tool-use line, so every web read before the call has been seen. When the
    /// order cannot be known, the call is refused too. A Codex or agy turn has no web tools, so
    /// there only such a read that reached Jet earlier counts.
    async fn refuse_after_web_text(
        &self,
        name: &str,
        arguments: &Value,
        binding: &Binding,
        context: &RequestContext<RoleServer>,
    ) -> Option<WriteRefused> {
        let command = &arguments["command"];
        let has_sources = |sources: &Value| sources.as_array().is_some_and(|list| !list.is_empty());
        let sends = name == "tasks_update" && command["action"] == "send";
        // A removed file cannot be brought back.
        let removes_file = name == "files_update" && command["action"] == "remove";
        let changes_shares = name == "objectives_update"
            && match command["action"].as_str() {
                Some("propose_share") => true,
                // Sources decide what later checks read, so web text may not add or change them.
                Some("create") => has_sources(&command["sources"]),
                Some("edit") => !command["sources"].is_null(),
                _ => false,
            };
        if !(matches!(name, "apps_update" | "tools_call" | "people_update")
            || changes_shares
            || removes_file
            || sends)
        {
            return None;
        }
        // A colleague's message in the prompt counts at once, before any stream is read.
        if binding.colleague_text && (binding.colleague_item || !sends) {
            let is_allowed = name == "tools_call" && self.read_only(arguments, binding).await;
            return (!is_allowed).then_some(WriteRefused::WriteAfterWebText);
        }
        if !binding.reads_web {
            let is_allowed = !binding.has_read_strangers
                || (name == "tools_call" && self.read_only(arguments, binding).await);
            return (!is_allowed).then_some(WriteRefused::WriteAfterWebText);
        }
        let card = context
            .meta
            .get(agent::TOOL_USE_META)
            .and_then(Value::as_str);
        let chat = self.0.chat_of(binding);
        let read_web = match (card, chat) {
            (Some(card), Some(chat)) => chat.read_web_before(&binding.turn, card).await,
            _ => None,
        };
        if read_web == Some(false)
            || (name == "tools_call" && self.read_only(arguments, binding).await)
        {
            return None;
        }
        Some(match (card, read_web) {
            (None, _) => WriteRefused::NoToolUseId,
            (_, None) => WriteRefused::TurnEnded,
            _ => WriteRefused::WriteAfterWebText,
        })
    }

    /// Whether the app marks the tool `readOnlyHint`. A tool that cannot be found, or of an app
    /// that is not the turn's user's, is not.
    pub(super) async fn read_only(&self, arguments: &Value, binding: &Binding) -> bool {
        let Ok(target) = serde_json::from_value::<ToolTarget>(arguments.clone()) else {
            return false;
        };
        if self.owned(&target.app_id, binding).is_err() {
            return false;
        }
        let Ok(catalogue) = self.0.mcp.catalogue(&target.app_id).await else {
            return false;
        };
        catalogue.tools.iter().any(|tool| {
            tool.name == target.tool
                && tool
                    .annotations
                    .as_ref()
                    .is_some_and(|annotations| annotations["readOnlyHint"] == true)
        })
    }

    async fn tools_call(
        &self,
        arguments: Value,
        token: &str,
        binding: Binding,
        context: RequestContext<RoleServer>,
    ) -> Result<Value, Value> {
        let target: ToolTarget = serde_json::from_value(arguments.clone()).map_err(message)?;
        self.owned(&target.app_id, &binding)?;
        // A call that names no card has its card found by the arguments the model wrote, so they
        // are kept from before any `$file` swap.
        let sent = arguments["arguments"].clone();
        let request_id = format!("{}:{}", binding.turn.turn_id, context.id);
        let request = ToolRequest {
            request_id: request_id.clone(),
            target: target.clone(),
            arguments: self.with_file_addresses(&sent, &binding).await?,
        };
        let running = RunningCall {
            card_id: context
                .meta
                .get(agent::TOOL_USE_META)
                .and_then(Value::as_str),
            target: &target,
            arguments: &sent,
        };
        let (progress_sender, mut progress) = mpsc::channel(PROGRESS_QUEUE);
        let call = {
            let mut bindings = lock(&self.0.bindings);
            bindings
                .get_mut(token)
                .ok_or_else(|| message("initiating turn expired"))?
                .calls
                .insert(request_id.clone());
            self.0.mcp.call_with_progress(request, progress_sender)
        };
        tokio::pin!(call);
        let result = loop {
            tokio::select! {
                result = &mut call => break result,
                Some(update) = progress.recv() => {
                    if let Some(chat) = self.0.chat_of(&binding) {
                        chat.tool_progress(&binding.turn, &running, update);
                    }
                }
                _ = context.ct.cancelled() => { self.0.mcp.cancel_request(&request_id); return Err(json!({"kind":"cancelled","requestId":request_id})); }
            }
        };
        if let Some(binding) = lock(&self.0.bindings).get_mut(token) {
            binding.calls.remove(&request_id);
        }
        let result = result.map_err(|e| json!(e))?;
        Ok(json!(result))
    }

    async fn execute(
        &self,
        name: &str,
        arguments: Value,
        token: &str,
        binding: Binding,
        context: RequestContext<RoleServer>,
    ) -> Result<Value, Value> {
        let user = binding.owner.user;
        match name {
            "apps_list" => Ok(json!(self.0.apps.list(user))),
            "apps_update" => self.apps_update(&arguments, &binding).await,
            "apps_open" => self.apps_open(&arguments, &binding),
            "tools_search" => self.tools_search(&arguments, &binding).await,
            "tools_describe" => self.tools_describe(arguments, &binding).await,
            "tools_call" => self.tools_call(arguments, token, binding, context).await,
            "files_export" => {
                let result = self.files_export(arguments, &binding).await;
                if let (Ok(_), Some(chats)) = (&result, self.0.chats()) {
                    chats.pane_changed(user);
                }
                result
            }
            "files_update" => {
                let result = self.files_update(&arguments, &binding).await;
                if let (Ok(_), Some(chats)) = (&result, self.0.chats()) {
                    chats.pane_changed(user);
                }
                result
            }
            "files_list" => self.files_list(&arguments, &binding).await,
            "github_activity" => self.github_activity(&arguments, token, &binding).await,
            "objectives_list" => self.objectives_list(&arguments, token, &binding).await,
            "objectives_update" => {
                let result = self.objectives_update(&arguments, &binding).await;
                // The command may have made the objective a chat of its own.
                if let (Ok(answer), Some(chats)) = (&result, self.0.chats()) {
                    chats.chats_changed(user, None);
                    chats.pane_changed(user);
                    // A step command may leave out the objective's id; its answer names it.
                    let goal = answer["objective"]["id"].as_i64();
                    if let Some(id) = goal.or(arguments["command"]["id"].as_i64()) {
                        chats.viewers_pane_changed(ObjectiveId(id));
                    }
                }
                result
            }
            "tasks_list" => self.tasks_list(&binding).await,
            "tasks_update" => {
                let result = self.tasks_update(&arguments, token, &binding).await;
                if let (Ok(_), Some(chats)) = (&result, self.0.chats()) {
                    chats.pane_changed(user);
                }
                result
            }
            "people_list" => self.people_list().await,
            "people_update" => {
                let result = self.people_update(&arguments, &binding).await;
                // A team's members decide who sees what is shared with it.
                let member = arguments["command"]["user"].as_i64();
                if let (Ok(_), Some(member), Some(chats)) = (&result, member, self.0.chats()) {
                    chats.pane_changed(UserId(member));
                }
                result
            }
            "chats_read" => self.chats_read(&arguments, &binding).await,
            _ => Err(message("unknown facade tool")),
        }
    }

    /// Changes the turn's user's apps, with the same rule as the page: only an admin may save an
    /// app at a port, a loopback or a private address. A refusal comes back with its kind.
    async fn apps_update(&self, arguments: &Value, binding: &Binding) -> Result<Value, Value> {
        let command: RegistryCommand =
            serde_json::from_value(arguments["command"].clone()).map_err(message)?;
        let (apps, user) = (self.0.apps.clone(), binding.owner.user);
        on_worker(move || apps.execute(user, command))
            .await
            .map_err(message)?
            .map(|result| json!(result))
            .map_err(|error| to_value(&error).unwrap_or_else(|_| message(&error)))
    }

    /// Refuses an app that is not the turn's user's, in the same words as a missing one.
    fn owned(&self, id: &AppId, binding: &Binding) -> Result<(), Value> {
        match self.0.apps.owned(binding.owner.user, id) {
            Some(_) => Ok(()),
            None => Err(message("app is no longer registered")),
        }
    }

    fn apps_open(&self, arguments: &Value, binding: &Binding) -> Result<Value, Value> {
        let id: AppId = serde_json::from_value(arguments["appId"].clone()).map_err(message)?;
        self.owned(&id, binding)?;
        let chat = self
            .0
            .chat_of(binding)
            .ok_or_else(|| message("host closed"))?;
        chat.open_app(&binding.turn, &id).map_err(message)?;
        Ok(json!({"appId":id,"opened":true}))
    }

    async fn tools_search(&self, arguments: &Value, binding: &Binding) -> Result<Value, Value> {
        let ids: Vec<_> = self
            .0
            .apps
            .list(binding.owner.user)
            .iter()
            .filter(|app| app.enabled && app.mcp_url.is_some())
            .map(|app| app.id.clone())
            .collect();
        let query = marks::Query::new(arguments["query"].as_str().unwrap_or_default());
        let mut found = Vec::new();
        let mut errors = Vec::new();
        let mut truncated = ids.len() > SEARCHED_APP_LIMIT;
        let mut pending = tokio::task::JoinSet::new();
        for id in ids.into_iter().take(SEARCHED_APP_LIMIT) {
            let client = self.0.mcp.clone();
            pending.spawn(async move {
                let result = client.catalogue(&id).await;
                (id, result)
            });
        }
        while let Some(result) = pending.join_next().await {
            let (id, result) = result.map_err(message)?;
            match result {
                Ok(catalogue) => {
                    if catalogue.is_stale {
                        errors
                            .push(json!({"appId":id,"error":catalogue.last_error,"isStale":true}));
                    }
                    for tool in catalogue.tools {
                        if found.len() >= FOUND_TOOL_LIMIT {
                            truncated = true;
                            break;
                        }
                        if query.matches(&tool) {
                            let mut row =
                                json!({"appId":id,"tool":tool.name,"description":tool.description});
                            if let Some(group) = marks::group(&tool) {
                                row["group"] = json!(group);
                            }
                            found.push(row);
                        }
                    }
                }
                Err(e) => errors.push(json!({"appId":id,"error":e})),
            }
        }
        found.sort_by_cached_key(|tool| format!("{}:{}", tool["appId"], tool["tool"]));
        Ok(json!({"tools":found,"errors":errors,"truncated":truncated}))
    }

    async fn tools_describe(&self, arguments: Value, binding: &Binding) -> Result<Value, Value> {
        let target: ToolTarget = serde_json::from_value(arguments).map_err(message)?;
        self.owned(&target.app_id, binding)?;
        let catalogue = self
            .0
            .mcp
            .catalogue(&target.app_id)
            .await
            .map_err(|e| json!(e))?;
        let tool = catalogue
            .tools
            .into_iter()
            .find(|tool| tool.name == target.tool)
            .ok_or_else(|| message("tool is not listed"))?;
        let mut described = json!({"appId":target.app_id,"tool":tool,"server":catalogue.server,"isStale":catalogue.is_stale,"lastError":catalogue.last_error});
        if let Some(group) = marks::group(&tool) {
            described["group"] = json!(group);
        }
        if let Some(cost) = marks::cost(&tool) {
            described["cost"] = json!(cost);
        }
        Ok(described)
    }

    /// Reads the repository for the user of the turn. The turn is marked first, so a later call
    /// that changes something knows that text from strangers came in.
    async fn github_activity(
        &self,
        arguments: &Value,
        token: &str,
        binding: &Binding,
    ) -> Result<Value, Value> {
        if let Some(bound) = lock(&self.0.bindings).get_mut(token) {
            bound.has_read_strangers = true;
        }
        let evidence = self.0.evidence.clone();
        let user = binding.owner.user;
        let repo = arguments["repo"].as_str().unwrap_or_default().to_owned();
        let since = arguments["since"].as_str().unwrap_or_default().to_owned();
        on_worker(move || evidence.github_activity(user, &repo, &since))
            .await
            .map_err(message)?
            .map_err(|error| json!({"kind": error.kind(), "message": error.to_string()}))
    }

    async fn files_export(&self, arguments: Value, binding: &Binding) -> Result<Value, Value> {
        let request: ExportRequest = serde_json::from_value(arguments).map_err(message)?;
        let (files, user, chat) = (self.0.files.clone(), binding.owner.user, binding.owner.chat);
        let saved = on_worker(move || files.export(user, chat, request))
            .await
            .map_err(message)?
            .map_err(message)?;
        Ok(json!(saved))
    }
}
