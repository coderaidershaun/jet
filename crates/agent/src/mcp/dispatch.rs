//! Validate current schemas without replaying calls whose outcomes are uncertain.
use super::{
    HttpMcpClient, McpError, Progress, ToolDefinition, ToolRequest, ToolResult,
    http::{DEADLINE, MAX_BYTES, Notifications, ProgressListeners, failure, protocol},
};
use rmcp::{
    Peer, RoleClient,
    model::*,
    service::{PeerRequestOptions, RequestHandle},
};
use serde_json::Value;
use std::{
    collections::HashMap,
    pin::Pin,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};
type PendingCalls = Arc<Mutex<HashMap<String, Option<oneshot::Sender<()>>>>>;
pub(super) enum Purpose {
    Call,
    Discovery,
    Status,
}
impl Purpose {
    /// Refuses a tool that does not promise what this purpose needs, before anything is sent.
    fn allows(&self, tool: &ToolDefinition) -> Result<(), McpError> {
        let refusal = match self {
            Purpose::Call => return Ok(()),
            Purpose::Discovery => (!carries(tool, "jet/discovery"))
                .then_some("tool does not declare supported free discovery"),
            Purpose::Status => {
                let read_only = tool
                    .annotations
                    .as_ref()
                    .is_some_and(|annotations| annotations["readOnlyHint"] == true);
                (!(carries(tool, "jet/job") && read_only))
                    .then_some("tool does not declare a supported read-only job status")
            }
        };
        refusal.map_or(Ok(()), |message| {
            Err(McpError::InvalidArguments {
                message: message.into(),
            })
        })
    }
}
/// Whether the tool carries the Jet marker `key` in the one version Jet supports.
fn carries(tool: &ToolDefinition, key: &str) -> bool {
    tool.meta
        .get(key)
        .is_some_and(|marker| marker["version"] == 1)
}
impl HttpMcpClient {
    /// Registers the request ID now, not on the first poll, so a cancel sent before the first
    /// poll still finds it. The callers must stay plain functions, not `async fn`.
    pub(super) fn prepare(
        &self,
        request: ToolRequest,
        purpose: Purpose,
        progress: Option<mpsc::Sender<Progress>>,
    ) -> Pin<Box<dyn Future<Output = Result<ToolResult, McpError>> + Send + '_>> {
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
        Box::pin(self.dispatch(request, receiver, guard, progress))
    }
    async fn dispatch(
        &self,
        request: ToolRequest,
        mut cancelled: oneshot::Receiver<()>,
        mut guard: PendingCall,
        progress: Option<mpsc::Sender<Progress>>,
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
        if connection.generation != connection.running.service().tool_list_generation() {
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
        guard.purpose.allows(tool)?;
        let validator = jsonschema::validator_for(&tool.input_schema).map_err(|error| {
            McpError::InvalidArguments {
                message: format!("unsupported tool schema: {error}"),
            }
        })?;
        validator
            .validate(&Value::Object(request.arguments.clone()))
            .map_err(|error| McpError::InvalidArguments {
                message: error.to_string(),
            })?;
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
        let (handle, _listening) =
            send_and_listen(&peer, running.service(), call, progress).await?;
        guard.wire = Some((peer, handle.id.clone()));
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
/// Sends the call and starts listening for its progress. The client library picks the progress
/// token as it sends, so the token is known only afterwards. Progress updates wait on the
/// registering lock until the listener is in place, so none is lost.
async fn send_and_listen(
    peer: &Peer<RoleClient>,
    notifications: &Notifications,
    call: ClientRequest,
    progress: Option<mpsc::Sender<Progress>>,
) -> Result<(RequestHandle<RoleClient>, Option<Listening>), McpError> {
    let (registering, handle) = tokio::time::timeout(DEADLINE, async {
        let registering = notifications.registering.write().await;
        let handle = peer
            .send_cancellable_request(
                call,
                PeerRequestOptions::with_timeout(Duration::from_secs(120)),
            )
            .await?;
        Ok::<_, rmcp::ServiceError>((registering, handle))
    })
    .await
    .map_err(failure)?
    .map_err(protocol)?;
    let listening = progress.map(|sender| {
        Listening::start(
            &notifications.listeners,
            handle.progress_token.clone(),
            sender,
        )
    });
    drop(registering);
    Ok((handle, listening))
}
/// Sends the progress of one request to a channel, until it is dropped.
struct Listening {
    listeners: ProgressListeners,
    token: ProgressToken,
}
impl Listening {
    fn start(
        listeners: &ProgressListeners,
        token: ProgressToken,
        sender: mpsc::Sender<Progress>,
    ) -> Self {
        listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(token.clone(), sender);
        Self {
            listeners: listeners.clone(),
            token,
        }
    }
}
impl Drop for Listening {
    fn drop(&mut self) {
        self.listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.token);
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
