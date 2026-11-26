//! Where registered apps are saved, chosen by the host, and why a registry change can fail.
use super::{App, AppId};
use std::sync::{Arc, Mutex};

/// Who added an app. The host decides what the number means; an app is listed and changed only
/// for its owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AppOwner(pub i64);

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("invalid app address {0:?}; enter a port or an HTTP(S) URL without credentials")]
    InvalidAddress(String),
    #[error("app label must not be empty")]
    EmptyLabel,
    #[error("app {0} is not registered")]
    NotFound(AppId),
    #[error("address is already registered as app {0}")]
    DuplicateAddress(AppId),
    #[error(
        "only an admin can register an app at {0}, because a port, a loopback or a private address reaches services on the server itself; use the app's public address, or ask an admin"
    )]
    ServerSide(String),
    #[error("app {0} was changed while Jet checked its address; try again")]
    Changed(AppId),
    #[error("the saved apps could not be read or written: {0}")]
    Storage(#[source] Box<dyn std::error::Error + Send + Sync>),
}

/// Where the registry saves its apps. A change is saved before the registry shows it, so a failed
/// save changes nothing.
pub trait AppStorage: Send {
    /// Every saved app, with who added it.
    fn load(&self) -> Result<Vec<(AppOwner, App)>, RegistryError>;
    /// Adds the app, or replaces the saved app with the same id.
    fn save(&self, owner: AppOwner, app: &App) -> Result<(), RegistryError>;
    fn remove(&self, id: &AppId) -> Result<(), RegistryError>;
}

/// Apps kept only in this process, for tests. Clones share the same apps, so a registry opened
/// again on a clone sees what the first one saved.
#[derive(Clone, Default)]
pub struct AppsInMemory {
    apps: Arc<Mutex<Vec<(AppOwner, App)>>>,
}

impl AppStorage for AppsInMemory {
    fn load(&self) -> Result<Vec<(AppOwner, App)>, RegistryError> {
        Ok(crate::lock(&self.apps).clone())
    }

    fn save(&self, owner: AppOwner, app: &App) -> Result<(), RegistryError> {
        let mut apps = crate::lock(&self.apps);
        match apps.iter_mut().find(|(_, saved)| saved.id == app.id) {
            Some(saved) => *saved = (owner, app.clone()),
            None => apps.push((owner, app.clone())),
        }
        Ok(())
    }

    fn remove(&self, id: &AppId) -> Result<(), RegistryError> {
        crate::lock(&self.apps).retain(|(_, app)| &app.id != id);
        Ok(())
    }
}
