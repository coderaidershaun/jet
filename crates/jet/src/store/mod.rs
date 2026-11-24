//! The one SQLite database of the data directory. Every SQL statement of the server lives in this
//! module: each table module adds typed calls to `Store`, and each migration adds its tables.

mod directory;
mod github_tokens;
mod signins;

pub(crate) use directory::{Email, NewUser, User, UserId};
pub(crate) use signins::{Rotation, SigninId};

use crate::lock;
use rusqlite::Connection;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const FILE: &str = "jet.sqlite3";

/// The schema, one entry per version. A new table gets a new file at the end; a migration that
/// has shipped never changes, because databases in the field have already run it.
const MIGRATIONS: &[&str] = &[
    include_str!("migrations/0001_directory.sql"),
    include_str!("migrations/0002_signins.sql"),
    include_str!("migrations/0003_github_tokens.sql"),
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
