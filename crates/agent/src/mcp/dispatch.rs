//! Validate current schemas without replaying calls whose outcomes are uncertain.
use super::{
    DiscoveryMarker, HttpMcpClient, McpError, McpFuture, McpService, ToolRequest, ToolResult,
    http::{DEADLINE, MAX_BYTES, failure, protocol},
};
use rmcp::{model::*, service::PeerRequestOptions};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};
use tokio::sync::oneshot;
type PendingCalls = Arc<Mutex<HashMap<String, Option<oneshot::Sender<()>>>>>;
pub(super) enum Purpose {
    Call,
    Discovery,
}
impl HttpMcpClient {
    pub(super) fn prepare(
        &self,
        request: ToolRequest,
        purpose: Purpose,
    ) -> McpFuture<'_, ToolResult> {
        let (sender, receiver) = oneshot::channel();
        let mut calls = self.calls.lock().unwrap_or_else(PoisonError::into_inner);
        if request.request_id.is_empty()
            || request.request_id.len() > 256
            || calls.contains_key(&request.request_id)
        {
            return Box::pin(async {
                Err(McpError::InvalidArguments {
                    message: "request ID must be unique and contain 1 to 256 bytes".into(),
                })
            });
        }
        calls.insert(request.request_id.clone(), Some(sender));
        let guard = PendingCall {
            request_id: request.request_id.clone(),
            calls: self.calls.clone(),
            wire: None,
            purpose,
        };
        Box::pin(self.dispatch(request, receiver, guard))
    }
    async fn dispatch(
        &self,
        request: ToolRequest,
        mut cancelled: oneshot::Receiver<()>,
        mut guard: PendingCall,
    ) -> Result<ToolResult, McpError> {
        let catalogue = tokio::select! {
            result = self.catalogue(&request.target.app_id) => result?,
            _ = &mut cancelled => return Err(McpError::Cancelled { request_id:request.request_id }),
        };
        if catalogue.is_stale {
            return Err(failure(
                catalogue
                    .last_error
                    .unwrap_or_else(|| "tool catalogue is stale".into()),
            ));
        }
        let state = self.state(&request.target.app_id).await;
        let state = state.lock().await;
        let connection = state
            .connection
            .as_ref()
            .ok_or_else(|| failure("connection closed before dispatch"))?;
        let catalogue = state
            .catalogue
            .as_ref()
            .ok_or_else(|| failure("catalogue missing before dispatch"))?;
        if connection.generation
            != connection
                .running
                .service()
                .0
                .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(failure("catalogue changed; rediscover before retrying"));
        }
        let tool = catalogue
            .tools
            .iter()
            .find(|tool| tool.name == request.target.tool)
            .ok_or_else(|| McpError::UnknownTool {
                app_id: request.target.app_id.clone(),
                tool: request.target.tool.clone(),
            })?;
        if matches!(guard.purpose, Purpose::Discovery)
            && !tool
                .meta
                .get("jet/discovery")
                .and_then(|marker| serde_json::from_value::<DiscoveryMarker>(marker.clone()).ok())
                .is_some_and(|marker| marker.version == 1)
        {
            return Err(McpError::InvalidArguments {
                message: "tool does not declare supported free discovery".into(),
            });
        }
        let validator = jsonschema::validator_for(&tool.input_schema).map_err(|error| {
            McpError::InvalidArguments {
                message: format!("unsupported tool schema: {error}"),
            }
        })?;
        if let Err(error) = validator.validate(&Value::Object(request.arguments.clone())) {
            return Err(McpError::InvalidArguments {
                message: error.to_string(),
            });
        }
        // Registry edits after this snapshot do not cancel an already dispatched call.
        if self.endpoint(&request.target.app_id)? != connection.endpoint {
            return Err(failure("app endpoint changed; rediscover before retrying"));
        }
        if cancelled.try_recv().is_ok() {
            return Err(McpError::Cancelled {
                request_id: request.request_id,
            });
        }
        let running = connection.running.clone();
        let peer = running.peer().clone();
        drop(state);
        let call = ClientRequest::CallToolRequest(CallToolRequest::new(
            CallToolRequestParams::new(request.target.tool).with_arguments(request.arguments),
        ));
        let handle = tokio::time::timeout(
            DEADLINE,
            peer.send_cancellable_request(
                call,
                PeerRequestOptions::with_timeout(Duration::from_secs(120)),
            ),
        )
        .await
        .map_err(failure)?
        .map_err(protocol)?;
        guard.wire = Some((peer.clone(), handle.id.clone()));
        let response = tokio::select! {
            response = handle.await_response() => { guard.wire = None; response.map_err(protocol) },
            _ = cancelled => Err(McpError::Cancelled { request_id:request.request_id.clone() }),
        };
        if matches!(response, Err(McpError::Transport { .. })) {
            let state = self.state(&request.target.app_id).await;
            let mut state = state.lock().await;
            if state
                .connection
                .as_ref()
                .is_some_and(|connection| Arc::ptr_eq(&connection.running, &running))
            {
                state.connection = None;
            }
        }
        let ServerResult::CallToolResult(result) = response? else {
            return Err(failure("unexpected tool call response"));
        };
        if serde_json::to_vec(&result).map_err(failure)?.len() > MAX_BYTES {
            return Err(failure("tool result exceeds size limit"));
        }
        Ok(ToolResult {
            request_id: request.request_id,
            content: result
                .content
                .into_iter()
                .map(serde_json::to_value)
                .collect::<Result<_, _>>()
                .map_err(failure)?,
            structured_content: result.structured_content,
            is_error: result.is_error.unwrap_or(false),
        })
    }
}
struct PendingCall {
    purpose: Purpose,
    request_id: String,
    calls: PendingCalls,
    wire: Option<(rmcp::Peer<rmcp::RoleClient>, RequestId)>,
}
impl Drop for PendingCall {
    fn drop(&mut self) {
        self.calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.request_id);
        if let Some((peer, wire_id)) = self.wire.take() {
            tokio::spawn(async move {
                let notification = CancelledNotification::new(CancelledNotificationParam::new(
                    Some(wire_id),
                    Some("Jet stopped waiting for the request".into()),
                ));
                let _ = tokio::time::timeout(DEADLINE, peer.send_notification(notification.into()))
                    .await;
            });
        }
    }
}
