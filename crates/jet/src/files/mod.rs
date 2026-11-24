//! Keeps each user's files in the database until the user forgets or deletes the chat they were sent or written in: the files Jet writes
//! for the user to download, and the files the user attaches to a message. The routes that move
//! them to and from the page are here too.

mod about;
mod export;
mod kind;
mod read;
mod routes;
mod sandbox;
mod upload;

use uuid::Uuid;

use crate::WorkerFailed;
use crate::store::{ChatId, Store, StoreError, UserId};

pub(crate) use about::{About, Origin};
pub(crate) use export::ExportRequest;
pub(crate) use kind::FileKind;
pub(crate) use read::{Range, Reading};
pub(crate) use routes::router;
use sandbox::Sandbox;
pub use sandbox::{READ_FILE_ARGUMENT, run_file_reader};
pub(crate) use upload::MAX_FILE_BYTES;

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
    #[error("could not start the file reader {}: {source}", program.display())]
    Reader {
        program: std::path::PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not write the exported file in a temporary folder: {0}")]
    Scratch(#[source] std::io::Error),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(
        "“{0}” can't be attached. Jet takes PDF, Markdown, HTML, Excel (.xlsx), CSV, text and images."
    )]
    Unsupported(String),
    #[error("“{0}” is over {limit} MB.", limit = MAX_FILE_BYTES / (1024 * 1024))]
    TooLarge(String),
    #[error("Jet's file store is full. Forget the conversation to free it.")]
    StoreFull,
    #[error("Jet couldn't read “{0}”.")]
    Unreadable(String),
    #[error("{0}")]
    NoSuchSheet(String),
    #[error("the file name cannot be sent")]
    NameNotSendable,
    #[error("request worker failed: {0}")]
    Worker(WorkerFailed),
}

/// Every user's files. Each call acts for one user and sees only that user's files.
// SMELL: files are kept until Forget, and an upload that was never sent stays too. The store is
// held to 2 GiB in all, so a visitor can fill it with unsent uploads until Forget is pressed.
#[derive(Clone)]
pub(crate) struct Files {
    store: Store,
    sandbox: Sandbox,
}

impl Files {
    pub fn new(store: Store) -> Files {
        Files {
            store,
            sandbox: Sandbox::new(),
        }
    }

    /// Reads the user's file, or with `None` the file an address's proof names, whoever's it is.
    ///
    /// # Errors
    /// - [`FileError::NotFound`] when there is no such file, or it is another user's.
    /// - [`FileError::Store`] when the database cannot be read.
    pub fn open(&self, user: Option<UserId>, id: &str) -> Result<OpenedFile, FileError> {
        let (about, contents) = self
            .store
            .file(user, id)?
            .ok_or_else(|| FileError::NotFound(id.to_owned()))?;
        Ok(OpenedFile {
            name: about.name,
            kind: about.kind,
            contents,
        })
    }

    /// Marks the user's uploads as sent, so Jet can see them, and gives their details in the same
    /// order. A bad id leaves nothing marked. Marking a file twice changes nothing.
    ///
    /// # Errors
    /// - [`FileError::NotFound`] naming the first id that is not an upload of this user.
    /// - [`FileError::Store`] when the database cannot be used.
    pub fn attach(
        &self,
        user: UserId,
        chat: ChatId,
        ids: &[&str],
    ) -> Result<Vec<About>, FileError> {
        if let Some(missing) = self.store.attach_files(user, chat, ids)? {
            return Err(FileError::NotFound(missing));
        }
        ids.iter()
            .map(|id| {
                self.store
                    .file_about(user, id)?
                    .ok_or_else(|| FileError::NotFound((*id).to_owned()))
            })
            .collect()
    }

    /// The id in its usual written form when it names a file of the user that Jet can see: one it
    /// wrote, or an upload that was sent. `None` for any other id.
    pub fn visible_id(&self, user: UserId, id: &str) -> Option<Uuid> {
        let about = self.store.file_about(user, id).ok()??;
        about.attached.then_some(about.id)
    }

    /// Every file of the user that Jet can see, newest first.
    pub fn list(&self, user: UserId) -> Result<Vec<About>, FileError> {
        Ok(self.store.attached_files(user, LIST_LIMIT)?)
    }

    /// Deletes the user's upload that was never sent. Anything else is left alone and reported as
    /// missing.
    ///
    /// # Errors
    /// - [`FileError::NotFound`] when there is no such upload, or it was already sent.
    pub fn remove(&self, user: UserId, id: &str) -> Result<(), FileError> {
        match self.store.remove_unsent_file(user, id)? {
            true => Ok(()),
            false => Err(FileError::NotFound(id.to_owned())),
        }
    }

    /// Reads part of a file of the user that Jet can see, in the reader process.
    ///
    /// # Errors
    /// - [`FileError::NotFound`] when there is no such file, or it is an upload not yet sent.
    /// - [`FileError::NoSuchSheet`] when a workbook has no sheet of the name asked for.
    /// - [`FileError::Unreadable`] when the reader fails or runs out of memory or time.
    pub async fn read(
        &self,
        user: UserId,
        id: &str,
        range: &Range,
    ) -> Result<(About, Reading), FileError> {
        let (store, wanted) = (self.store.clone(), id.to_owned());
        let found = tokio::task::spawn_blocking(move || store.file(Some(user), &wanted))
            .await
            .map_err(|error| FileError::Worker(error.into()))??;
        let (about, contents) = found
            .filter(|(about, _)| about.attached)
            .ok_or_else(|| FileError::NotFound(id.to_owned()))?;
        let reading = self
            .sandbox
            .read(about.kind, &contents, &about.name, range)
            .await?;
        Ok((about, reading))
    }

    /// Removes every file sent or written in the chat.
    ///
    /// SMELL: an export still running after its turn was stopped can finish after this, and its
    /// file then stays, linked from nowhere, until the next clear.
    pub fn clear(&self, chat: ChatId) -> Result<(), FileError> {
        Ok(self.store.remove_files(chat)?)
    }
}
