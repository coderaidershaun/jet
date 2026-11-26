//! What the scheduler does with a colleague's item before it brings the item to the user: the
//! recipient's Jet first tries to answer it from the objectives the user shares with the sender,
//! in a turn that is given nothing else.

use super::Scheduler;
use crate::objectives::InboxError;
use crate::settings::Settings;
use crate::store::{AgentTask, Closed, Item, ItemState, StoreError};
use agent::{AnswerAsk, AnswerError};

/// How the item goes on.
pub(super) enum Before {
    /// It was answered from the shared objectives; nothing is brought to the user.
    Answered,
    /// It ended already, so there is nothing to bring.
    Closed,
    /// The server is stopping.
    Interrupted,
    /// The user has to see it.
    BringUp,
}

impl Scheduler {
    /// Tries once, ever, to answer the item from the objectives the item's recipient shares with
    /// its sender. A turn with nothing shared is never started. An error or a turn that says it
    /// cannot answer sends nothing to the sender.
    pub(super) fn before_item(
        &self,
        task: &AgentTask,
        item: &Item,
        settings: &Settings,
    ) -> Result<Before, StoreError> {
        if !matches!(item.state, ItemState::Sent | ItemState::Seen) {
            return Ok(Before::Closed);
        }
        if item.tried_alone {
            return Ok(Before::BringUp);
        }
        self.store.mark_item_tried(item.id)?;
        let shared = match self.objectives.shared_with(item.from, item.to) {
            Ok(shared) if !shared.is_empty() => shared,
            _ => return Ok(Before::BringUp),
        };
        let Some(chats) = self.chats.upgrade() else {
            return Ok(Before::Interrupted);
        };
        let Ok(chat) = chats.chat(task.user, Some(task.chat_id)) else {
            return Ok(Before::BringUp);
        };
        let Ok(transport) = chat.transport_for(settings.model) else {
            return Ok(Before::BringUp);
        };
        let (quote, objectives) = (
            self.objectives.quote(item)?,
            serde_json::to_string(&shared).unwrap_or_default(),
        );
        let ask = AnswerAsk {
            name: &settings.persona.name,
            model: settings.model,
            effort: settings.effort,
            from: &quote.name,
            kind: &quote.kind,
            sent: &self
                .objectives
                .describe(item.to, item.sent_at)
                .unwrap_or_default(),
            text: &quote.text,
            shared_objectives: &objectives,
            time_limit: self.time_limit,
        };
        match agent::answer_from_shared(&*transport, &ask, |stopper| {
            self.signals.attach(stopper, &self.stopping)
        }) {
            Ok(Some(answer)) => match self.objectives.answer_by_jet(item, &answer) {
                Ok(Closed::Done(posted)) => {
                    chats.announce_posted(&posted);
                    Ok(Before::Answered)
                }
                Ok(_) => Ok(Before::Closed),
                Err(InboxError::Store(error)) => Err(error),
                Err(_) => Ok(Before::BringUp),
            },
            Err(AnswerError::Stopped) => Ok(Before::Interrupted),
            Ok(None) | Err(_) => Ok(Before::BringUp),
        }
    }
}
