//! The tool server a turn's provider calls, as the chat sees it. The chat owns this trait and the
//! tool server implements it, so the chat never has to import the tool server.

use crate::store::{ChatId, UserId};
use agent::{McpConnection, McpServerFacts, TurnIdentity};

/// Whose turn it is: the signed-in user who sent the message, for whom the turn's tools act, and
/// the chat it runs in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TurnOwner {
    pub user: UserId,
    pub chat: ChatId,
}

/// The tool server a turn's provider calls. Each turn is bound to it when it starts and let go of
/// it when it ends.
pub(crate) trait TurnTools: Send + Sync {
    /// Gives the provider a connection that is tied to this turn. `reads_web` says whether the
    /// provider may search and read the web in it.
    fn bind(&self, identity: &TurnIdentity, reads_web: bool, owner: TurnOwner) -> McpConnection;
    /// The prompt of this turn carries a colleague's words, so the turn is refused what is
    /// refused after web text from its first call, and sending to colleagues too when the words
    /// are a message (`item`) and not only an answer.
    fn colleague_text_read(&self, owner: TurnOwner, request_id: &str, item: bool);
    /// Cancels the running calls of the request and refuses its later ones.
    /// Only the turns of `owner` are touched, so another user's request with the same id is not.
    fn revoke(&self, owner: TurnOwner, request_id: &str);
    /// Lets go of every turn.
    fn shutdown(&self);
    /// The MCP servers the user has turned on, as Jet is told of them at the start of a turn. A
    /// stand-in with no tool server has none.
    fn mcp_servers(&self, _user: UserId) -> Vec<McpServerFacts> {
        Vec::new()
    }
}
