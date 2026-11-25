//! Copies what an older Jet kept as files in the data directory into the account of the
//! deployment's owner, once. The old files are only read: never moved, changed or deleted. This is
//! the only code that knows their names.

use super::{Email, Store, StoreError, UserId, to_json};
use crate::files::{About, FileKind, Origin};
use crate::settings::{ProgramPaths, Settings};
use agent::{Entry, Notes, Session, apps::App};
use rusqlite::{Transaction, params};
use serde::Deserialize;
use std::path::{Path, PathBuf};

const TRANSCRIPT: &str = "transcript.jsonl";
const SESSION: &str = "session.json";
const MEMORY: &str = "MEMORY.md";
const USER: &str = "USER.md";
const RECENT: &str = "RECENT.md";
const SETTINGS: &str = "settings.json";
const APPS: &str = "apps.json";
const FILES: &str = "files";
const FILE_DETAILS: &str = ".about.json";

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("could not read {path} of the older Jet")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("{path} of the older Jet is not valid at line {line}")]
    Json {
        path: PathBuf,
        line: usize,
        #[source]
        source: serde_json::Error,
    },
    #[error("{path} has registry version {version}; only version 1 can be copied")]
    AppsVersion { path: PathBuf, version: u64 },
    #[error(
        "the older Jet's files are in {dir}, but there is no account {owner} to copy them into"
    )]
    NoOwner { dir: PathBuf, owner: String },
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// What the older Jet left in the data directory. Each part is `None` when its file is absent.
#[derive(Default)]
struct Legacy {
    entries: Option<Vec<Entry>>,
    session: Option<Session>,
    notes: Option<Notes>,
    settings: Option<(Settings, ProgramPaths)>,
    apps: Option<Vec<App>>,
    files: Vec<(About, Vec<u8>)>,
}

impl Legacy {
    fn is_empty(&self) -> bool {
        self.entries.is_none()
            && self.session.is_none()
            && self.notes.is_none()
            && self.settings.is_none()
            && self.apps.is_none()
            && self.files.is_empty()
    }
}

impl Store {
    /// At the first start on a data directory, copies the older Jet's files into `owner`'s account
    /// and records in the same transaction that the import ran, so a later start copies nothing.
    /// Gives whether anything was copied.
    pub(crate) fn import_legacy(&self, dir: &Path, owner: &Email) -> Result<bool, ImportError> {
        if self.legacy_import_ran()? {
            return Ok(false);
        }
        let legacy = read(dir)?;
        let owner_id = self.user_id(owner)?;
        let owner_id = match owner_id {
            Some(id) => Some(id),
            None if legacy.is_empty() => None,
            None => {
                return Err(ImportError::NoOwner {
                    dir: dir.to_owned(),
                    owner: owner.as_str().to_owned(),
                });
            }
        };
        let copied = !legacy.is_empty();
        self.try_with(|db| {
            let transaction = db.transaction()?;
            if let Some(owner) = owner_id {
                write(&transaction, owner, legacy)?;
            }
            transaction.execute(
                "INSERT INTO legacy_import (id, user_id, imported_at) VALUES (1, ?1, unixepoch())",
                [owner_id.map(|id| id.0)],
            )?;
            transaction.commit()?;
            Ok(())
        })?;
        Ok(copied)
    }

    fn legacy_import_ran(&self) -> Result<bool, StoreError> {
        self.with(|db| {
            db.query_row("SELECT count(*) FROM legacy_import", [], |row| {
                row.get::<_, i64>(0)
            })
        })
        .map(|count| count > 0)
    }
}

fn write(transaction: &Transaction, owner: UserId, legacy: Legacy) -> Result<(), StoreError> {
    let chat: i64 = transaction.query_row(
        "SELECT id FROM chats WHERE user_id = ?1 AND kind = 'main'",
        [owner.0],
        |row| row.get(0),
    )?;
    for entry in legacy.entries.unwrap_or_default() {
        transaction.execute(
            "INSERT INTO entries (chat_id, id, entry) VALUES (?1, ?2, ?3)",
            params![chat, entry.id.number() as i64, to_json(&entry)?],
        )?;
    }
    if let Some(session) = &legacy.session {
        transaction.execute(
            "UPDATE chats SET session = ?2 WHERE id = ?1",
            params![chat, to_json(session)?],
        )?;
    }
    if let Some(notes) = &legacy.notes {
        transaction.execute(
            "INSERT INTO notes (user_id, memory, about_user, recent) VALUES (?1, ?2, ?3, ?4)",
            params![owner.0, notes.memory, notes.user, notes.recent],
        )?;
    }
    if let Some((settings, paths)) = &legacy.settings {
        transaction.execute(
            "INSERT INTO settings (user_id, settings) VALUES (?1, ?2)",
            params![owner.0, to_json(settings)?],
        )?;
        let text = |path: &Option<PathBuf>| {
            path.as_ref()
                .map(|path| path.to_string_lossy().into_owned())
        };
        transaction.execute(
            "INSERT INTO server_settings (id, claude_path, codex_path, agy_path)
             VALUES (1, ?1, ?2, ?3)",
            params![
                text(&paths.claude_path),
                text(&paths.codex_path),
                text(&paths.agy_path)
            ],
        )?;
    }
    for app in legacy.apps.unwrap_or_default() {
        transaction.execute(
            "INSERT INTO apps (id, user_id, app) VALUES (?1, ?2, ?3)",
            params![app.id.to_string(), owner.0, to_json(&app)?],
        )?;
    }
    for (about, contents) in legacy.files {
        transaction.execute(
            "INSERT INTO files (id, user_id, at, attached, about, contents, chat_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                about.id.to_string(),
                owner.0,
                about.at as i64,
                about.attached,
                to_json(&about)?,
                contents,
                chat
            ],
        )?;
    }
    Ok(())
}

