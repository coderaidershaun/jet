//! Route provider requests through the host registry and shared HTTP client.
use super::{Binding, Facade, HEADER, handoff, marks, tools};
use crate::chat::{RunningCall, lock};
use crate::files::{ExportRequest, Range, Reading};
use agent::{
    apps::{AppId, RegistryCommand},
    mcp::{ToolRequest, ToolTarget},
};
use rmcp::{RoleServer, ServerHandler, model::*, service::RequestContext};
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
        if params.name == "files_read" {
            return Ok(match self.read_file(&arguments).await {
                Ok(result) => result,
                Err(error) => CallToolResult::structured_error(json!({"error":error})),
            }
            .into());
        }
        let result = self
            .execute(&params.name, arguments, &token, binding, context)
            .await;
        Ok(match result {
            Ok(value) if value["isError"] == true => CallToolResult::structured_error(value),
            Ok(value) => CallToolResult::structured(value),
            Err(error) => CallToolResult::structured_error(json!({"error":error})),
        }
        .into())
    }
}
fn expired() -> rmcp::ErrorData {
    rmcp::ErrorData::invalid_request("initiating turn has expired", None)
}
fn message(error: impl Display) -> Value {
    json!({"message":error.to_string()})
}
impl Handler {
    /// Reads part of a file. A picture comes back as an image block with its facts beside it as
    /// text, and no structured result, so the picture's bytes never reach the saved transcript.
    async fn read_file(&self, arguments: &Value) -> Result<CallToolResult, Value> {
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
        let (about, reading) = self.0.files.read(id, &range).await.map_err(message)?;
        Ok(match reading {
            Reading::Image {
                data,
                width,
                height,
            } => {
                let facts = json!({"id":about.id,"name":about.name,"mime":"image/jpeg","width":width,"height":height});
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
    async fn with_file_addresses(&self, arguments: &Value) -> Result<Map<String, Value>, Value> {
        let ids: Vec<String> = handoff::file_ids(arguments)
            .into_iter()
            .map(str::to_owned)
            .collect();
        let mut addressed = arguments.clone();
        if !ids.is_empty() {
            let files = self.0.files.clone();
            let visible = tokio::task::spawn_blocking(move || {
                ids.into_iter()
                    .map(|id| match files.visible_id(&id) {
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
            handoff::swap_for_addresses(&mut addressed, &origin, &visible);
        }
        match addressed {
            Value::Object(fields) => Ok(fields),
            _ => Ok(Map::new()),
        }
    }

    async fn tools_call(
        &self,
        arguments: Value,
        token: &str,
        binding: Binding,
        context: RequestContext<RoleServer>,
    ) -> Result<Value, Value> {
        let target: ToolTarget = serde_json::from_value(arguments.clone()).map_err(message)?;
        // A call that names no card has its card found by the arguments the model wrote, so they
        // are kept from before any `$file` swap.
        let sent = arguments["arguments"].clone();
        let request_id = format!("{}:{}", binding.turn.turn_id, context.id);
        let request = ToolRequest {
            request_id: request_id.clone(),
            target: target.clone(),
            arguments: self.with_file_addresses(&sent).await?,
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
                    let chat = lock(&self.0.chat).upgrade();
                    if let Some(chat) = chat {
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
        match name {
            "apps_list" => Ok(json!(lock(&self.0.registry).list())),
            "apps_update" => {
                let command: RegistryCommand =
                    serde_json::from_value(arguments["command"].clone()).map_err(message)?;
                let registry = self.0.registry.clone();
                tokio::task::spawn_blocking(move || lock(&registry).execute(command))
                    .await
                    .map_err(message)?
                    .map(|result| json!(result))
                    .map_err(message)
            }
            "apps_open" => {
                let id: AppId =
                    serde_json::from_value(arguments["appId"].clone()).map_err(message)?;
                if lock(&self.0.registry).get(&id).is_none() {
                    return Err(message("app is no longer registered"));
                }
                let chat = lock(&self.0.chat)
                    .upgrade()
                    .ok_or_else(|| message("host closed"))?;
                chat.open_app(&binding.turn, &id).map_err(message)?;
                Ok(json!({"appId":id,"opened":true}))
            }
            "tools_search" => {
                let ids: Vec<_> = lock(&self.0.registry)
                    .list()
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
                                errors.push(
                                    json!({"appId":id,"error":catalogue.last_error,"isStale":true}),
                                );
                            }
                            for tool in catalogue.tools {
                                if found.len() >= FOUND_TOOL_LIMIT {
                                    truncated = true;
                                    break;
                                }
                                if query.matches(&tool) {
                                    let mut row = json!({"appId":id,"tool":tool.name,"description":tool.description});
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
            "tools_describe" => {
                let target: ToolTarget = serde_json::from_value(arguments).map_err(message)?;
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
            "tools_call" => self.tools_call(arguments, token, binding, context).await,
            "files_export" => {
                let request: ExportRequest = serde_json::from_value(arguments).map_err(message)?;
                let files = self.0.files.clone();
                let saved = tokio::task::spawn_blocking(move || files.export(request))
                    .await
                    .map_err(message)?
                    .map_err(message)?;
                Ok(json!(saved))
            }
            "files_list" => {
                let files = self.0.files.clone();
                let listed = tokio::task::spawn_blocking(move || files.list())
                    .await
                    .map_err(message)?;
                Ok(json!({"files": listed}))
            }
            _ => Err(message("unknown facade tool")),
        }
    }
}
