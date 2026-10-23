//! Share one host state between browser commands, event streams and app integrations.

mod config;
mod routes;

use agent::apps::Registry;
use axum::Router;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use crate::chat::{BridgeError, ChatState};
pub use config::ServerConfig;

#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    #[error("invalid server configuration: {0}")]
    Config(String),
    #[error(transparent)]
    Registry(#[from] agent::apps::RegistryError),
    #[error(transparent)]
    Chat(#[from] BridgeError),
    #[error("server network operation failed: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Clone)]
pub struct Server {
    pub(crate) chat: Arc<ChatState>,
    pub(crate) proxy: crate::proxy::Proxy,
    pub registry: Arc<Mutex<Registry>>,
    pub config: ServerConfig,
}

impl Server {
    pub fn open(config: ServerConfig) -> Result<Self, ServerError> {
        let proxy = crate::proxy::Proxy::new(&config)?;
        let registry = Registry::open(&config.data_dir)?;
        let chat = ChatState::open(config.data_dir.clone())?;
        Ok(Self {
            chat,
            proxy,
            registry: Arc::new(Mutex::new(registry)),
            config,
        })
    }

    pub fn router(&self) -> Router {
        routes::router(self.clone())
    }

    /// Stops provider work and closes event streams within a fixed cleanup deadline.
    pub async fn shutdown(&self) {
        let chat = self.chat.clone();
        if let Err(error) = tokio::task::spawn_blocking(move || chat.shutdown()).await {
            eprintln!("jet: shutdown worker failed: {error}");
        }
    }

    pub async fn serve(self, listener: tokio::net::TcpListener) -> Result<(), ServerError> {
        let router = self.router();
        let (finish, finished) = tokio::sync::oneshot::channel::<()>();
        let mut running = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = finished.await;
                })
                .await
        });
        tokio::select! {
            result = &mut running => {
                return result.map_err(|error| ServerError::Config(format!("server task failed: {error}")))?.map_err(ServerError::Io);
            }
            _ = shutdown_signal() => {}
        }
        self.shutdown().await;
        if finish.send(()).is_err() {
            eprintln!("jet: server already stopped");
        }
        match tokio::time::timeout(Duration::from_secs(2), &mut running).await {
            Ok(result) => result
                .map_err(|error| ServerError::Config(format!("server task failed: {error}")))?
                .map_err(ServerError::Io),
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
