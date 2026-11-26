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
    /// Fetches the descriptors of an admin's apps, which may be on the server itself.
    http: ureq::Agent,
    /// Fetches the descriptors of everyone else's apps, from public addresses only.
    public_http: ureq::Agent,
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
            http: descriptor::client(Reach::Anywhere),
            public_http: descriptor::client(Reach::PublicOnly),
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
        match self.begin(owner, reach, command)? {
            Step::Done(result) => Ok(result),
            Step::Discover(discovery) => self.finish(discovery.run()?),
        }
    }
    /// The quick part of a command. An add, edit or refresh also gives back the network part, to
    /// run with no lock held and hand to [`finish`](Self::finish).
    pub fn begin(
        &mut self,
        owner: AppOwner,
        reach: Reach,
        command: RegistryCommand,
    ) -> Result<Step, RegistryError> {
        let (before, mut app, change) = match command {
            RegistryCommand::List => {
                return Ok(Step::Done(RegistryResult {
                    apps: self.list(owner),
                    ..Default::default()
                }));
            }
            RegistryCommand::Add(input) => (None, new_app(input)?, RegistryChange::Added),
            RegistryCommand::Edit {
                id,
                address,
                overrides,
            } => {
                let before = self.find(owner, &id)?;
                let mut app = before.clone();
                if let Some(address) = address {
                    app.base_url = AppAddress::parse(&address)?;
                    app.ui_url = app.base_url.resolve("./")?;
                    app.mcp_url = None;
                    app.embedding = Embedding::External;
                    app.label = app.base_url.as_str().into();
                }
                if let Some(overrides) = overrides {
                    descriptor::replace_overrides(&mut app, overrides)?;
                }
                (Some(before), app, RegistryChange::Edited)
            }
            RegistryCommand::Enable { id } => {
                return self
                    .set_enabled(owner, &id, RegistryChange::Enabled)
                    .map(Step::Done);
            }
            RegistryCommand::Disable { id } => {
                return self
                    .set_enabled(owner, &id, RegistryChange::Disabled)
                    .map(Step::Done);
            }
            RegistryCommand::Remove { id } => {
                let app = self.find(owner, &id)?;
                self.storage.remove(&id)?;
                self.apps.retain(|(_, app)| app.id != id);
                self.discovery.remove(&id);
                return Ok(Step::Done(RegistryResult {
                    app: Some(app),
                    change: Some(event(&id, RegistryChange::Removed)),
                    ..Default::default()
                }));
            }
            RegistryCommand::Refresh { id } => {
                let before = self.find(owner, &id)?;
                (Some(before.clone()), before, RegistryChange::Refreshed)
            }
        };
        if change != RegistryChange::Refreshed {
            self.check_duplicate(owner, &app)?;
            descriptor::apply_overrides(&mut app)?;
            descriptor::validate_app(&app)?;
        }
        Ok(Step::Discover(Discovery {
            owner,
            reach,
            http: self.http(reach).clone(),
            before,
            app,
            change,
        }))
    }
    /// Saves what a discovery found, unless the app was changed or removed while it ran.
    pub fn finish(&mut self, found: Discovered) -> Result<RegistryResult, RegistryError> {
        let Discovered {
            owner,
            before,
            app,
            status,
            change,
        } = found;
        if self.owned(owner, &app.id) != before.as_ref() {
            return Err(RegistryError::Changed(app.id));
        }
        self.check_duplicate(owner, &app)?;
        self.store(owner, app, status, change)
    }
    fn http(&self, reach: Reach) -> &ureq::Agent {
        match reach {
            Reach::Anywhere => &self.http,
            Reach::PublicOnly => &self.public_http,
        }
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
        id: &AppId,
        change: RegistryChange,
    ) -> Result<RegistryResult, RegistryError> {
        let mut app = self.find(owner, id)?;
        app.enabled = change == RegistryChange::Enabled;
        self.store(owner, app, self.discovery_status(id), change)
    }
    fn store(
        &mut self,
        owner: AppOwner,
        app: App,
        status: DiscoveryStatus,
        change: RegistryChange,
    ) -> Result<RegistryResult, RegistryError> {
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

/// What a command leaves to do after [`Registry::begin`].
#[allow(
    clippy::large_enum_variant,
    reason = "a step is made once per command and moved straight to its caller"
)]
pub enum Step {
    Done(RegistryResult),
    Discover(Discovery),
}

/// The slow part of an add, edit or refresh: address lookups and the descriptor fetch.
pub struct Discovery {
    owner: AppOwner,
    reach: Reach,
    http: ureq::Agent,
    before: Option<App>,
    app: App,
    change: RegistryChange,
}

impl Discovery {
    /// Fetches the descriptor, checking the app's addresses before and after, since the
    /// descriptor may point the app somewhere else.
    pub fn run(mut self) -> Result<Discovered, RegistryError> {
        check_reach(self.reach, &self.app)?;
        let status = descriptor::discover(&self.http, &mut self.app);
        check_reach(self.reach, &self.app)?;
        Ok(Discovered {
            owner: self.owner,
            before: self.before,
            app: self.app,
            status,
            change: self.change,
        })
    }
}

/// What a [`Discovery`] found, for [`Registry::finish`] to save.
pub struct Discovered {
    owner: AppOwner,
    before: Option<App>,
    app: App,
    status: DiscoveryStatus,
    change: RegistryChange,
}

fn new_app(input: AddApp) -> Result<App, RegistryError> {
    let base_url = AppAddress::parse(&input.address)?;
    descriptor::validate_overrides(&base_url, &input.overrides)?;
    Ok(App {
        id: AppId::generate(),
        label: base_url.as_str().into(),
        ui_url: base_url.resolve("./")?,
        base_url,
        mcp_url: None,
        embedding: Embedding::External,
        enabled: true,
        overrides: input.overrides,
    })
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