fn read(dir: &Path) -> Result<Legacy, ImportError> {
    let notes = [MEMORY, USER, RECENT].map(|name| read_text(&dir.join(name)));
    let [memory, user, recent] = notes;
    let (memory, user, recent) = (memory?, user?, recent?);
    let notes = (memory.is_some() || user.is_some() || recent.is_some()).then(|| {
        Notes {
            memory: memory.unwrap_or_default(),
            user: user.unwrap_or_default(),
            recent: recent.unwrap_or_default(),
        }
        .trimmed()
    });
    Ok(Legacy {
        entries: read_text(&dir.join(TRANSCRIPT))?
            .map(|text| transcript(&text, &dir.join(TRANSCRIPT)))
            .transpose()?,
        session: read_json(&dir.join(SESSION))?,
        notes,
        settings: read_json::<OldSettings>(&dir.join(SETTINGS))?
            .map(|old| (old.settings, old.paths)),
        apps: read_json::<OldApps>(&dir.join(APPS))?
            .map(|old| old.apps(&dir.join(APPS)))
            .transpose()?,
        files: files(&dir.join(FILES))?,
    })
}

/// The settings file held the provider programs too; they are now the server's.
#[derive(Deserialize)]
struct OldSettings {
    #[serde(flatten)]
    settings: Settings,
    #[serde(flatten)]
    paths: ProgramPaths,
}

#[derive(Deserialize)]
struct OldApps {
    #[serde(default)]
    version: u64,
    #[serde(default)]
    apps: Vec<App>,
}

impl OldApps {
    fn apps(self, path: &Path) -> Result<Vec<App>, ImportError> {
        if self.version != 1 {
            return Err(ImportError::AppsVersion {
                path: path.to_owned(),
                version: self.version,
            });
        }
        Ok(self.apps)
    }
}

/// One entry per line. A torn last line, left by a crash, is skipped; a bad line anywhere else is
/// an error, not a silent gap.
fn transcript(text: &str, path: &Path) -> Result<Vec<Entry>, ImportError> {
    let lines: Vec<(usize, &str)> = text
        .lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .collect();
    let mut entries = Vec::with_capacity(lines.len());
    for (position, (index, line)) in lines.iter().enumerate() {
        match serde_json::from_str::<Entry>(line) {
            Ok(entry) => entries.push(entry),
            Err(_) if position + 1 == lines.len() && !text.ends_with('\n') => {}
            Err(source) => {
                return Err(ImportError::Json {
                    path: path.to_owned(),
                    line: index + 1,
                    source,
                });
            }
        }
    }
    Ok(entries)
}

/// Each file sat alone in a folder named by its id, with its details beside it when it was an
/// upload. Folders still being written end in `.part` and are left out.
fn files(root: &Path) -> Result<Vec<(About, Vec<u8>)>, ImportError> {
    let Some(folders) = read_folder(root)? else {
        return Ok(Vec::new());
    };
    let mut files = Vec::new();
    for folder in folders {
        let folder_name = folder
            .file_name()
            .map(|name| name.to_string_lossy().into_owned());
        let Ok(id) = uuid::Uuid::try_parse(&folder_name.unwrap_or_default()) else {
            continue;
        };
        let Some(names) = read_folder(&folder)? else {
            continue;
        };
        let Some(path) = names.into_iter().find(|path| {
            !path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with('.'))
        }) else {
            continue;
        };
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let Some(kind) = FileKind::of_name(&name) else {
            continue;
        };
        let contents = std::fs::read(&path).map_err(|source| ImportError::Read {
            path: path.clone(),
            source,
        })?;
        let about = match read_json::<About>(&folder.join(FILE_DETAILS))? {
            Some(about) => about,
            None => About {
                id,
                ..About::new(name, kind, &contents, Origin::Export, modified_ms(&path))
            },
        };
        files.push((about, contents));
    }
    Ok(files)
}

fn read_folder(path: &Path) -> Result<Option<Vec<PathBuf>>, ImportError> {
    match std::fs::read_dir(path) {
        Ok(entries) => Ok(Some(entries.flatten().map(|entry| entry.path()).collect())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(ImportError::Read {
            path: path.to_owned(),
            source,
        }),
    }
}

fn modified_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |since| u64::try_from(since.as_millis()).unwrap_or(0))
}

fn read_text(path: &Path) -> Result<Option<String>, ImportError> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(ImportError::Read {
            path: path.to_owned(),
            source,
        }),
    }
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>, ImportError> {
    let Some(text) = read_text(path)? else {
        return Ok(None);
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|source| ImportError::Json {
            path: path.to_owned(),
            line: source.line(),
            source,
        })
}
