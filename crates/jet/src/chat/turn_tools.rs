//! The tool server a turn's provider calls, as the chat sees it. The chat owns this trait and the
//! tool server implements it, so the chat never has to import the tool server.

use agent::{McpConnection, TurnIdentity};

/// The tool server a turn's provider calls. Each turn is bound to it when it starts and let go of
/// it when it ends.
pub(crate) trait TurnTools: Send + Sync {
    /// Gives the provider a connection that is tied to this turn.
    fn bind(&self, identity: &TurnIdentity) -> McpConnection;
    /// Cancels the running calls of the request and refuses its later ones.
    fn revoke(&self, request_id: &str);
    /// Lets go of every turn.
    fn shutdown(&self);
}
