//! The one SQLite database of the data directory. Every SQL statement of the server lives in this
//! module: each table module adds typed calls to `Store`, and each migration adds its tables.

mod apps;
mod chats;
mod directory;
mod files;
mod github_tokens;
mod import;
mod notes;
mod objectives;
mod settings;
mod shares;
mod signins;
mod sources;
mod steps;
mod tasks;
mod text_enum;
mod update_notes;

pub(crate) use chats::{Chat, ChatId, ChatKind, ChatSummary};
pub(crate) use directory::{Email, NewUser, Person, Team, User, UserId};
pub(crate) use files::Added;
pub use import::ImportError;
pub(crate) use objectives::{
    Edit, NewObjective, Objective, ObjectiveChat, ObjectiveId, ObjectiveStatus,
};
pub(crate) use shares::{Applied, ProposalId, ShareCard, Shared, Sharing, Tapped};
pub(crate) use signins::{Rotation, SigninId};
pub(crate) use sources::{NewSource, Source, SourceKind};
pub(crate) use steps::{NewStep, Step, StepId};
pub(crate) use tasks::{
    AgentTask, CancelOutcome, NewTask, Run, Scheduled, SetBy, TaskId, TaskKind, TaskState,
};
#[cfg(test)]
pub(crate) use tasks::{Finished, RunOutcome};
pub(crate) use update_notes::{NewNote, Note, NoteStatus};

use crate::lock;
use rusqlite::Connection;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const FILE: &str = "jet.sqlite3";

/// A store in a temporary directory with two users, for tests.
#[cfg(test)]
pub(crate) fn test_store() -> (tempfile::TempDir, Store, UserId, UserId) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let add = |email: &str| {
        let id = store
            .add_user(&NewUser {
                email: &Email::from(email),
                display_name: email,
                password_hash: "not a real hash",
                is_admin: false,
            })
            .unwrap();
        store.set_time_zone(id, "Europe/London").unwrap();
        id
    };
    let (ada, bob) = (add("ada@example.com"), add("bob@example.com"));
    (dir, store, ada, bob)
}

/// The schema, one entry per version. A new table gets a new file at the end; a migration that
/// has shipped never changes, because databases in the field have already run it.
const MIGRATIONS: &[&str] = &[
    include_str!("migrations/0001_directory.sql"),
    include_str!("migrations/0002_signins.sql"),
    include_str!("migrations/0003_github_tokens.sql"),
    include_str!("migrations/0004_personal_jet.sql"),
    include_str!("migrations/0005_objectives.sql"),
    include_str!("migrations/0006_agy_path.sql"),
    include_str!("migrations/0007_many_chats.sql"),
    include_str!("migrations/0008_shares.sql"),
];

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("failed to make the data directory {path}")]
    Directory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to open the database {path}")]
    Open {
        path: PathBuf,
        #[source]
        source: rusqlite::Error,
    },
    #[error("failed to apply database migration {version}")]
    Migrate {
        version: usize,
        #[source]
        source: rusqlite::Error,
    },
    #[error("the database is at version {found}, newer than this program's {known}")]
    TooNew { found: usize, known: usize },
    #[error("database query failed")]
    Query(#[from] rusqlite::Error),
    #[error("the objective already has an open check; move it instead of adding another")]
    DuplicateCheck,
    #[error("this chat already belongs to an objective")]
    ChatTaken,
    #[error("the main chat cannot be deleted")]
    MainChat,
    #[error("no such chat")]
    NoSuchChat,
    #[error("{what} in the database is not valid JSON of its kind")]
    Json {
        what: &'static str,
        #[source]
        source: serde_json::Error,
    },
}

impl StoreError {
    /// True when another connection held the database for longer than the busy timeout.
    pub(crate) fn is_busy(&self) -> bool {
        matches!(self, Self::Query(rusqlite::Error::SqliteFailure(failure, _))
            if failure.code == rusqlite::ErrorCode::DatabaseBusy)
    }
}

#[derive(Clone)]
pub(crate) struct Store {
    connection: Arc<Mutex<Connection>>,
}

impl Store {
    /// Opens the database in `data_dir`, making it on first use, and brings its schema up to date.
    pub(crate) fn open(data_dir: &Path) -> Result<Self, StoreError> {
        std::fs::create_dir_all(data_dir).map_err(|source| StoreError::Directory {
            path: data_dir.to_owned(),
            source,
        })?;
        let path = data_dir.join(FILE);
        let open = |source| StoreError::Open {
            path: path.clone(),
            source,
        };
        let mut connection = Connection::open(&path).map_err(open)?;
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
            )
            .map_err(open)?;
        migrate(&mut connection)?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    fn with<T>(
        &self,
        call: impl FnOnce(&mut Connection) -> rusqlite::Result<T>,
    ) -> Result<T, StoreError> {
        Ok(call(&mut lock(&self.connection))?)
    }

    /// Like `with`, for a call that can also fail with a store error of its own.
    fn try_with<T>(
        &self,
        call: impl FnOnce(&mut Connection) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        call(&mut lock(&self.connection))
    }
}

fn to_json(value: &impl serde::Serialize) -> Result<String, StoreError> {
    serde_json::to_string(value).map_err(|source| StoreError::Json {
        what: "a value",
        source,
    })
}

fn from_json<T: serde::de::DeserializeOwned>(
    what: &'static str,
    text: &str,
) -> Result<T, StoreError> {
    serde_json::from_str(text).map_err(|source| StoreError::Json { what, source })
}

/// A time in seconds since 1970 as SQLite stores it.
fn seconds(time: u64) -> i64 {
    i64::try_from(time).unwrap_or(i64::MAX)
}

fn migrate(connection: &mut Connection) -> Result<(), StoreError> {
    let found: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let found = usize::try_from(found).unwrap_or(usize::MAX);
    if found > MIGRATIONS.len() {
        return Err(StoreError::TooNew {
            found,
            known: MIGRATIONS.len(),
        });
    }
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(found) {
        let version = index + 1;
        apply(connection, sql, version)
            .map_err(|source| StoreError::Migrate { version, source })?;
    }
    Ok(())
}

/// Runs one migration and records its version in the same transaction, so a migration that fails
/// halfway leaves no trace.
fn apply(connection: &mut Connection, sql: &str, version: usize) -> rusqlite::Result<()> {
    let transaction = connection.transaction()?;
    transaction.execute_batch(sql)?;
    transaction.pragma_update(None, "user_version", version as i64)?;
    transaction.commit()
}
