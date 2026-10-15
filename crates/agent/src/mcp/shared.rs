//! Keeps one copy of each enabled library's MCP server running for the whole app session,
//! and tells the callers where each one listens.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::Value;

use super::McpError;
use super::client::McpClient;
use super::keeper::{FirstOutcome, Keeper, Launch};
use super::process::free_port;
use crate::chat::{McpServer, McpServers};

const SWITCHED_OFF: &str = "it is switched off in Settings";
const WITHOUT_HTTP: &str = "its program stopped at once when started with --http";
const UNSTARTABLE: &str = "its program could not be started";
const NO_PORT: &str = "this machine has no free port for it";
const CLOSING: &str = "the app is closing";
const NOT_STARTED: &str = "it has not been started yet";

/// One copy of each enabled library's server for the whole app session, each listening on
/// a port of its own on this machine. Claude's replies and the page's calls reach the same
/// copy, so what one starts (an engine, an import) is seen by the other and outlives a reply.
///
/// A library whose program does not take `--http <port>` and print `listening on <url>` on
/// its error output is not shared: Claude Code starts its own copy for each reply.
// SMELL: a polysim-mcp that crashes leaves its engines running, and the next copy cannot
// see them. When Jet itself ends, polysim does stop its engines, because the input Jet
// holds open for it closes.
#[derive(Clone, Default)]
pub struct SharedServers {
    hosted: Arc<Mutex<Hosted>>,
}

#[derive(Default)]
struct Hosted {
    running: BTreeMap<&'static str, Running>,
    /// Why a library is not shared, by name.
    skipped: BTreeMap<&'static str, &'static str>,
}

struct Running {
    /// The settings the copy was started with.
    server: McpServer,
    url: String,
    client: Arc<McpClient>,
    keeper: Keeper,
}

impl SharedServers {
    /// Nothing runs yet; `configure` starts the servers the settings ask for.
    pub fn new() -> SharedServers {
        SharedServers::default()
    }

    /// Brings the running copies in line with the settings: a copy whose settings did not
    /// change is left alone; one that changed or was switched off is stopped; a new or
    /// changed one is started. It returns once every enabled server has said it is ready,
    /// has exited, or has stayed up for two seconds, so which libraries are shared is
    /// decided before the next reply.
    ///
    /// Copies that go are stopped, all at once, before any new one starts, so two copies
    /// of one library never run side by side. Callers of `urls` and `call` wait meanwhile:
    /// at most 27 seconds, and only when a running copy has to stop, which takes long only
    /// for a polysim with running engines.
    // SMELL: the port is chosen once, so if another program takes it before the server
    // binds, the library is not shared until the next reload.
    pub fn configure(&self, servers: &McpServers) {
        let mut hosted = lock(&self.hosted);
        let mut leaving = Vec::new();
        let mut arriving = Vec::new();
        for (name, server) in servers.named() {
            let unchanged = hosted
                .running
                .get(name)
                .is_some_and(|run| run.server == *server);
            if server.enabled && unchanged {
                continue;
            }
            leaving.extend(hosted.running.remove(name));
            if server.enabled {
                arriving.push((name, server));
            } else {
                hosted.skipped.insert(name, SWITCHED_OFF);
            }
        }
        stop_all(leaving);
        // Every port is found before any program starts: a program started at the same
        // moment can inherit the socket that found a port, and then the server cannot bind it.
        let ports: Vec<_> = arriving.iter().map(|(name, _)| port_for(name)).collect();
        let started: Vec<_> = arriving
            .into_iter()
            .zip(ports)
            .map(|((name, server), port)| (name, port.map(|port| start(name, server, port))))
            .collect();
        for (name, started) in started {
            match started.and_then(judge) {
                Ok(run) => {
                    hosted.skipped.remove(name);
                    hosted.running.insert(name, run);
                }
                Err(reason) => {
                    hosted.skipped.insert(name, reason);
                }
            }
        }
    }

    /// The address of each shared server, by library name.
    pub fn urls(&self) -> BTreeMap<String, String> {
        let hosted = lock(&self.hosted);
        hosted
            .running
            .iter()
            .map(|(name, run)| ((*name).to_owned(), run.url.clone()))
            .collect()
    }

    /// Calls a tool of a library's shared server and returns its structured result, else
    /// its text as JSON, else the text.
    ///
    /// # Errors
    /// - [`McpError::NotShared`] when Jet keeps no copy of the library running.
    /// - [`McpError::UnknownServer`] when there is no library of that name.
    /// - [`McpError::Unreachable`] when the server did not answer.
    /// - [`McpError::Status`], [`McpError::BadJson`] and [`McpError::NoResponse`] when its
    ///   reply was not what MCP says.
    /// - [`McpError::Rpc`] when the server refused the request itself.
    /// - [`McpError::Tool`] when the tool ran and reported a failure.
    pub fn call(&self, server: &str, tool: &str, arguments: Value) -> Result<Value, McpError> {
        let client = {
            let hosted = lock(&self.hosted);
            match hosted.running.get(server) {
                Some(run) => Arc::clone(&run.client),
                None => return Err(not_running(&hosted, server)),
            }
        };
        client.call(tool, arguments)
    }

    /// Stops every server and waits for them to go: polysim's input is closed and SIGTERM
    /// sent first, so it can stop its engines, and a kill only after 25 seconds.
    // SMELL: closing the app waits up to 25 seconds while polysim stops its engines.
    pub fn shutdown(&self) {
        let running = {
            let mut hosted = lock(&self.hosted);
            let running = std::mem::take(&mut hosted.running);
            for name in running.keys() {
                hosted.skipped.insert(name, CLOSING);
            }
            running
        };
        stop_all(running.into_values().collect());
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn not_running(hosted: &Hosted, server: &str) -> McpError {
    let known = McpServers::default()
        .named()
        .any(|(name, _)| name == server);
    if !known {
        return McpError::UnknownServer {
            server: server.to_owned(),
        };
    }
    McpError::NotShared {
        server: server.to_owned(),
        reason: hosted.skipped.get(server).copied().unwrap_or(NOT_STARTED),
    }
}

/// Stops the copies all at once and returns when every one has gone.
fn stop_all(copies: Vec<Running>) {
    std::thread::scope(|scope| {
        for run in copies {
            scope.spawn(move || run.keeper.stop());
        }
    });
}

/// A port of its own for a library, or why it cannot be shared.
fn port_for(name: &str) -> Result<u16, &'static str> {
    free_port().map_err(|error| {
        eprintln!("jet: no free port for {name}: {error}");
        NO_PORT
    })
}

/// Starts a copy on its port. It has not yet said whether it works.
fn start(name: &'static str, server: &McpServer, port: u16) -> Running {
    let url = format!("http://127.0.0.1:{port}/mcp");
    let client = Arc::new(McpClient::new(name, url.clone()));
    let launch = Launch {
        name,
        server: server.clone(),
        port,
        url: url.clone(),
        client: Arc::clone(&client),
    };
    Running {
        server: server.clone(),
        url,
        client,
        keeper: Keeper::start(launch),
    }
}

/// Waits for the copy's first outcome. A copy that works is returned; any other is stopped
/// and the reason it cannot be shared is returned.
fn judge(run: Running) -> Result<Running, &'static str> {
    let reason = match run.keeper.first_outcome() {
        FirstOutcome::Ready | FirstOutcome::Alive => return Ok(run),
        FirstOutcome::Refused => WITHOUT_HTTP,
        FirstOutcome::Unstartable => UNSTARTABLE,
    };
    run.keeper.stop();
    Err(reason)
}
