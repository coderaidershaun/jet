//! Open the host, serve its routes and shut it down. It joins the jobs of the crate: chat, apps,
//! files, voice and the tool facade.

mod config;
mod routes;

use crate::apps::{Apps, Proxy};
use crate::chat::TurnTools;
use crate::facade::Facade;
use crate::files::Files;
use crate::lock;
use crate::voice::Voice;
use agent::{apps::Registry, mcp::HttpMcpClient};
use axum::{Router, extract::FromRef};
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
    #[error("server task failed: {0}")]
    Task(#[from] tokio::task::JoinError),
}

#[derive(Clone)]
pub struct Server {
    chat: Arc<ChatState>,
    apps: Apps,
    facade: Arc<Facade>,
    files: Files,
    voice: Voice,
    config: ServerConfig,
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

impl FromRef<Server> for Voice {
    fn from_ref(server: &Server) -> Self {
        server.voice.clone()
    }
}

impl Server {
    pub fn open(config: ServerConfig) -> Result<Self, ServerError> {
        let proxy = Proxy::new(config.public_origin.as_deref(), config.listen)
            .map_err(|error| ServerError::Config(error.to_string()))?;
        let registry = Arc::new(Mutex::new(Registry::open(&config.data_dir)?));
        let mcp = Arc::new(HttpMcpClient::new(registry.clone()));
        let files = Files::new(&config.data_dir);
        let facade = Facade::new(
            registry.clone(),
            mcp.clone(),
            files.clone(),
            format!("http://{}/mcp", config.listen),
            config.public_origin.clone(),
        );
        let chat = ChatState::open(config.data_dir.clone(), facade.clone(), files.clone())?;
        *lock(&facade.chat) = Arc::downgrade(&chat);
        let events = lock(&registry).subscribe();
        let weak = Arc::downgrade(&chat);
        std::thread::spawn(move || {
            loop {
                let Some(chat) = weak.upgrade() else { break };
                if chat.is_closing() {
                    break;
                }
                match events.recv_timeout(Duration::from_millis(200)) {
                    Ok(event) => chat.registry_changed(event),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            chat,
            apps: Apps::new(registry, mcp, proxy),
            facade,
            files,
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
        let chat = self.chat.clone();
        if let Err(error) = tokio::task::spawn_blocking(move || chat.shutdown()).await {
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
            axum::serve(listener, router)
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
