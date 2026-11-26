//! How the one tool client reaches each server a user added, with its key or sign-in, and what a
//! connection to it found, kept as the server's state.

use super::{owner, sign_in::Credentials};
use crate::{
    seal::Sealer,
    store::{McpServer, McpState, McpTool, Store},
};
use agent::{
    apps::{AppId, Registry},
    mcp::{Endpoint, Endpoints, McpError, RenewFuture, Renewal, ToolCatalogue},
};
use std::sync::{Arc, Mutex};

/// The longest reason a failed connection keeps, in characters.
const REASON_LIMIT: usize = 300;

/// How Jet proves who it is to a server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Credential {
    None,
    Key,
    SignIn,
}

impl Credential {
    pub(super) fn of(server: &McpServer) -> Self {
        match (server.key_header.is_some(), server.signed_in) {
            (true, _) => Self::Key,
            (false, true) => Self::SignIn,
            (false, false) => Self::None,
        }
    }
}

/// The state, why it is not connected and the tools, from what a fresh connection found.
pub(super) fn outcome(
    found: Result<&ToolCatalogue, &McpError>,
    credential: Credential,
) -> (McpState, Option<String>, Option<Vec<McpTool>>) {
    let failed = |reason: String| {
        let reason: String = reason.chars().take(REASON_LIMIT).collect();
        (McpState::Failed, Some(reason), None)
    };
    match found {
        Ok(catalogue) if !catalogue.is_stale => {
            let tools = catalogue
                .tools
                .iter()
                .map(|tool| McpTool {
                    name: tool.name.clone(),
                    read_only: tool
                        .annotations
                        .as_ref()
                        .is_some_and(|annotations| annotations["readOnlyHint"] == true),
                })
                .collect();
            (McpState::Connected, None, Some(tools))
        }
        Ok(catalogue) => failed(catalogue.last_error.clone().unwrap_or_default()),
        Err(McpError::Unauthorized) => match credential {
            Credential::Key => {
                failed("the server refused the key; check it, then save it again".into())
            }
            Credential::SignIn => (
                McpState::NeedsKey,
                Some("the server refused Jet's sign-in; sign in again".into()),
                None,
            ),
            Credential::None => (McpState::NeedsKey, None, None),
        },
        Err(McpError::SignInEnded { message }) => (McpState::NeedsKey, Some(message.clone()), None),
        Err(McpError::Transport { message }) => failed(format!("could not connect: {message}")),
        Err(error) => failed(error.to_string()),
    }
}

/// Finds each tool server for the one tool client: a registered app first, else a server a user
/// added, with its key or sign-in opened for the request.
pub(super) struct ToolEndpoints {
    pub(super) registry: Arc<Mutex<Registry>>,
    pub(super) store: Store,
    pub(super) sealer: Sealer,
    pub(super) credentials: Credentials,
}

impl ToolEndpoints {
    fn is_app(&self, id: &AppId) -> bool {
        !matches!(
            self.registry.endpoint(id),
            Err(McpError::Unavailable { .. })
        )
    }
}

impl Endpoints for ToolEndpoints {
    fn endpoint(&self, id: &AppId) -> Result<Endpoint, McpError> {
        match self.registry.endpoint(id) {
            Err(McpError::Unavailable { .. }) => {}
            app => return app,
        }
        let unavailable = || McpError::Unavailable { app_id: id.clone() };
        let stored = self
            .store
            .mcp_endpoint(id)
            .map_err(|error| McpError::Transport {
                message: format!("could not read the server: {error}"),
            })?
            .filter(|stored| stored.enabled)
            .ok_or_else(unavailable)?;
        let headers = match (stored.key, stored.sealed_access) {
            (None, None) => Vec::new(),
            (None, Some(access)) => vec![self.credentials.bearer(stored.user, id, &access)?],
            (Some(key), _) => {
                let value = self
                    .sealer
                    .unseal(&owner(stored.user, id), &key.sealed)
                    .and_then(|value| String::from_utf8(value).ok())
                    .ok_or_else(|| McpError::Transport {
                        message: "the saved key can no longer be read, because the server's token key changed; save the key again".into(),
                    })?;
                vec![(key.header, value)]
            }
        };
        Ok(Endpoint {
            url: stored.url,
            headers,
        })
    }

    fn renew<'a>(&'a self, id: &'a AppId, renewal: Renewal<'a>) -> RenewFuture<'a> {
        Box::pin(async move {
            if self.is_app(id) {
                return Ok(false);
            }
            self.credentials.renew(id, renewal).await
        })
    }

    /// Keeps what a listing found as the server's state. The call that listed already has its
    /// answer, so a state that cannot be saved is only logged; the next use saves it again.
    fn observed(&self, id: &AppId, found: Result<&ToolCatalogue, &McpError>) {
        if self.is_app(id) {
            return;
        }
        let recorded = self.store.mcp_endpoint(id).and_then(|stored| {
            let Some(stored) = stored else {
                return Ok(false);
            };
            let credential = match (&stored.key, &stored.sealed_access) {
                (Some(_), _) => Credential::Key,
                (None, Some(_)) => Credential::SignIn,
                (None, None) => Credential::None,
            };
            let (state, reason, tools) = outcome(found, credential);
            self.store
                .set_mcp_state(stored.user, id, state, reason.as_deref(), tools.as_deref())
        });
        if let Err(error) = recorded {
            eprintln!("jet: could not record the state of MCP server {id}: {error}");
        }
    }
}
