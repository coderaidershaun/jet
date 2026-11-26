//! Open the host, serve its routes, restore it to factory defaults and shut it down. It joins the
//! jobs of the crate: accounts, chat, apps, files, voice and the tool facade.

mod chats;
mod config;
mod inbox;
mod pane;
mod reset;
mod routes;
mod shares;
mod task_list;

use crate::account::{self, AccountError, Accounts};
use crate::apps::{Apps, Proxy};
use crate::chat::{BridgeError, Chats, TurnTools};
use crate::evidence::{Evidence, GithubTokens};
use crate::files::Files;
use crate::lock;
use crate::mcp_servers::McpServers;
use crate::objectives::{self, Objectives};
use crate::scheduler::{Scheduler, Signals};
use crate::seal::{SealError, Sealer};
use crate::store::{Email, ImportError, Store, StoreError};
use crate::tool_facade::Facade;
use crate::voice::Voice;
use agent::apps::Registry;
use axum::{
    Router,
    extract::{FromRef, Request},
};
pub use config::ServerConfig;
use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{RwLock, mpsc, oneshot};

#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    #[error("invalid server configuration: {0}")]
    Config(String),
    #[error(transparent)]
    Registry(#[from] agent::apps::RegistryError),
    #[error(transparent)]
    Chat(#[from] BridgeError),
    #[error(transparent)]
    Account(#[from] AccountError),
    #[error(transparent)]
    Seal(#[from] SealError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("could not copy the older Jet's files into the database")]
    Import(#[from] ImportError),
    #[error("server network operation failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("server task failed: {0}")]
    Task(#[from] tokio::task::JoinError),
}

#[derive(Clone)]
pub struct Server {
    accounts: Accounts,
    store: Store,
    chats: Arc<Chats>,
    apps: Apps,
    facade: Arc<Facade>,
    objectives: Objectives,
    scheduler: Arc<Scheduler>,
    files: Files,
    github_tokens: GithubTokens,
    mcp_servers: McpServers,
    voice: Voice,
    config: ServerConfig,
}

impl FromRef<Server> for Accounts {
    fn from_ref(server: &Server) -> Self {
        server.accounts.clone()
    }
}

impl FromRef<Server> for Apps {
    fn from_ref(server: &Server) -> Self {
        server.apps.clone()
    }
}

impl FromRef<Server> for Files {
    fn from_ref(server: &Server) -> Self {
        server.files.clone()
    }
}

impl FromRef<Server> for Arc<Chats> {
    fn from_ref(server: &Server) -> Self {
        server.chats.clone()
    }
}

impl FromRef<Server> for GithubTokens {
    fn from_ref(server: &Server) -> Self {
        server.github_tokens.clone()
    }
}

impl FromRef<Server> for McpServers {
    fn from_ref(server: &Server) -> Self {
        server.mcp_servers.clone()
    }
}

impl FromRef<Server> for Voice {
    fn from_ref(server: &Server) -> Self {
        server.voice.clone()
    }
}

impl Server {
    pub fn open(config: ServerConfig) -> Result<Self, ServerError> {
        let voice = Voice::new(config.disable_voice);
        Self::open_with(config, voice)
    }

    /// Builds every part of the host from the data folder. The voice is given, because a reset
    /// keeps it: the loaded speech models and what is left of Google's allowance belong to the
    /// machine, not to the data a reset deletes.
    fn open_with(config: ServerConfig, voice: Voice) -> Result<Self, ServerError> {
        let proxy = Proxy::new(config.public_origin.as_deref(), config.listen)
            .map_err(|error| ServerError::Config(error.to_string()))?;
        let store = Store::open(&config.data_dir)?;
        let accounts = Accounts::open(&config, store.clone())?;
        if store.import_legacy(&config.data_dir, &Email::from(account::OWNER))? {
            eprintln!("jet: copied the older Jet's files into the owner's account; the files stay");
        }
        let registry = Arc::new(Mutex::new(Registry::open(Box::new(store.clone()))?));
        let sealer = Sealer::open(&config.data_dir)?;
        let github_tokens = GithubTokens::new(store.clone(), sealer.clone());
        let test_clock = objectives::test_clock();
        let clock = test_clock.clone().unwrap_or_else(objectives::system_clock);
        let (mcp_servers, mcp) = McpServers::open(
            store.clone(),
            sealer,
            registry.clone(),
            config.public_origin.clone(),
            clock.clone(),
        );
        let files = Files::new(store.clone());
        let apps = Apps::new(registry, mcp, mcp_servers.clone(), proxy, store.clone());
        let signals = Signals::default();
        let objectives = Objectives::new(store.clone(), clock).with_signals(signals.clone());
        let facade = Facade::new(
            apps.clone(),
            files.clone(),
            format!("http://{}/mcp", config.listen),
            config.public_origin.clone(),
            accounts.keys().clone(),
            Evidence::new(github_tokens.clone()),
            objectives.clone(),
        );
        let chats = Chats::new(
            store.clone(),
            facade.clone(),
            files.clone(),
            config.data_dir.clone(),
            config.review_quiet,
            signals.clone(),
        );
        chats.set_review_gap(config.review_gap);
        *lock(&facade.chats) = Arc::downgrade(&chats);
        let scheduler = Scheduler::new(
            store.clone(),
            objectives.clone(),
            &chats,
            facade.clone(),
            signals,
            test_clock.is_some(),
        );
        apps.tell_chats(Arc::downgrade(&chats));
        Ok(Self {
            accounts,
            store,
            chats,
            apps,
            facade,
            objectives,
            scheduler,
            files,
            github_tokens,
            mcp_servers,
            voice,
            config,
        })
    }

    /// Starts the scheduler and gives the router of this host, with the channel on which its
    /// reset route asks. `mcp_url` is the tool server at the address the host really listens on.
    fn start(&self, mcp_url: &str) -> (Router, mpsc::Receiver<reset::Answer>) {
        self.facade.set_url(mcp_url.to_owned());
        self.scheduler.start();
        let (asks, asked) = mpsc::channel(1);
        (routes::router(self.clone(), asks), asked)
    }

    /// Restores the server to factory defaults: stops this host and its provider turns, deletes
    /// everything below the data folder and the folders of its agy turns, and opens a new host
    /// there as a first start does, with the demo accounts. The second value names what could not
    /// be deleted.
    ///
    /// The database is closed for every part of this host before its file goes, so a turn that
    /// ends late writes nowhere. An error means no host could be opened on the data folder.
    async fn reset(&self) -> Result<(Self, Result<(), reset::ResetError>), ServerError> {
        self.shutdown().await;
        let (store, config, voice) = (self.store.clone(), self.config.clone(), self.voice.clone());
        tokio::task::spawn_blocking(move || {
            store.close()?;
            let left = reset::wipe(&config);
            Ok((Self::open_with(config, voice)?, left))
        })
        .await?
    }

    /// Stops provider work and closes event streams within a fixed cleanup deadline.
    async fn shutdown(&self) {
        self.scheduler.stop();
        self.facade.shutdown();
        self.apps.shutdown().await;
        let chats = self.chats.clone();
        if let Err(error) = tokio::task::spawn_blocking(move || chats.shutdown()).await {
            eprintln!("jet: shutdown worker failed: {error}");
        }
    }

    /// Serves the host until a stop signal. Every request goes to the router of the host that is
    /// live now, so a reset swaps the whole host under the open port, with no restart.
    pub async fn serve(self, listener: tokio::net::TcpListener) -> Result<(), ServerError> {
        let address = listener.local_addr()?;
        let ip = if address.ip().is_unspecified() {
            std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
        } else {
            address.ip()
        };
        let mcp_url = format!("http://{}/mcp", SocketAddr::new(ip, address.port()));
        let mut host = self;
        let (router, mut resets) = host.start(&mcp_url);
        let live = Arc::new(RwLock::new(router));
        let answering = live.clone();
        let app = Router::new().fallback(move |request: Request| {
            let answering = answering.clone();
            async move {
                let mut router = answering.read().await.clone();
                let Ok(response) = tower::Service::call(&mut router, request).await;
                response
            }
        });
        let (finish, finished) = oneshot::channel::<()>();
        let mut running = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = finished.await;
            })
            .await
        });
        let stop = shutdown_signal();
        tokio::pin!(stop);
        loop {
            tokio::select! {
                result = &mut running => {
                    return Ok(result??);
                }
                () = &mut stop => break,
                Some(answer) = resets.recv() => {
                    // New requests wait here until the new host can answer them.
                    let mut router = live.write().await;
                    let (fresh, left) = host.reset().await.inspect_err(|_| {
                        eprintln!("jet: the reset stopped the host and could not open a new one; start Jet again");
                    })?;
                    host = fresh;
                    (*router, resets) = host.start(&mcp_url);
                    if answer.send(left).is_err() {
                        eprintln!("jet: the reset is done; the admin who asked for it has gone");
                    }
                }
            }
        }
        host.shutdown().await;
        if finish.send(()).is_err() {
            eprintln!("jet: server already stopped");
        }
        match tokio::time::timeout(Duration::from_secs(2), &mut running).await {
            Ok(result) => Ok(result??),
            Err(_) => {
                running.abort();
                eprintln!("jet: closed browser connections after shutdown deadline");
                Ok(())
            }
        }
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
        Ok(mut terminate) => tokio::select! {
            () = interrupted() => {}
            _ = terminate.recv() => {}
        },
        Err(error) => {
            eprintln!("jet: termination signal: {error}");
            interrupted().await;
        }
    }
    #[cfg(not(unix))]
    interrupted().await;
}

/// Returns when the user presses Ctrl-C. When the signal cannot be watched, it never returns,
/// because a host that cannot hear a stop must keep running, not stop.
async fn interrupted() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        eprintln!("jet: signal: {error}");
        std::future::pending::<()>().await;
    }
}
