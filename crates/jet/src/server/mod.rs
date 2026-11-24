//! Open the host, serve its routes and shut it down. It joins the jobs of the crate: accounts,
//! chat, apps, files, voice and the tool facade.

mod chats;
mod config;
mod routes;

use crate::account::{self, AccountError, Accounts};
use crate::apps::{Apps, Proxy};
use crate::chat::{BridgeError, Chats, TurnTools};
use crate::evidence::{Evidence, GithubTokens, TokenError};
use crate::facade::Facade;
use crate::files::Files;
use crate::lock;
use crate::objectives::{self, Objectives};
use crate::store::{Email, ImportError, Store, StoreError};
use crate::voice::Voice;
use agent::{apps::Registry, mcp::HttpMcpClient};
use axum::{Router, extract::FromRef};
pub use config::ServerConfig;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

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
    Token(#[from] TokenError),
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
    files: Files,
    github_tokens: GithubTokens,
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

impl FromRef<Server> for GithubTokens {
    fn from_ref(server: &Server) -> Self {
        server.github_tokens.clone()
    }
}

impl FromRef<Server> for Voice {
    fn from_ref(server: &Server) -> Self {
        server.voice.clone()
    }
}

impl Server {
    pub fn open(config: ServerConfig) -> Result<Self, ServerError> {
        let proxy = Proxy::new(config.public_origin.as_deref(), config.listen)
            .map_err(|error| ServerError::Config(error.to_string()))?;
        let store = Store::open(&config.data_dir)?;
        let accounts = Accounts::open(&config, store.clone())?;
        if store.import_legacy(&config.data_dir, &Email::from(account::OWNER))? {
            eprintln!("jet: copied the older Jet's files into the owner's account; the files stay");
        }
        let registry = Arc::new(Mutex::new(Registry::open(Box::new(store.clone()))?));
        let github_tokens = GithubTokens::open(store.clone(), &config.data_dir)?;
        let mcp = Arc::new(HttpMcpClient::new(registry.clone()));
        let files = Files::new(store.clone());
        let apps = Apps::new(registry, mcp, proxy, store.clone());
        let facade = Facade::new(
            apps.clone(),
            files.clone(),
            format!("http://{}/mcp", config.listen),
            config.public_origin.clone(),
            accounts.keys().clone(),
            Evidence::new(github_tokens.clone()),
            Objectives::new(store.clone(), objectives::system_clock()),
        );
        let chats = Chats::new(
            store.clone(),
            facade.clone(),
            files.clone(),
            config.data_dir.clone(),
            config.review_quiet,
        );
        *lock(&facade.chats) = Arc::downgrade(&chats);
        apps.tell_chats(Arc::downgrade(&chats));
        Ok(Self {
            accounts,
            store,
            chats,
            apps,
            facade,
            files,
            github_tokens,
            voice: Voice::new(config.disable_voice),
            config,
        })
    }

    fn router(&self) -> Router {
        routes::router(self.clone())
    }

    /// Stops provider work and closes event streams within a fixed cleanup deadline.
    async fn shutdown(&self) {
        self.facade.shutdown();
        self.apps.shutdown().await;
        let chats = self.chats.clone();
        if let Err(error) = tokio::task::spawn_blocking(move || chats.shutdown()).await {
            eprintln!("jet: shutdown worker failed: {error}");
        }
    }

    pub async fn serve(self, listener: tokio::net::TcpListener) -> Result<(), ServerError> {
        let address = listener.local_addr()?;
        let ip = if address.ip().is_unspecified() {
            std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
        } else {
            address.ip()
        };
        self.facade.set_url(format!(
            "http://{}/mcp",
            std::net::SocketAddr::new(ip, address.port())
        ));
        let router = self.router();
        let (finish, finished) = tokio::sync::oneshot::channel::<()>();
        let mut running = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = finished.await;
            })
            .await
        });
        tokio::select! {
            result = &mut running => {
                return Ok(result??);
            }
            _ = shutdown_signal() => {}
        }
        self.shutdown().await;
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
    {
        let terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate());
        match terminate {
            Ok(mut terminate) => tokio::select! {
                result = tokio::signal::ctrl_c() => { if let Err(error) = result { eprintln!("jet: signal: {error}"); } }
                _ = terminate.recv() => {}
            },
            Err(error) => {
                eprintln!("jet: termination signal: {error}");
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
    #[cfg(not(unix))]
    if let Err(error) = tokio::signal::ctrl_c().await {
        eprintln!("jet: signal: {error}");
    }
}
