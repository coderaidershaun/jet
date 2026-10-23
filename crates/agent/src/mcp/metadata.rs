//! Refresh metadata without the SDK's silent stale-cache fallback.
use super::{
    HttpMcpClient, McpError, ServerMetadata, ToolCatalogue, ToolDefinition,
    http::{Connection, DEADLINE, MAX_BYTES, failure, protocol},
};
use crate::apps::AppId;
use rmcp::model::*;
use std::{collections::HashSet, sync::atomic::Ordering};
impl HttpMcpClient {
    pub(super) async fn load(&self, id: &AppId, refresh: bool) -> Result<ToolCatalogue, McpError> {
        let endpoint = self.endpoint(id)?;
        let state = self.state(id).await;
        let mut state = state.lock().await;
        let reconnect = state.connection.as_ref().is_none_or(|connection| {
            connection.endpoint != endpoint || connection.running.is_closed()
        });
        let changed = state.connection.as_ref().is_some_and(|connection| {
            connection.generation != connection.running.service().0.load(Ordering::SeqCst)
        });
        if !refresh
            && !changed
            && !reconnect
            && let Some(catalogue) = &state.catalogue
        {
            return Ok(catalogue.clone());
        }
        let result = async {
            if reconnect {
                state.connection = Some(Self::connect(endpoint).await?);
            }
            let connection = state
                .connection
                .as_mut()
                .ok_or_else(|| failure("connection missing"))?;
            let generation = connection.running.service().0.load(Ordering::SeqCst);
            let catalogue = tokio::time::timeout(DEADLINE, read(connection))
                .await
                .map_err(failure)??;
            connection.generation = generation;
            Ok::<_, McpError>(catalogue)
        }
        .await;
        match result {
            Ok(catalogue) => {
                state.catalogue = Some(catalogue.clone());
                Ok(catalogue)
            }
            Err(error) => {
                state.connection = None;
                if let Some(catalogue) = state.catalogue.as_mut() {
                    catalogue.is_stale = true;
                    catalogue.last_error = Some(error.to_string());
                    Ok(catalogue.clone())
                } else {
                    Err(error)
                }
            }
        }
    }
}
async fn read(connection: &Connection) -> Result<ToolCatalogue, McpError> {
    let info = connection
        .running
        .peer_info()
        .ok_or_else(|| failure("server did not initialize"))?;
    let implementation = info
        .server_info
        .as_ref()
        .ok_or_else(|| failure("server omitted identity"))?;
    let server = ServerMetadata {
        name: implementation.name.clone(),
        version: implementation.version.clone(),
        protocol_version: info.protocol_version.to_string(),
        capabilities: serde_json::to_value(&info.capabilities).map_err(failure)?,
        instructions: info.instructions.clone(),
    };
    let mut tools = Vec::new();
    let mut cursor = None;
    let mut cursors = HashSet::new();
    let mut bytes = 0;
    for _ in 0..64 {
        let request = ClientRequest::ListToolsRequest(ListToolsRequest {
            method: Default::default(),
            params: cursor
                .map(|cursor| PaginatedRequestParams::default().with_cursor(Some(cursor))),
            extensions: Default::default(),
        });
        let response = tokio::time::timeout(DEADLINE, connection.running.send_request(request))
            .await
            .map_err(failure)?
            .map_err(protocol)?;
        let ServerResult::ListToolsResult(page) = response else {
            return Err(failure("unexpected tool list response"));
        };
        bytes += serde_json::to_vec(&page).map_err(failure)?.len();
        if bytes > MAX_BYTES || tools.len() + page.tools.len() > 4096 {
            return Err(failure("tool catalogue exceeds limits"));
        }
        for tool in page.tools {
            let raw = serde_json::to_value(tool).map_err(failure)?;
            tools.push(ToolDefinition {
                name: raw["name"].as_str().unwrap_or_default().into(),
                description: raw["description"].as_str().map(str::to_owned),
                input_schema: raw["inputSchema"].clone(),
                output_schema: raw.get("outputSchema").cloned(),
                annotations: raw.get("annotations").cloned(),
                meta: raw["_meta"].as_object().cloned().unwrap_or_default(),
            });
        }
        cursor = page.next_cursor;
        if let Some(next) = &cursor {
            if !cursors.insert(next.clone()) {
                return Err(failure("server repeated a tool catalogue cursor"));
            }
        } else {
            return Ok(ToolCatalogue {
                server,
                tools,
                is_stale: false,
                last_error: None,
            });
        }
    }
    Err(failure("tool catalogue exceeds page limit"))
}
