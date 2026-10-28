//! Keeps the files of a conversation, one folder for each, under the data directory until the
//! user forgets it: the files Jet writes for the user to download, and the files the user
//! attaches to a message.

mod about;
mod export;
mod kind;
mod read;
mod sandbox;
mod upload;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use uuid::Uuid;

pub(crate) use about::{About, Origin};
pub(crate) use export::ExportRequest;
pub(crate) use kind::FileKind;
pub(crate) use read::{Range, Reading};
use sandbox::Sandbox;
pub use sandbox::{READ_FILE_ARGUMENT, run_file_reader};
pub(crate) use upload::MAX_FILE_BYTES;

/// The file saved beside an upload that holds its [`About`].
const ABOUT_FILE: &str = ".about.json";
/// The most files `list` returns.
const LIST_LIMIT: usize = 200;

/// A saved file, read back to be sent to the browser.
#[derive(Debug)]
pub(crate) struct OpenedFile {
    pub name: String,
    pub kind: FileKind,
    pub contents: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum FileError {
    #[error("no file with id {0:?}")]
    NotFound(String),
    #[error(transparent)]
    Export(#[from] ::export::ExportError),
    #[error("could not use {}: {source}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not read the details saved in {}: {source}", path.display())]
    Sidecar {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error(
        "“{0}” can't be attached. Jet takes PDF, Markdown, HTML, Excel (.xlsx), CSV, text and images."
    )]
    Unsupported(String),
    #[error("“{0}” is over 32 MB.")]
    TooLarge(String),
    #[error("Jet's file store is full. Forget the conversation to free it.")]
    StoreFull,
    #[error("Jet couldn't read “{0}”.")]
    Unreadable(String),
    #[error("{0}")]
    NoSuchSheet(String),
}

/// The folder `<data>/files/`, holding `<uuid>/<name>` for each file. The name of the download is
/// the name of the file on disk, so nothing else has to be stored. An upload also has a
/// `.about.json` beside it.
// SMELL: files are kept until Forget, and an upload that was never sent stays too, as does the
// `.part` folder of an upload the server was stopped in the middle of. The store is held to 2 GiB
// in all, so a visitor can fill it with unsent uploads until Forget is pressed.
#[derive(Clone)]
pub(crate) struct Files {
    root: PathBuf,
    sandbox: Sandbox,
    /// Held while the store changes, so two uploads cannot both count the same free space and an
    /// attach cannot race a delete.
    writes: Arc<Mutex<()>>,
}

impl Files {
    pub fn new(data_dir: &Path) -> Files {
        Files {
            root: data_dir.join("files"),
            sandbox: Sandbox::new(),
            writes: Arc::new(Mutex::new(())),
        }
    }

    /// Reads the one file in the folder of `id`. The id must be a UUID, so a path can never get
    /// through it.
    ///
    /// # Errors
    /// - [`FileError::NotFound`] when `id` is not a UUID, or no such file is saved.
    /// - [`FileError::Io`] when a saved file cannot be read.
    pub fn open(&self, id: &str) -> Result<OpenedFile, FileError> {
        let (_, folder) = self.folder(id)?;
        let (name, kind, path) = stored(&folder, id)?;
        let contents = std::fs::read(&path).map_err(|source| read_error(id, &path, source))?;
        Ok(OpenedFile {
            name,
            kind,
            contents,
        })
    }

    /// Marks uploads as sent, so Jet can see them, and gives their details in the same order. Every
    /// id is checked before any is marked, under the one lock, so a bad id or a delete at the same
    /// moment leaves nothing marked. Marking a file twice changes nothing.
    ///
    /// # Errors
    /// - [`FileError::NotFound`] naming the first id that is not a saved upload.
    /// - [`FileError::Sidecar`] or [`FileError::Io`] when the details cannot be read or saved.
    pub fn attach(&self, ids: &[&str]) -> Result<Vec<About>, FileError> {
        let _writing = lock(&self.writes);
        let mut uploads = Vec::with_capacity(ids.len());
        for id in ids {
            let (uuid, folder) = self.folder(id)?;
            let about = about_in(&folder, uuid)?;
            if about.origin != Origin::Upload {
                return Err(FileError::NotFound((*id).to_owned()));
            }
            uploads.push((folder, about));
        }
        uploads
            .into_iter()
            .map(|(folder, mut about)| {
                if !about.attached {
                    about.attached = true;
                    upload::save_about(&folder, &about)?;
                }
                Ok(about)
            })
            .collect()
    }

    /// The id in its usual written form when it names a file Jet can see: one it wrote, or an
    /// upload that was sent. `None` for any other id.
    pub fn visible_id(&self, id: &str) -> Option<Uuid> {
        let (uuid, folder) = self.folder(id).ok()?;
        about_in(&folder, uuid)
            .is_ok_and(|about| about.attached)
            .then_some(uuid)
    }

    /// Every file Jet can see: the files it wrote and the uploads that were sent, newest first.
    pub fn list(&self) -> Vec<About> {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return Vec::new();
        };
        let mut files: Vec<About> = entries
            .flatten()
            .filter_map(|entry| {
                let id = Uuid::try_parse(&entry.file_name().to_string_lossy()).ok()?;
                match about_in(&entry.path(), id) {
                    Ok(about) => Some(about),
                    Err(error) => {
                        eprintln!("jet: skipped a file in the list: {error}");
                        None
                    }
                }
            })
            .filter(|about| about.attached)
            .collect();
        files.sort_by_key(|about| std::cmp::Reverse(about.at));
        files.truncate(LIST_LIMIT);
        files
    }

    /// Deletes an upload that was never sent. Anything else is left alone and reported as missing.
    ///
    /// # Errors
    /// - [`FileError::NotFound`] when there is no such upload, or it was already sent.
    /// - [`FileError::Io`] when the folder cannot be removed.
    pub fn remove(&self, id: &str) -> Result<(), FileError> {
        let _writing = lock(&self.writes);
        let (uuid, folder) = self.folder(id)?;
        let about = about_in(&folder, uuid)?;
        if about.origin != Origin::Upload || about.attached {
            return Err(FileError::NotFound(id.to_owned()));
        }
        std::fs::remove_dir_all(&folder).map_err(io_error(&folder))
    }

    /// Reads part of a file Jet can see, in the reader process.
    ///
    /// # Errors
    /// - [`FileError::NotFound`] when there is no such file, or it is an upload not yet sent.
    /// - [`FileError::NoSuchSheet`] when a workbook has no sheet of the name asked for.
    /// - [`FileError::Unreadable`] when the reader fails or runs out of memory or time.
    pub async fn read(&self, id: &str, range: &Range) -> Result<(About, Reading), FileError> {
        let (uuid, folder) = self.folder(id)?;
        let about = about_in(&folder, uuid)?;
        if !about.attached {
            return Err(FileError::NotFound(id.to_owned()));
        }
        let reading = self
            .sandbox
            .read(about.kind, &folder.join(&about.name), &about.name, range)
            .await?;
        Ok((about, reading))
    }

    /// Removes every file.
    ///
    /// SMELL: an export still running after its turn was stopped can finish after this, and its
    /// file then stays on disk, linked from nowhere, until the next clear.
    ///
    /// # Errors
    /// [`FileError::Io`] when the files folder cannot be removed.
    pub fn clear(&self) -> Result<(), FileError> {
        let _writing = lock(&self.writes);
        match std::fs::remove_dir_all(&self.root) {
            Err(source) if source.kind() != std::io::ErrorKind::NotFound => Err(FileError::Io {
                path: self.root.clone(),
                source,
            }),
            _ => Ok(()),
        }
    }

    /// The id as a UUID and the folder it names. Only a UUID can name a folder, so no id can lead
    /// outside the store.
    fn folder(&self, id: &str) -> Result<(Uuid, PathBuf), FileError> {
        let uuid = Uuid::try_parse(id).map_err(|_| FileError::NotFound(id.to_owned()))?;
        Ok((uuid, self.root.join(uuid.to_string())))
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn io_error(path: &Path) -> impl FnOnce(std::io::Error) -> FileError {
    let path = path.to_owned();
    move |source| FileError::Io { path, source }
}

/// Only a missing file is the caller's mistake; any other failure is the server's.
fn read_error(id: &str, path: &Path, source: std::io::Error) -> FileError {
    match source.kind() {
        std::io::ErrorKind::NotFound => FileError::NotFound(id.to_owned()),
        _ => io_error(path)(source),
    }
}

/// The name, kind and path of the one file in a folder, leaving out the dot-files beside it.
fn stored(folder: &Path, id: &str) -> Result<(String, FileKind, PathBuf), FileError> {
    let entries = std::fs::read_dir(folder).map_err(|source| read_error(id, folder, source))?;
    let entry = entries
        .flatten()
        .find(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .ok_or_else(|| FileError::NotFound(id.to_owned()))?;
    let name = entry.file_name().to_string_lossy().into_owned();
    let kind = FileKind::of_name(&name).ok_or_else(|| FileError::NotFound(id.to_owned()))?;
    Ok((name, kind, entry.path()))
}

/// The details of the file in `folder`. An upload has them saved beside it; for a file Jet wrote
/// they come from the file itself.
fn about_in(folder: &Path, id: Uuid) -> Result<About, FileError> {
    let sidecar = folder.join(ABOUT_FILE);
    match std::fs::read(&sidecar) {
        Ok(saved) => serde_json::from_slice(&saved).map_err(|source| FileError::Sidecar {
            path: sidecar,
            source,
        }),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            let (name, kind, path) = stored(folder, &id.to_string())?;
            let metadata = std::fs::metadata(&path).map_err(io_error(&path))?;
            let at = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |since| u64::try_from(since.as_millis()).unwrap_or(0));
            Ok(About {
                id,
                name,
                kind,
                bytes: metadata.len(),
                details: String::new(),
                origin: Origin::Export,
                attached: true,
                at,
            })
        }
        Err(source) => Err(io_error(&sidecar)(source)),
    }
}
