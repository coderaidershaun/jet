//! Restore to factory defaults: the route an admin asks through, and the delete of everything
//! below the data folder and of the folders Jet made for agy turns. The loop that serves the host
//! stops it and opens a new one.

use super::{Server, ServerConfig};
use crate::{account::SignedIn, chat::BridgeError, on_worker};
use agent::voice::{Phonon, Phonon2};
use axum::{Extension, Json, Router, extract::State, routing::post};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use tokio::sync::{mpsc, oneshot};

/// The word an admin types to confirm. The server checks it, so a call that skips the page's
/// question is refused too.
const WORD: &str = "RESET";

/// Where the loop that serves the host sends the outcome of the reset a route asked for.
pub(super) type Answer = oneshot::Sender<Result<(), ResetError>>;

#[derive(Debug, thiserror::Error)]
pub(super) enum ResetError {
    #[error("only an admin may restore the server to factory defaults")]
    NotAdmin,
    #[error("type {WORD} to confirm; nothing was deleted")]
    NotConfirmed,
    #[error(
        "the data folder {data} holds {inside}, which a reset must not delete; nothing was deleted"
    )]
    Holds { data: PathBuf, inside: PathBuf },
    #[error(
        "this host has no password for the demo accounts (JET_SEED_PASSWORD is not set), so nobody could sign in after a reset; nothing was deleted"
    )]
    NoAccounts,
    #[error("failed to read the data folder {path}; nothing was deleted")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to list all of the folder {path}, so what was not listed is still there")]
    Unlisted {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to remove {path}; everything else was reset")]
    Left {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("the host stopped, or another request reset it, before it answered this reset")]
    NoAnswer,
}

impl From<ResetError> for BridgeError {
    fn from(error: ResetError) -> Self {
        let message = error.to_string();
        match error {
            ResetError::NotAdmin => Self::AdminOnly(message),
            ResetError::NotConfirmed | ResetError::Holds { .. } | ResetError::NoAccounts => {
                Self::InvalidRequest(message)
            }
            ResetError::Read { source, .. }
            | ResetError::Unlisted { source, .. }
            | ResetError::Left { source, .. } => Self::Io(format!("{message}: {source}")),
            ResetError::NoAnswer => Self::Io(message),
        }
    }
}

pub(super) fn router(asks: mpsc::Sender<Answer>) -> Router<Server> {
    Router::new()
        .route("/api/factory-reset", post(restore))
        .layer(Extension(asks))
}

#[derive(Deserialize)]
struct Confirm {
    #[serde(default)]
    confirm: String,
}

/// Asks the serving loop for the reset and waits for its outcome. The loop does the work, so a
/// browser that goes away cannot stop a reset halfway.
async fn restore(
    State(host): State<Server>,
    Extension(asks): Extension<mpsc::Sender<Answer>>,
    signed_in: SignedIn,
    Json(body): Json<Confirm>,
) -> Result<Json<Value>, BridgeError> {
    if !signed_in.user.is_admin {
        return Err(ResetError::NotAdmin.into());
    }
    if body.confirm != WORD {
        return Err(ResetError::NotConfirmed.into());
    }
    // A host that would seed no account must keep the ones it has: the page cannot undo a server
    // that nobody can sign in to.
    if !host.accounts.seeds_a_new_install() {
        return Err(ResetError::NoAccounts.into());
    }
    on_worker(move || data_folder(&host.config)).await??;
    let (answer, outcome) = oneshot::channel();
    let no_answer = || BridgeError::from(ResetError::NoAnswer);
    asks.send(answer).await.map_err(|_| no_answer())?;
    outcome.await.map_err(|_| no_answer())??;
    Ok(Json(json!({})))
}

/// The data folder by its real path. It is refused when it holds something a reset must never
/// delete: the folder Jet runs in, its program, its pages or a speech model.
fn data_folder(config: &ServerConfig) -> Result<PathBuf, ResetError> {
    let data = config
        .data_dir
        .canonicalize()
        .map_err(|source| ResetError::Read {
            path: config.data_dir.clone(),
            source,
        })?;
    let never_deleted = [
        std::env::current_dir().ok(),
        std::env::current_exe().ok(),
        Some(config.ui_dir.clone()),
        Some(PathBuf::from("models")),
        Some(Phonon2::model()),
        Some(Phonon::model()),
    ];
    for path in never_deleted.into_iter().flatten() {
        // A path that is not there has no real path, and cannot be deleted.
        if let Ok(inside) = path.canonicalize()
            && inside.starts_with(&data)
        {
            return Err(ResetError::Holds { data, inside });
        }
    }
    Ok(data)
}

