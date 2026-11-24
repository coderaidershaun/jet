//! What the plan pane keeps: the taps Jet is told of, and who has shared objectives with a user.

use super::{ChatId, ObjectiveId, Store, StoreError, UserId, seconds};
use rusqlite::params;

impl Store {
    /// Keeps a tap of the user's, as the line Jet is told before their next message in `chat`.
    pub(crate) fn record_tap(
        &self,
        user: UserId,
        chat: ChatId,
        line: &str,
        at: u64,
    ) -> Result<(), StoreError> {
        self.with(|db| {
            db.execute(
                "INSERT INTO pane_taps (user_id, chat_id, line, at) VALUES (?1, ?2, ?3, ?4)",
                params![user.0, chat.0, line, seconds(at)],
            )
            .map(drop)
        })
    }

    /// The people an objective is shared with, directly or through a team.
    pub(crate) fn viewers(&self, objective: ObjectiveId) -> Result<Vec<UserId>, StoreError> {
        self.with(|db| {
            db.prepare(
                "SELECT user_id FROM objective_shares WHERE objective_id = ?1 AND user_id IS NOT NULL
                 UNION SELECT m.user_id FROM objective_shares s JOIN team_members m ON m.team_id = s.team_id
                 WHERE s.objective_id = ?1",
            )?
            .query_map([objective.0], |row| Ok(UserId(row.get(0)?)))?
            .collect()
        })
    }

    /// The people who share at least one objective with `viewer`, directly or through a team.
    pub(crate) fn sharers(&self, viewer: UserId) -> Result<Vec<(UserId, String)>, StoreError> {
        self.with(|db| {
            db.prepare(
                "SELECT u.id, u.display_name FROM users u WHERE u.id IN (
                     SELECT o.user_id FROM objectives o JOIN objective_shares s ON s.objective_id = o.id
                     WHERE o.user_id != ?1 AND (s.user_id = ?1
                        OR s.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?1)))
                 ORDER BY u.id",
            )?
            .query_map([viewer.0], |row| Ok((UserId(row.get(0)?), row.get(1)?)))?
            .collect()
        })
    }
}
