//! Serialize registry changes, saving each one before the registry shows it. Each app belongs to
//! the owner who added it: only that owner lists, changes or removes it.
use super::{
    AddApp, App, AppAddress, AppId, AppOwner, AppStorage, DiscoveryStatus, Embedding, Reach,
    RegistryChange, RegistryCommand, RegistryError, RegistryEvent, RegistryResult,
    address::reaches_server_side, descriptor,
};
use std::collections::HashMap;

pub struct Registry {
    storage: Box<dyn AppStorage>,
    apps: Vec<(AppOwner, App)>,
    discovery: HashMap<AppId, DiscoveryStatus>,
    http: ureq::Agent,
}

impl Registry {
    pub fn open(storage: Box<dyn AppStorage>) -> Result<Self, RegistryError> {
        let apps = storage.load()?;
        for (_, app) in &apps {
            descriptor::validate_app(app)?;
        }
        Ok(Self {
            storage,
            apps,
            discovery: HashMap::new(),
            http: descriptor::client(),
        })
    }
    /// The owner's apps, in the order they were added.
    pub fn list(&self, owner: AppOwner) -> Vec<App> {
        self.apps
            .iter()
            .filter(|(by, _)| *by == owner)
            .map(|(_, app)| app.clone())
            .collect()
    }
    /// The app with this id, whoever added it. Only for code that has already checked the owner.
    pub fn get(&self, id: &AppId) -> Option<&App> {
        self.apps
            .iter()
            .find(|(_, app)| &app.id == id)
            .map(|(_, app)| app)
    }
    /// The app with this id when it belongs to `owner`.
    pub fn owned(&self, owner: AppOwner, id: &AppId) -> Option<&App> {
        self.apps
            .iter()
            .find(|(by, app)| *by == owner && &app.id == id)
            .map(|(_, app)| app)
    }
    pub fn owner_of(&self, id: &AppId) -> Option<AppOwner> {
        self.apps
            .iter()
            .find(|(_, app)| &app.id == id)
            .map(|(owner, _)| *owner)
    }
    pub fn discovery_status(&self, id: &AppId) -> DiscoveryStatus {
        self.discovery.get(id).cloned().unwrap_or_default()
    }
    /// Runs the command for `owner`, who may save apps only where `reach` allows. An app outside
    /// that reach is refused before Jet contacts it.
    pub fn execute(
        &mut self,
        owner: AppOwner,
        reach: Reach,
        command: RegistryCommand,
    ) -> Result<RegistryResult, RegistryError> {
        match command {
            RegistryCommand::List => Ok(RegistryResult {
                apps: self.list(owner),
                ..Default::default()
            }),
            RegistryCommand::Add(input) => self.add(owner, reach, input),
            RegistryCommand::Edit {
                id,
                address,
                overrides,
            } => {
                let mut app = self.find(owner, &id)?;
                if let Some(address) = address {
                    app.base_url = AppAddress::parse(&address)?;
                    self.check_duplicate(owner, &app)?;
                    app.ui_url = app.base_url.resolve("./")?;
                    app.mcp_url = None;
                    app.embedding = Embedding::External;
                    app.label = app.base_url.as_str().into();
                }
                if let Some(overrides) = overrides {
                    descriptor::replace_overrides(&mut app, overrides)?;
                }
                descriptor::apply_overrides(&mut app)?;
                descriptor::validate_app(&app)?;
                check_reach(reach, &app)?;
                let status = descriptor::discover(&self.http, &mut app);
                self.store(owner, reach, app, status, RegistryChange::Edited)
            }
            RegistryCommand::Enable { id } => {
                self.set_enabled(owner, reach, &id, RegistryChange::Enabled)
            }
            RegistryCommand::Disable { id } => {
                self.set_enabled(owner, reach, &id, RegistryChange::Disabled)
            }
            RegistryCommand::Remove { id } => {
                let app = self.find(owner, &id)?;
                self.storage.remove(&id)?;
                self.apps.retain(|(_, app)| app.id != id);
                self.discovery.remove(&id);
                Ok(RegistryResult {
                    app: Some(app),
                    change: Some(event(&id, RegistryChange::Removed)),
                    ..Default::default()
                })
            }
            RegistryCommand::Refresh { id } => {
                let mut app = self.find(owner, &id)?;
                check_reach(reach, &app)?;
                let status = descriptor::discover(&self.http, &mut app);
                self.store(owner, reach, app, status, RegistryChange::Refreshed)
            }
        }
    }
    fn add(
        &mut self,
        owner: AppOwner,
        reach: Reach,
        input: AddApp,
    ) -> Result<RegistryResult, RegistryError> {
        let base_url = AppAddress::parse(&input.address)?;
        descriptor::validate_overrides(&base_url, &input.overrides)?;
        if let Some((_, app)) = self
            .apps
            .iter()
            .find(|(by, app)| *by == owner && app.base_url == base_url)
        {
            return Err(RegistryError::DuplicateAddress(app.id.clone()));
        }
        let mut app = App {
            id: AppId::generate(),
            label: base_url.as_str().into(),
            ui_url: base_url.resolve("./")?,
            base_url,
            mcp_url: None,
            embedding: Embedding::External,
            enabled: true,
            overrides: input.overrides,
        };
        descriptor::apply_overrides(&mut app)?;
        descriptor::validate_app(&app)?;
        check_reach(reach, &app)?;
        let status = descriptor::discover(&self.http, &mut app);
        self.store(owner, reach, app, status, RegistryChange::Added)
    }
    fn find(&self, owner: AppOwner, id: &AppId) -> Result<App, RegistryError> {
        self.owned(owner, id)
            .cloned()
            .ok_or_else(|| RegistryError::NotFound(id.clone()))
    }
    fn check_duplicate(&self, owner: AppOwner, app: &App) -> Result<(), RegistryError> {
        if let Some((_, other)) = self.apps.iter().find(|(by, other)| {
            *by == owner && other.id != app.id && other.base_url == app.base_url
        }) {
            return Err(RegistryError::DuplicateAddress(other.id.clone()));
        }
        Ok(())
    }
    fn set_enabled(
        &mut self,
        owner: AppOwner,
        reach: Reach,
        id: &AppId,
        change: RegistryChange,
    ) -> Result<RegistryResult, RegistryError> {
        let mut app = self.find(owner, id)?;
        app.enabled = change == RegistryChange::Enabled;
        self.store(owner, reach, app, self.discovery_status(id), change)
    }
    /// Saves the app, after checking again what its own descriptor may have pointed it at.
    fn store(
        &mut self,
        owner: AppOwner,
        reach: Reach,
        app: App,
        status: DiscoveryStatus,
        change: RegistryChange,
    ) -> Result<RegistryResult, RegistryError> {
        check_reach(reach, &app)?;
        self.storage.save(owner, &app)?;
        match self.apps.iter_mut().find(|(_, stored)| stored.id == app.id) {
            Some(stored) => stored.1 = app.clone(),
            None => self.apps.push((owner, app.clone())),
        }
        self.discovery.insert(app.id.clone(), status.clone());
        Ok(RegistryResult {
            change: Some(event(&app.id, change)),
            app: Some(app),
            discovery: Some(status),
            ..Default::default()
        })
    }
}

/// Refuses an app whose page, tools or base is on the server itself when the owner may only reach
/// public addresses.
fn check_reach(reach: Reach, app: &App) -> Result<(), RegistryError> {
    if reach == Reach::Anywhere {
        return Ok(());
    }
    let addresses = [
        Some(app.base_url.url()),
        Some(&app.ui_url),
        app.mcp_url.as_ref(),
    ];
    match addresses
        .into_iter()
        .flatten()
        .find(|url| reaches_server_side(url))
    {
        Some(url) => Err(RegistryError::ServerSide(url.to_string())),
        None => Ok(()),
    }
}

fn event(id: &AppId, change: RegistryChange) -> RegistryEvent {
    RegistryEvent {
        app_id: id.clone(),
        change,
    }
}
