//! Refresh metadata without the SDK's silent stale-cache fallback, renew credentials that a server
//! refused once, and report what each fresh listing found.
use super::{
    Endpoint, HttpMcpClient, McpError, Renewal, ServerMetadata, ToolCatalogue,
    http::{AppState, Connection, DEADLINE, MAX_BYTES, failure, protocol},
};
use crate::apps::AppId;
use rmcp::model::*;
use std::collections::HashSet;
impl HttpMcpClient {
    pub(super) async fn load(&self, id: &AppId, refresh: bool) -> Result<ToolCatalogue, McpError> {
        let renewed = self.endpoints.renew(id, Renewal::BeforeUse).await;
        let endpoint = self.endpoint(id)?;
        let state = self.state(id).await;
        let mut state = state.lock().await;
        // A sign-in found ended before use is what this listing found: the server's state says so,
        // and its tools are no longer offered.
        if let Err(error) = renewed {
            self.endpoints.observed(id, Err(&error));
            state.connection = None;
            state.catalogue = None;
            return Err(error);
        }
        let reconnect = needs_connection(&state, &endpoint);
        let changed = state.connection.as_ref().is_some_and(|connection| {
            connection.generation != connection.running.service().tool_list_generation()
        });
        if !refresh
            && !changed
            && !reconnect
            && let Some(catalogue) = &state.catalogue
        {
            return Ok(catalogue.clone());
        }
        let mut result = fetch(&mut state, endpoint.clone()).await;
        if matches!(result, Err(McpError::Unauthorized)) {
            // A server refuses an access token that ran out; a renewed one is tried once.
            result = match self.endpoints.renew(id, Renewal::Refused(&endpoint)).await {
                Ok(true) => match self.endpoint(id) {
                    Ok(renewed) => fetch(&mut state, renewed).await,
                    Err(error) => Err(error),
                },
                Ok(false) => result,
                Err(error) => Err(error),
            };
        }
        self.endpoints.observed(id, result.as_ref());
        match result {
            Ok(catalogue) => {
                state.catalogue = Some(catalogue.clone());
                Ok(catalogue)
            }
            // Tools of a server that refuses the credentials cannot be called, so they are not
            // offered as stale ones.
            Err(error @ (McpError::Unauthorized | McpError::SignInEnded { .. })) => {
                state.connection = None;
                state.catalogue = None;
                Err(error)
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

fn needs_connection(state: &AppState, endpoint: &Endpoint) -> bool {
    state
        .connection
        .as_ref()
        .is_none_or(|connection| connection.endpoint != *endpoint || connection.running.is_closed())
}

/// Connects when the kept connection is gone or was made with other headers, then lists the tools.
async fn fetch(state: &mut AppState, endpoint: Endpoint) -> Result<ToolCatalogue, McpError> {
    if needs_connection(state, &endpoint) {
        state.connection = None;
        state.connection = Some(HttpMcpClient::connect(endpoint).await?);
    }
    let connection = state
        .connection
        .as_mut()
        .ok_or_else(|| failure("connection missing"))?;
    let generation = connection.running.service().tool_list_generation();
    let catalogue = tokio::time::timeout(DEADLINE, read(connection))
        .await
        .map_err(failure)??;
    connection.generation = generation;
    Ok(catalogue)
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
            tools.push(
                serde_json::to_value(tool)
                    .and_then(serde_json::from_value)
                    .map_err(failure)?,
            );
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
