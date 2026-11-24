//! Where Jet looks for evidence about an objective: its own records, a GitHub repository, a web
//! page or search, or one read-only tool of an app.

use super::text_enum::text_enum;
use super::{ObjectiveId, Store, StoreError, UserId};
use rusqlite::{Transaction, params};
use serde::Serialize;

text_enum!(SourceKind {
    Jet = "jet",
    Github = "github",
    Web = "web",
    App = "app",
});

/// The `target` and `detail` columns mean: `jet` nothing; `github` the repository and the user's
/// login; `web` a page address with detail `page`, or a search topic with detail `search`; `app`
/// the app's id and one tool of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NewSource {
    pub(crate) kind: SourceKind,
    pub(crate) target: String,
    pub(crate) detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Source {
    pub(crate) kind: SourceKind,
    pub(crate) target: String,
    pub(crate) detail: String,
}

pub(super) fn insert_all(
    tx: &Transaction,
    objective: ObjectiveId,
    sources: &[NewSource],
) -> rusqlite::Result<()> {
    for source in sources {
        tx.execute(
            "INSERT INTO objective_sources (objective_id, kind, target, detail) VALUES (?1, ?2, ?3, ?4)",
            params![objective.0, source.kind, source.target, source.detail],
        )?;
    }
    Ok(())
}

impl Store {
    pub(crate) fn sources(
        &self,
        owner: UserId,
        objective: ObjectiveId,
    ) -> Result<Vec<Source>, StoreError> {
        self.with(|db| {
            let mut query = db.prepare(
                "SELECT s.kind, s.target, s.detail
                 FROM objective_sources s JOIN objectives o ON o.id = s.objective_id
                 WHERE o.id = ?1 AND o.user_id = ?2 ORDER BY s.id",
            )?;
            query
                .query_map(params![objective.0, owner.0], |row| {
                    Ok(Source {
                        kind: row.get(0)?,
                        target: row.get(1)?,
                        detail: row.get(2)?,
                    })
                })?
                .collect()
        })
    }
}
