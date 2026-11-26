//! Keeps each user's files in the database until the user deletes them, or forgets or deletes
//! the last chat that holds them: the files Jet writes for the user to download, and the files the
//! user attaches to a message. The routes that move them to and from the page are here too.

mod about;
mod archive;
mod artifacts;
mod export;
mod kind;
mod read;
mod routes;
mod sandbox;
mod upload;

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

use crate::WorkerFailed;
use crate::store::{Added, ChatId, Store, StoreError, UserId};

pub(crate) use about::{About, Origin};
pub(crate) use artifacts::{Artifact, Library, MAX_CONTEXT_CHARS};
pub(crate) use export::ExportRequest;
pub(crate) use kind::FileKind;
pub(crate) use read::{Range, Reading};
pub(crate) use routes::router;
use sandbox::Sandbox;
pub use sandbox::{READ_FILE_ARGUMENT, run_file_reader};
pub(crate) use upload::MAX_FILE_BYTES;
use upload::MAX_USER_BYTES;

/// The most files `list` returns.
const LIST_LIMIT: usize = 200;
/// Uploads taken in at once. Each is held whole in memory until it is kept, so this bounds that
/// memory to a few times the largest file.
const UPLOADS_AT_ONCE: usize = 4;
/// Zips built at once. Each is written to a temporary file, one stored file in memory at a time.
const ARCHIVES_AT_ONCE: usize = 1;

/// How long a request may wait at each step that other requests can hold up.
#[derive(Clone, Copy)]
struct Waits {
    /// For a place at the uploads, the zips or the file reader.
    queue: Duration,
    /// For an upload's body to arrive once it has its place. It is shorter than `queue`, so a
    /// stalled upload gives its place back before the next one in line gives up.
    body: Duration,
}

const WAITS: Waits = Waits {
    queue: Duration::from_secs(30),
    body: Duration::from_secs(20),
};

/// A saved file, read back to be sent to the browser.
#[derive(Debug)]
pub(crate) struct OpenedFile {
    pub id: Uuid,
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
    /// The program, its path and the cause go to the log only, because the answer reaches users
    /// who are not admins.
    #[error("could not start the file reader")]
    Reader,
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
    #[error(
        "Your files in Jet take more than {0} MB. Remove a file or forget a chat to free room. Files attached but never sent hold room for a day."
    )]
    UserFull(u64),
    #[error(
        "this chat does not hold that file; share brings a file of another chat here (files_list with that chat's id shows what it holds), or puts a file of this chat in another chat"
    )]
    NotHeld,
    #[error(
        "“{0}” is not a text file, so Jet can't write it; only Markdown, HTML, CSV and text can be written"
    )]
    NotText(String),
    #[error("a file keeps its kind, so its new name must end the way “{0}” does")]
    RenameKind(String),
    #[error("no earlier version of that file is kept")]
    NoEarlier,
    #[error("no chat with id {0}")]
    NoChat(i64),
    #[error("Jet couldn't read “{0}”.")]
    Unreadable(String),
    #[error("{0}")]
    NoSuchSheet(String),
    #[error("This is the only chat that holds this file. Delete the file instead.")]
    LastChat,
    #[error("could not write the zip of files: {0}")]
    Archive(#[from] zip::result::ZipError),
    #[error("the file name cannot be sent")]
    NameNotSendable,
    #[error("request worker failed: {0}")]
    Worker(WorkerFailed),
    #[error("Jet is busy with other files. Try again in a moment.")]
    Busy,
    #[error("“{0}” took too long to arrive. Try again, or send a smaller file.")]
    SlowUpload(String),
    #[error("the chat was forgotten while the file was being written, so it was not kept")]
    Forgotten,
}

/// Every user's files. Each call acts for one user and sees only that user's files. A user keeps
/// their files until they remove them or forget the chat, held to the user's limit and the store's.
#[derive(Clone)]
pub(crate) struct Files {
    store: Store,
    sandbox: Sandbox,
    uploads: Arc<Semaphore>,
    archives: Arc<Semaphore>,
    waits: Waits,
    /// What one user's files and their kept versions may take, in bytes.
    user_limit: u64,
}

impl Files {
    pub fn new(store: Store) -> Files {
        Files::with_waits(store, WAITS)
    }

    fn with_waits(store: Store, waits: Waits) -> Files {
        // A test sets a small limit, because filling 256 MiB would take too long.
        let user_limit = std::env::var("JET_TEST_USER_FILE_BYTES")
            .ok()
            .and_then(|bytes| bytes.parse().ok())
            .unwrap_or(MAX_USER_BYTES);
        Files {
            store,
            sandbox: Sandbox::new(waits.queue),
            uploads: Arc::new(Semaphore::new(UPLOADS_AT_ONCE)),
            archives: Arc::new(Semaphore::new(ARCHIVES_AT_ONCE)),
            waits,
            user_limit,
        }
    }

