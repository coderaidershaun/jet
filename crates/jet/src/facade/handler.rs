//! Route provider requests through the host registry and shared HTTP client.
use super::{Binding, Facade, HEADER, tools};
use crate::chat::lock;
use agent::{
    apps::{AppId, RegistryCommand},
    mcp::{ToolRequest, ToolTarget},
};
use rmcp::{RoleServer, ServerHandler, model::*, service::RequestContext};
use serde_json::{Value, json};
use std::sync::Arc;
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
            tools: tools::definitions(),
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
impl Handler {
    async fn execute(
        &self,
        name: &str,
        arguments: Value,
        token: &str,
        binding: Binding,
        context: RequestContext<RoleServer>,
    ) -> Result<Value, Value> {
        let error = |error: &dyn std::fmt::Display| json!({"message":error.to_string()});
        match name {
            "apps_list" => Ok(json!(lock(&self.0.registry).list())),
            "apps_update" => {
                let command: RegistryCommand =
                    serde_json::from_value(arguments["command"].clone()).map_err(|e| error(&e))?;
                let registry = self.0.registry.clone();
                tokio::task::spawn_blocking(move || lock(&registry).execute(command))
                    .await
                    .map_err(|e| error(&e))?
                    .map(|result| json!(result))
                    .map_err(|e| error(&e))
            }
            "apps_open" => {
                let id: AppId =
                    serde_json::from_value(arguments["appId"].clone()).map_err(|e| error(&e))?;
                if lock(&self.0.registry).get(&id).is_none() {
                    return Err(json!({"message":"app is no longer registered"}));
                }
                let chat = lock(&self.0.chat)
                    .upgrade()
                    .ok_or_else(|| error(&"host closed"))?;
                chat.open_app(&binding, &id).map_err(|e| error(&e))?;
                Ok(json!({"appId":id,"opened":true}))
            }
            "tools_search" => {
                let ids: Vec<_> = lock(&self.0.registry)
                    .list()
                    .iter()
                    .filter(|app| app.enabled && app.mcp_url.is_some())
                    .map(|app| app.id.clone())
                    .collect();
                let query = arguments["query"]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase();
                let mut found = Vec::new();
                let mut errors = Vec::new();
                let mut truncated = ids.len() > 128;
                let mut pending = tokio::task::JoinSet::new();
                for id in ids.into_iter().take(128) {
                    let client = self.0.mcp.clone();
                    pending.spawn(async move {
                        let result = client.catalogue(&id).await;
                        (id, result)
                    });
                }
                while let Some(result) = pending.join_next().await {
                    let (id, result) = result.map_err(|e| error(&e))?;
                    match result {
                        Ok(catalogue) => {
                            if catalogue.is_stale {
                                errors.push(
                                    json!({"appId":id,"error":catalogue.last_error,"isStale":true}),
                                );
                            }
                            for tool in catalogue.tools {
                                if found.len() >= 200 {
                                    truncated = true;
                                    break;
                                }
                                if found.len() < 200
                                    && format!(
                                        "{} {}",
                                        tool.name,
                                        tool.description.as_deref().unwrap_or_default()
                                    )
                                    .to_lowercase()
                                    .contains(&query)
                                {
                                    found.push(json!({"appId":id,"tool":tool.name,"description":tool.description}));
                                }
                            }
                        }
                        Err(e) => errors.push(json!({"appId":id,"error":e})),
                    }
                }
                found.sort_by_key(|tool| format!("{}:{}", tool["appId"], tool["tool"]));
                Ok(json!({"tools":found,"errors":errors,"truncated":truncated}))
            }
            "tools_describe" => {
                let target: ToolTarget =
                    serde_json::from_value(arguments).map_err(|e| error(&e))?;
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
                    .ok_or_else(|| error(&"tool is not listed"))?;
                Ok(
                    json!({"appId":target.app_id,"tool":tool,"server":catalogue.server,"isStale":catalogue.is_stale,"lastError":catalogue.last_error}),
                )
            }
            "tools_call" => {
                let target: ToolTarget =
                    serde_json::from_value(arguments.clone()).map_err(|e| error(&e))?;
                let request_id = format!("{}:{}", binding.turn_id, context.id);
                let request = ToolRequest {
                    request_id: request_id.clone(),
                    target,
                    arguments: arguments["arguments"]
                        .as_object()
                        .cloned()
                        .unwrap_or_default(),
                };
                let call = {
                    let mut bindings = lock(&self.0.bindings);
                    bindings
                        .get_mut(token)
                        .ok_or_else(|| error(&"initiating turn expired"))?
                        .calls
                        .insert(request_id.clone());
                    self.0.mcp.call(request)
                };
                let result = tokio::select! {
                    result = call => result,
                    _ = context.ct.cancelled() => { self.0.mcp.cancel_request(&request_id); return Err(json!({"kind":"cancelled","requestId":request_id})); }
                };
                if let Some(binding) = lock(&self.0.bindings).get_mut(token) {
                    binding.calls.remove(&request_id);
                }
                let result = result.map_err(|e| json!(e))?;
                Ok(json!(result))
            }
            _ => Err(error(&"unknown facade tool")),
        }
    }
}
