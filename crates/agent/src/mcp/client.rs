//! Speaks MCP over streamable HTTP to one library's shared server: opens a session, calls
//! tools, and reads the answer whether it comes as plain JSON or as an event stream.

use std::io::{BufRead, BufReader, Read};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde_json::{Value, json};

use super::McpError;
use crate::chat::{content_text, content_value};

/// How long one request may take. Stopping a polysim engine can take 20 seconds.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

const PROTOCOL_VERSION: &str = "2025-06-18";

/// One library's shared server, reached by URL.
pub(super) struct McpClient {
    /// The library's name, for messages.
    server: String,
    url: String,
    http: ureq::Agent,
    /// `None` until a session is open.
    session: Mutex<Option<Session>>,
    next_id: AtomicU64,
}

struct Session {
    /// A server may keep no id.
    id: Option<String>,
}

/// What the server sent back for one posted message.
struct Sent {
    /// The `Mcp-Session-Id` header, if the reply had one.
    session_id: Option<String>,
    reply: Reply,
}

enum Reply {
    /// The server does not know the session the message carried.
    SessionLost,
    /// The server took a notification and said nothing more.
    Nothing,
    /// The JSON-RPC message that answers the request.
    Message(Value),
}

impl McpClient {
    pub(super) fn new(server: &str, url: String) -> McpClient {
        // Loopback must never go through a proxy from the environment, and no idle
        // connection is kept, because after a restart it would point at the dead process.
        let http = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(CALL_TIMEOUT))
            .proxy(None)
            .max_idle_connections(0)
            .max_idle_connections_per_host(0)
            .build()
            .into();
        McpClient {
            server: server.to_owned(),
            url,
            http,
            session: Mutex::new(None),
            next_id: AtomicU64::new(1),
        }
    }

    /// Drops the open session. A server that was started again knows none of the old ones.
    pub(super) fn forget_session(&self) {
        *self.open_session() = None;
    }

    /// Calls one tool and returns its structured result, else its text as JSON, else the text.
    /// A session the server has lost is opened again once.
    pub(super) fn call(&self, tool: &str, arguments: Value) -> Result<Value, McpError> {
        let params = json!({"name": tool, "arguments": arguments});
        let mut reopened = false;
        loop {
            let session = self.ensure_session()?;
            let sent = self.request(session.as_deref(), "tools/call", params.clone())?;
            match sent.reply {
                Reply::Message(message) => return self.tool_result(message),
                Reply::SessionLost if session.is_some() && !reopened => {
                    self.forget_session_if(session.as_deref());
                    reopened = true;
                }
                Reply::SessionLost => return Err(self.status(404)),
                Reply::Nothing => return Err(self.no_response()),
            }
        }
    }

    fn open_session(&self) -> MutexGuard<'_, Option<Session>> {
        self.session.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn forget_session_if(&self, id: Option<&str>) {
        let mut slot = self.open_session();
        if slot.as_ref().is_some_and(|open| open.id.as_deref() == id) {
            *slot = None;
        }
    }

    /// The id of the open session, opening one first when there is none. The lock is held
    /// for the whole handshake, so two callers never open two sessions.
    fn ensure_session(&self) -> Result<Option<String>, McpError> {
        let mut slot = self.open_session();
        if let Some(open) = slot.as_ref() {
            return Ok(open.id.clone());
        }
        let opened = self.handshake()?;
        let id = opened.id.clone();
        *slot = Some(opened);
        Ok(id)
    }

    fn handshake(&self) -> Result<Session, McpError> {
        let params = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "jet", "version": env!("CARGO_PKG_VERSION")},
        });
        let sent = self.request(None, "initialize", params)?;
        match sent.reply {
            Reply::Message(message) => {
                self.result_of(message)?;
            }
            Reply::SessionLost => return Err(self.status(404)),
            Reply::Nothing => return Err(self.no_response()),
        }
        let notice = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
        match self.post(sent.session_id.as_deref(), &notice, None)?.reply {
            Reply::SessionLost => return Err(self.status(404)),
            Reply::Nothing | Reply::Message(_) => {}
        }
        Ok(Session {
            id: sent.session_id,
        })
    }

    fn request(
        &self,
        session: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Sent, McpError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let message = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        self.post(session, &message, Some(id))
    }

    /// Posts one message. `id` is the request id to wait for, or `None` for a notification.
    fn post(
        &self,
        session: Option<&str>,
        message: &Value,
        id: Option<u64>,
    ) -> Result<Sent, McpError> {
        let mut request = self
            .http
            .post(&self.url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", PROTOCOL_VERSION);
        if let Some(session) = session {
            request = request.header("Mcp-Session-Id", session);
        }
        let mut response = request
            .send(message.to_string())
            .map_err(|source| self.unreachable(source))?;
        let status = response.status().as_u16();
        let session_id = response
            .headers()
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let reply = match (status, id) {
            (404, _) => Reply::SessionLost,
            (200 | 202, None) => Reply::Nothing,
            (200, Some(id)) => {
                let body = response.body_mut();
                let message = if body.mime_type() == Some("text/event-stream") {
                    self.response_in_stream(body.as_reader(), id)?
                } else {
                    let text = body
                        .read_to_string()
                        .map_err(|source| self.unreachable(source))?;
                    serde_json::from_str(&text).map_err(|source| self.bad_json(source))?
                };
                Reply::Message(message)
            }
            (202, Some(_)) => return Err(self.no_response()),
            _ => return Err(self.status(status)),
        };
        Ok(Sent { session_id, reply })
    }

    /// Reads events until the one that answers request `id`, and stops there: the server
    /// may keep the stream open afterwards.
    fn response_in_stream(&self, stream: impl Read, id: u64) -> Result<Value, McpError> {
        let mut data = String::new();
        for line in BufReader::new(stream).lines() {
            let line = line.map_err(|source| self.unreachable(ureq::Error::Io(source)))?;
            if let Some(text) = line.strip_prefix("data:") {
                data.push_str(text.strip_prefix(' ').unwrap_or(text));
                data.push('\n');
            } else if line.is_empty() {
                if let Some(message) = self.answer_in(&data, id)? {
                    return Ok(message);
                }
                data.clear();
            }
        }
        self.answer_in(&data, id)?.ok_or_else(|| self.no_response())
    }

    /// The event's message when it is the response to request `id`. A notification or a
    /// request from the server, even one that reuses the id, is not.
    fn answer_in(&self, data: &str, id: u64) -> Result<Option<Value>, McpError> {
        if data.trim().is_empty() {
            return Ok(None);
        }
        let message: Value = serde_json::from_str(data).map_err(|source| self.bad_json(source))?;
        let answers = message["id"].as_u64() == Some(id)
            && (message.get("result").is_some() || message.get("error").is_some());
        Ok(answers.then_some(message))
    }

    /// The `result` of a response, or the server's refusal.
    fn result_of(&self, mut message: Value) -> Result<Value, McpError> {
        if let Some(error) = message.get("error") {
            return Err(McpError::Rpc {
                server: self.server.clone(),
                code: error["code"].as_i64().unwrap_or_default(),
                message: error["message"].as_str().unwrap_or_default().to_owned(),
            });
        }
        Ok(message["result"].take())
    }

    fn tool_result(&self, message: Value) -> Result<Value, McpError> {
        let result = self.result_of(message)?;
        if result["isError"].as_bool() == Some(true) {
            let text = content_text(&result["content"]);
            let text = if text.is_empty() {
                "the tool failed without saying why".to_owned()
            } else {
                text
            };
            return Err(McpError::Tool(text));
        }
        let structured = &result["structuredContent"];
        Ok(if structured.is_null() {
            content_value(&result["content"])
        } else {
            structured.clone()
        })
    }

    fn unreachable(&self, source: ureq::Error) -> McpError {
        McpError::Unreachable {
            server: self.server.clone(),
            source: Box::new(source),
        }
    }

    fn bad_json(&self, source: serde_json::Error) -> McpError {
        McpError::BadJson {
            server: self.server.clone(),
            source,
        }
    }

    fn status(&self, status: u16) -> McpError {
        McpError::Status {
            server: self.server.clone(),
            status,
        }
    }

    fn no_response(&self) -> McpError {
        McpError::NoResponse {
            server: self.server.clone(),
        }
    }
}