    /// Keeps a new file, or says which limit it is over.
    fn keep(
        &self,
        user: UserId,
        chat: Option<ChatId>,
        about: &About,
        contents: &[u8],
    ) -> Result<(), FileError> {
        let limits = (upload::MAX_STORE_BYTES, self.user_limit);
        match self.store.add_file(user, chat, about, contents, limits)? {
            Added::Kept => Ok(()),
            Added::Full => Err(FileError::StoreFull),
            Added::UserFull => Err(FileError::UserFull(self.user_limit.div_ceil(1024 * 1024))),
            Added::Forgotten => Err(FileError::Forgotten),
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
            id: about.id,
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
        let about = self.store.file_about(user, &usual_id(id)).ok()??;
        about.attached.then_some(about.id)
    }

    /// Deletes the user's file, sent or not, from every chat that holds it, with its earlier
    /// versions.
    ///
    /// # Errors
    /// - [`FileError::NotFound`] when there is no such file, or it is another user's.
    pub fn delete(&self, user: UserId, id: &str) -> Result<(), FileError> {
        match self.store.delete_file(user, id)? {
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
        let (store, wanted) = (self.store.clone(), usual_id(id));
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

    /// Removes every file sent or written in the chat. Call it after the chat's thread is
    /// forgotten: a file begun before that and finished after it is then refused, not kept.
    pub fn clear(&self, chat: ChatId) -> Result<(), FileError> {
        Ok(self.store.remove_files(chat)?)
    }
}

/// The id in its usual written form, whatever form of the same UUID a model wrote, such as
/// capitals. An id that is no UUID comes back as it is, and names no file.
pub(crate) fn usual_id(id: &str) -> String {
    Uuid::try_parse(id).map_or_else(|_| id.to_owned(), |uuid| uuid.to_string())
}

/// A place in the queue, or [`FileError::Busy`] when none comes free within `deadline`.
async fn wait_for(
    queue: &Arc<Semaphore>,
    deadline: Duration,
) -> Result<OwnedSemaphorePermit, FileError> {
    match tokio::time::timeout(deadline, queue.clone().acquire_owned()).await {
        Ok(permit) => Ok(permit.expect("the queue is never closed")),
        Err(_) => Err(FileError::Busy),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::test_store;
    use axum::body::Body;

    fn quick(queue_ms: u64, body_ms: u64) -> (tempfile::TempDir, Files, UserId) {
        let (dir, store, ada, _) = test_store();
        let waits = Waits {
            queue: Duration::from_millis(queue_ms),
            body: Duration::from_millis(body_ms),
        };
        (dir, Files::with_waits(store, waits), ada)
    }

    /// Starts as many uploads as there are places, each sending nothing, and lets them take
    /// their places.
    async fn stall_every_place(
        files: &Files,
        user: UserId,
    ) -> Vec<tokio::task::JoinHandle<Result<About, FileError>>> {
        let stalled = (0..UPLOADS_AT_ONCE)
            .map(|_| {
                let files = files.clone();
                let silent = tokio_stream::pending::<Result<Vec<u8>, std::io::Error>>();
                tokio::spawn(async move {
                    files
                        .upload_body(user, "slow.txt", Body::from_stream(silent))
                        .await
                })
            })
            .collect();
        tokio::time::sleep(Duration::from_millis(20)).await;
        stalled
    }

    #[tokio::test]
    async fn an_upload_waits_for_a_place_and_a_stalled_one_gives_its_place_back() {
        let (_dir, files, ada) = quick(100, 10_000);
        let _stalled = stall_every_place(&files, ada).await;
        let refused = files.upload_body(ada, "a.exe", Body::from("MZ")).await;
        assert!(matches!(refused, Err(FileError::Busy)), "{refused:?}");

        let (_dir, files, ada) = quick(500, 50);
        let stalled = stall_every_place(&files, ada).await;
        let taken = files.upload_body(ada, "a.exe", Body::from("MZ")).await;
        assert!(
            matches!(taken, Err(FileError::Unsupported(_))),
            "the upload got past the stalled ones and was read: {taken:?}"
        );
        for upload in stalled {
            let gave_up = upload.await.unwrap();
            assert!(
                matches!(gave_up, Err(FileError::SlowUpload(_))),
                "{gave_up:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_zip_waits_for_the_one_before_it() {
        let (_dir, files, ada) = quick(50, 50);
        let building = wait_for(&files.archives, files.waits.queue).await.unwrap();
        let refused = files.zip(ada, None).await;
        assert!(matches!(refused, Err(FileError::Busy)), "{refused:?}");
        drop(building);
        assert!(files.zip(ada, None).await.is_ok());
    }

    #[test]
    fn an_id_in_capitals_names_the_same_file() {
        let (_dir, files, ada) = quick(50, 50);
        let main = files.store.main_chat(ada).unwrap().id;
        let written = About::new(
            "notes.md".into(),
            FileKind::Text,
            b"one",
            Origin::Export,
            1_000,
        );
        files.keep(ada, Some(main), &written, b"one").unwrap();
        let capitals = written.id.to_string().to_uppercase();
        assert_eq!(files.visible_id(ada, &capitals), Some(written.id));
    }

    #[tokio::test]
    async fn a_read_waits_for_a_free_reader() {
        let (_dir, files, _) = quick(50, 50);
        let readers = files.sandbox.readers.clone();
        let _all_busy = readers.acquire_many_owned(2).await.unwrap();
        let refused = files.sandbox.describe(FileKind::Text, b"hi", "a.txt").await;
        assert!(matches!(refused, Err(FileError::Busy)), "{refused:?}");
    }
}
