//! The command line of an agy turn. agy approves every tool request on it, so each other part is
//! there to keep the turn to Jet's own tools.

use serde_json::json;

use super::super::{Request, SessionMode, TransportError};
use super::folder::Agent;
use crate::chat::Effort;

/// # Errors
/// `AgyModel` when agy cannot run the model at the thinking level.
pub(super) fn args(request: &Request, agent: &Agent) -> Result<Vec<String>, TransportError> {
    let effort = match request.effort {
        Effort::Low | Effort::Medium | Effort::High | Effort::XHigh if request.model.is_agy() => {
            request.effort.alias()
        }
        _ => {
            return Err(TransportError::AgyModel {
                model: request.model,
                effort: request.effort,
            });
        }
    };
    // A second layer behind the agent file: agy's own shell and file tools stay refused even if
    // a later version gives them to the agent.
    let deny = [
        "command",
        "read_file",
        "write_file",
        "read_url",
        "execute_url",
    ]
    .map(|action| format!("{action}(*)"));
    let settings = json!({"permissions": {"deny": deny}});
    let mut args: Vec<String> = [
        // The prompt goes on standard input, where no text can be taken for a flag.
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
        // Without this, a message that starts with `/` runs an agy command.
        "--disable-slash-commands",
        "--settings",
        &settings.to_string(),
        "--agent",
        agent.name,
        "--model",
        request.model.alias(),
        "--effort",
        effort,
    ]
    .map(String::from)
    .into();
    if let Some(schema) = &request.schema {
        args.extend(["--json-schema".into(), schema.to_string()]);
    }
    if let SessionMode::Resume(id) = &request.session {
        args.extend(["--conversation".into(), id.0.clone()]);
    }
    Ok(args)
}