/// Deletes everything below the data folder, and the folders Jet made in the system's temporary
/// folder for the agy turns of this data folder's chats, and nothing else. Each path is a checked
/// folder joined with a name read from that folder, and a link is removed as a link, never
/// followed, so nothing outside is touched. What cannot be listed or removed is logged, the rest
/// still goes, and the first failure is the answer.
pub(super) fn wipe(config: &ServerConfig) -> Result<(), ResetError> {
    let data = data_folder(config)?;
    let mut failures = Vec::new();
    for path in listed(&data, &mut failures) {
        let removed = match std::fs::symlink_metadata(&path) {
            Ok(found) if found.is_dir() => std::fs::remove_dir_all(&path),
            Ok(_) => std::fs::remove_file(&path),
            Err(error) => Err(error),
        };
        if let Err(source) = removed {
            failures.push(ResetError::Left { path, source });
        }
    }
    let agy_folder = agy_folder_name(&data);
    for path in listed(&std::env::temp_dir(), &mut failures) {
        if is_agy_folder(&agy_folder, &path)
            && let Err(source) = std::fs::remove_dir_all(&path)
        {
            failures.push(ResetError::Left { path, source });
        }
    }
    for failure in &failures {
        let cause = std::error::Error::source(failure).map(ToString::to_string);
        eprintln!("jet: the reset: {failure}: {}", cause.unwrap_or_default());
    }
    failures.into_iter().next().map_or(Ok(()), Err)
}

/// The path of each entry of the folder. An entry that cannot be listed is a failure, and the
/// entries after it are still given.
fn listed(folder: &Path, failures: &mut Vec<ResetError>) -> Vec<PathBuf> {
    let unlisted = |source| ResetError::Unlisted {
        path: folder.to_owned(),
        source,
    };
    let entries = match std::fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(source) => {
            failures.push(unlisted(source));
            return Vec::new();
        }
    };
    let mut paths = Vec::new();
    for entry in entries {
        match entry {
            Ok(entry) => paths.push(folder.join(entry.file_name())),
            Err(source) => failures.push(unlisted(source)),
        }
    }
    paths
}

/// The name of the folder an agy turn of this data folder's chats runs in, up to the chat's
/// number. Each such folder holds the instructions and notes of its user. The name must stay the
/// one the agy provider gives its folders; the reset test fails when the two differ.
fn agy_folder_name(data: &Path) -> String {
    // FNV-1a over the real path of the data folder.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in data.as_os_str().as_encoded_bytes() {
        hash = (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3);
    }
    format!("jet-agy-{hash:016x}-chat-")
}

/// Whether the path is such a folder: named for this data folder and a chat's number, and a real
/// folder, not a link.
fn is_agy_folder(name: &str, path: &Path) -> bool {
    let chat = path
        .file_name()
        .and_then(|found| found.to_str())
        .and_then(|found| found.strip_prefix(name));
    chat.is_some_and(|chat| !chat.is_empty() && chat.bytes().all(|byte| byte.is_ascii_digit()))
        && std::fs::symlink_metadata(path).is_ok_and(|found| found.is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_data_folder_that_holds_the_pages_is_refused_and_one_beside_them_is_taken() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let (inside, beside) = (data.join("ui"), dir.path().join("ui"));
        for ui in [&inside, &beside] {
            std::fs::create_dir_all(ui).unwrap();
            std::fs::write(ui.join("index.html"), "").unwrap();
        }
        let config = |ui: &Path| {
            let text = |path: &Path| path.display().to_string();
            let args = [
                "--data-dir".to_owned(),
                text(&data),
                "--ui-dir".to_owned(),
                text(ui),
            ];
            ServerConfig::from_args(args).unwrap()
        };
        let real = |path: &Path| path.canonicalize().unwrap();

        let refused = data_folder(&config(&inside));
        assert!(
            matches!(&refused, Err(ResetError::Holds { inside: held, .. }) if *held == real(&inside)),
            "{refused:?}"
        );
        assert_eq!(data_folder(&config(&beside)).unwrap(), real(&data));
    }
}
