//! Serialize registry changes, saving successfully before publishing them.
use super::{
    AddApp, App, AppAddress, AppId, DiscoveryStatus, Embedding, RegistryChange, RegistryCommand,
    RegistryError, RegistryEvent, RegistryResult, descriptor, storage,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver, Sender},
};

pub struct Registry {
    path: PathBuf,
    apps: Vec<App>,
    discovery: HashMap<AppId, DiscoveryStatus>,
    subscribers: Vec<Sender<RegistryEvent>>,
    http: ureq::Agent,
}

impl Registry {
    pub fn open(data_dir: &Path) -> Result<Self, RegistryError> {
        let path = data_dir.join("apps.json");
        storage::check_legacy_settings(&data_dir.join("settings.json"))?;
        Ok(Self {
            apps: storage::load(&path)?,
            path,
            discovery: HashMap::new(),
            subscribers: Vec::new(),
            http: descriptor::client(),
        })
    }
    pub fn list(&self) -> &[App] {
        &self.apps
    }
    pub fn get(&self, id: &AppId) -> Option<&App> {
        self.apps.iter().find(|app| &app.id == id)
    }
    pub fn discovery_status(&self, id: &AppId) -> DiscoveryStatus {
        self.discovery.get(id).cloned().unwrap_or_default()
    }
    pub fn subscribe(&mut self) -> Receiver<RegistryEvent> {
        let (sender, receiver) = mpsc::channel();
        self.subscribers.push(sender);
        receiver
    }
    pub fn execute(&mut self, command: RegistryCommand) -> Result<RegistryResult, RegistryError> {
        match command {
            RegistryCommand::List => Ok(RegistryResult {
                app: None,
                apps: self.apps.clone(),
                discovery: None,
                change: None,
            }),
            RegistryCommand::Add(input) => self.add(input),
            RegistryCommand::Edit {
                id,
                address,
                overrides,
            } => {
                let mut app = self.find(&id)?;
                if let Some(address) = address {
                    app.base_url = AppAddress::parse(&address)?;
                    self.check_duplicate(&app)?;
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
                let status = descriptor::discover(&self.http, &mut app);
                self.store(app, status, RegistryChange::Edited)
            }
            RegistryCommand::Enable { id } => self.set_enabled(&id, RegistryChange::Enabled),
            RegistryCommand::Disable { id } => self.set_enabled(&id, RegistryChange::Disabled),
            RegistryCommand::Remove { id } => {
                let app = self.find(&id)?;
                let apps: Vec<_> = self
                    .apps
                    .iter()
                    .filter(|app| app.id != id)
                    .cloned()
                    .collect();
                storage::save(&self.path, &apps)?;
                self.apps = apps;
                self.discovery.remove(&id);
                let event = self.publish(&id, RegistryChange::Removed);
                Ok(RegistryResult {
                    app: Some(app),
                    apps: Vec::new(),
                    discovery: None,
                    change: Some(event),
                })
            }
            RegistryCommand::Refresh { id } => {
                let mut app = self.find(&id)?;
                let status = descriptor::discover(&self.http, &mut app);
                self.store(app, status, RegistryChange::Refreshed)
            }
        }
    }
    fn add(&mut self, input: AddApp) -> Result<RegistryResult, RegistryError> {
        let base_url = AppAddress::parse(&input.address)?;
        descriptor::validate_overrides(&base_url, &input.overrides)?;
        if let Some(app) = self.apps.iter().find(|app| app.base_url == base_url) {
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
        let status = descriptor::discover(&self.http, &mut app);
        self.store(app, status, RegistryChange::Added)
    }
    fn find(&self, id: &AppId) -> Result<App, RegistryError> {
        self.get(id)
            .cloned()
            .ok_or_else(|| RegistryError::NotFound(id.clone()))
    }
    fn check_duplicate(&self, app: &App) -> Result<(), RegistryError> {
        if let Some(other) = self
            .apps
            .iter()
            .find(|other| other.id != app.id && other.base_url == app.base_url)
        {
            return Err(RegistryError::DuplicateAddress(other.id.clone()));
        }
        Ok(())
    }
    fn set_enabled(
        &mut self,
        id: &AppId,
        change: RegistryChange,
    ) -> Result<RegistryResult, RegistryError> {
        let mut app = self.find(id)?;
        app.enabled = change == RegistryChange::Enabled;
        self.store(app, self.discovery_status(id), change)
    }
    fn store(
        &mut self,
        app: App,
        status: DiscoveryStatus,
        change: RegistryChange,
    ) -> Result<RegistryResult, RegistryError> {
        let mut apps = self.apps.clone();
        if let Some(stored) = apps.iter_mut().find(|stored| stored.id == app.id) {
            *stored = app.clone();
        } else {
            apps.push(app.clone());
        }
        storage::save(&self.path, &apps)?;
        self.apps = apps;
        self.discovery.insert(app.id.clone(), status.clone());
        let event = self.publish(&app.id, change);
        Ok(RegistryResult {
            app: Some(app),
            apps: Vec::new(),
            discovery: Some(status),
            change: Some(event),
        })
    }
    fn publish(&mut self, id: &AppId, change: RegistryChange) -> RegistryEvent {
        let event = RegistryEvent {
            app_id: id.clone(),
            change,
        };
        self.subscribers
            .retain(|sender| sender.send(event.clone()).is_ok());
        event
    }
}
