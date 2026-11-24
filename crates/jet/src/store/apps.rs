//! The apps each user registered, kept for the registry that serves them.

use super::{Store, StoreError, UserId, from_json, to_json};
use agent::apps::{App, AppId, AppOwner, AppStorage, RegistryError};
use rusqlite::params;

impl Store {
    /// Every registered app with the user who added it, in the order they were added.
    pub(crate) fn apps(&self) -> Result<Vec<(UserId, App)>, StoreError> {
        let rows = self.with(|db| {
            let mut query = db.prepare("SELECT user_id, app FROM apps ORDER BY rowid")?;
            let rows = query.query_map([], |row| {
                Ok((UserId(row.get(0)?), row.get::<_, String>(1)?))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })?;
        rows.into_iter()
            .map(|(user, text)| Ok((user, from_json("an app", &text)?)))
            .collect()
    }

    pub(crate) fn save_app(&self, user: UserId, app: &App) -> Result<(), StoreError> {
        let text = to_json(app)?;
        self.with(|db| {
            db.execute(
                "INSERT INTO apps (id, user_id, app) VALUES (?1, ?2, ?3)
                 ON CONFLICT (id) DO UPDATE SET app = excluded.app",
                params![app.id.to_string(), user.0, text],
            )
            .map(drop)
        })
    }

    pub(crate) fn remove_app(&self, id: &AppId) -> Result<(), StoreError> {
        self.with(|db| {
            db.execute("DELETE FROM apps WHERE id = ?1", [id.to_string()])
                .map(drop)
        })
    }
}

/// The registry saves its apps here. The owner number of the registry is the user's id.
impl AppStorage for Store {
    fn load(&self) -> Result<Vec<(AppOwner, App)>, RegistryError> {
        let apps = self.apps().map_err(storage_error)?;
        Ok(apps
            .into_iter()
            .map(|(user, app)| (AppOwner(user.0), app))
            .collect())
    }

    fn save(&self, owner: AppOwner, app: &App) -> Result<(), RegistryError> {
        self.save_app(UserId(owner.0), app).map_err(storage_error)
    }

    fn remove(&self, id: &AppId) -> Result<(), RegistryError> {
        self.remove_app(id).map_err(storage_error)
    }
}

fn storage_error(error: StoreError) -> RegistryError {
    RegistryError::Storage(Box::new(error))
}
