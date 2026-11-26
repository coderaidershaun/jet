//! The outside-text rule: once a turn has read web text, a colleague's words or a result of an MCP
//! server the user added, the calls that could change something or send data out are refused.

use super::{
    Binding,
    handler::{Handler, message},
};
use agent::{apps::AppId, mcp::ToolTarget};
use rmcp::{RoleServer, service::RequestContext};
use serde_json::Value;

/// Whose tool a call reaches: a registered app, or an MCP server the user added, whose results
/// can hold anyone's words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ToolServer {
    App,
    Added,
}

/// Why a call that could change something, or send the user's data out, was refused after the
/// turn read web text. A web page can hold instructions from a stranger, so only the user's next
/// message can allow such a call.
#[derive(Debug, thiserror::Error)]
pub(super) enum WriteRefused {
    #[error(
        "this reply has read web text, a colleague's words or a result from an MCP server, so Jet refuses changes to apps, people, shares and the sources of an objective, removing a file, sending to colleagues, and tools that are not read-only, until the user's next message. Tell the user exactly what you wanted to do, so their next message can allow it"
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
    pub(super) fn kind(&self) -> &'static str {
        match self {
            WriteRefused::WriteAfterWebText => "writeAfterWebText",
            WriteRefused::NoToolUseId => "noToolUseId",
            WriteRefused::TurnEnded => "turnEnded",
        }
    }
}

impl Handler {
    /// Refuses `apps_update`, `people_update`, `tasks_update` with `send`, `objectives_update` with
    /// `propose_share` or with sources to add or change, and a
    /// `tools_call` whose tool is not marked read-only, once the turn has read web text,
    /// `github_activity`, a colleague's shared objectives (`objectives_list` with `owner`), a result
    /// of an MCP server the user added, or a colleague's message, which the turn's prompt or its
    /// binding says. It first waits until the turn's stream has passed
    /// this call's own tool-use line, so every web read before the call has been seen. When the
    /// order cannot be known, the call is refused too. A Codex or agy turn has no web tools, so
    /// there only such a read that reached Jet earlier counts.
    pub(super) async fn refuse_after_web_text(
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
        if (read_web == Some(false) && !binding.has_read_strangers)
            || (name == "tools_call" && self.read_only(arguments, binding).await)
        {
            return None;
        }
        Some(match (card, read_web) {
            _ if binding.has_read_strangers => WriteRefused::WriteAfterWebText,
            (None, _) => WriteRefused::NoToolUseId,
            (_, None) => WriteRefused::TurnEnded,
            _ => WriteRefused::WriteAfterWebText,
        })
    }

    /// Whether the app or MCP server marks the tool `readOnlyHint`. A tool that cannot be found,
    /// or of a server that is not the turn's user's, is not. The hint is the server's own promise
    /// about its own tool: it is trusted, because the rule guards against text from strangers
    /// steering a server's tools, and a server that lied about them could harm the user anyway.
    pub(super) async fn read_only(&self, arguments: &Value, binding: &Binding) -> bool {
        let Ok(target) = serde_json::from_value::<ToolTarget>(arguments.clone()) else {
            return false;
        };
        if self.tool_server(&target.app_id, binding).is_err() {
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

    /// Which kind of tool server the id names, when it is the turn's user's. Another user's app or
    /// server is refused in the same words as a missing one.
    pub(super) fn tool_server(&self, id: &AppId, binding: &Binding) -> Result<ToolServer, Value> {
        let user = binding.owner.user;
        if self.0.apps.owned(user, id).is_some() {
            Ok(ToolServer::App)
        } else if self.0.apps.servers().owned(user, id).map_err(message)? {
            Ok(ToolServer::Added)
        } else {
            Err(message("app is no longer registered"))
        }
    }
}
