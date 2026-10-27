//! Taking in a file the user attached: the name cleaned, the kind checked by extension and by the
//! first bytes, the size held to the limits, and the file described by the reader process before
//! it is kept.

use std::path::Path;

use uuid::Uuid;

use super::kind::FileKind;
use super::{ABOUT_FILE, About, FileError, Files, Origin, io_error, lock};

/// The largest file, in bytes.
pub(crate) const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
/// The most the store may hold in all, in bytes.
const MAX_STORE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// The longest file name a file system takes.
const MAX_NAME_BYTES: usize = 255;

impl Files {
    /// Keeps an uploaded file, hidden from Jet until its message is sent.
    ///
    /// The file is written in a `.part` folder and renamed once the reader has described it, so
    /// nothing half-made or unreadable is ever served.
    ///
    /// # Errors
    /// - [`FileError::Unsupported`] when the name is not a kind Jet takes, or the first bytes
    ///   say the file is something else.
    /// - [`FileError::TooLarge`] when the file is over 32 MiB.
    /// - [`FileError::StoreFull`] when it would take the store past 2 GiB.
    /// - [`FileError::Unreadable`] when the reader cannot describe it.
    /// - [`FileError::Io`] when the files folder cannot be used.
    pub async fn upload(&self, name: &str, bytes: Vec<u8>) -> Result<About, FileError> {
        let name = clean_name(name);
        let kind = FileKind::of_name(&name)
            .filter(|kind| kind.matches(&bytes))
            .ok_or_else(|| FileError::Unsupported(name.clone()))?;
        if bytes.len() > MAX_FILE_BYTES {
            return Err(FileError::TooLarge(name));
        }
        let about = About {
            id: Uuid::new_v4(),
            name,
            kind,
            bytes: bytes.len() as u64,
            details: String::new(),
            origin: Origin::Upload,
            attached: false,
            at: agent::now_ms(),
        };
        // The upload runs on a task of its own, so it is kept or cleaned away even when the
        // visitor leaves and the request is dropped halfway.
        let files = self.clone();
        tokio::spawn(async move { files.take_in(about, bytes).await })
            .await
            .unwrap_or_else(|error| Err(io_error(&self.root)(std::io::Error::other(error))))
    }

    async fn take_in(&self, about: About, bytes: Vec<u8>) -> Result<About, FileError> {
        let part = self.root.join(format!("{}.part", about.id));
        // The bytes move into the write and are dropped there, so they are not held in memory
        // while the file waits for a free reader.
        let written = {
            let (files, part, name) = (self.clone(), part.clone(), about.name.clone());
            tokio::task::spawn_blocking(move || files.write_part(&part, &name, bytes)).await
        };
        let kept = match written {
            Ok(Ok(())) => self.keep(&part, about).await,
            Ok(Err(error)) => Err(error),
            Err(error) => Err(io_error(&part)(std::io::Error::other(error))),
        };
        if kept.is_err() {
            // A `.part` folder is never served, so a failed clean-up leaves nothing to reach.
            let _ = std::fs::remove_dir_all(&part);
        }
        kept
    }

    /// Writes the file into a new `.part` folder, after checking that the store has room.
    fn write_part(&self, part: &Path, name: &str, bytes: Vec<u8>) -> Result<(), FileError> {
        let _writing = lock(&self.writes);
        if self.stored_bytes() + bytes.len() as u64 > MAX_STORE_BYTES {
            return Err(FileError::StoreFull);
        }
        std::fs::create_dir_all(part).map_err(io_error(part))?;
        let path = part.join(name);
        std::fs::write(&path, &bytes).map_err(io_error(&path))
    }

    /// Has the reader describe the written file, then saves its details and moves it out of its
    /// `.part` folder.
    async fn keep(&self, part: &Path, mut about: About) -> Result<About, FileError> {
        let path = part.join(&about.name);
        about.details = self
            .sandbox
            .describe(about.kind, &path, &about.name)
            .await?;
        save_about(part, &about)?;
        let folder = self.root.join(about.id.to_string());
        std::fs::rename(part, &folder).map_err(io_error(&folder))?;
        Ok(about)
    }

    /// The size of everything in the store, including folders still being written.
    fn stored_bytes(&self) -> u64 {
        let Ok(folders) = std::fs::read_dir(&self.root) else {
            return 0;
        };
        folders
            .flatten()
            .filter_map(|folder| std::fs::read_dir(folder.path()).ok())
            .flat_map(|files| files.flatten())
            .filter_map(|file| file.metadata().ok())
            .map(|metadata| metadata.len())
            .sum()
    }
}

/// Saves the details beside the file. The write goes to a temporary file first, so a reader of
/// the folder sees the old details or the new ones, never half of either.
pub(super) fn save_about(folder: &Path, about: &About) -> Result<(), FileError> {
    let sidecar = folder.join(ABOUT_FILE);
    let temporary = folder.join(".about.json.tmp");
    let json = serde_json::to_vec(about).expect("details are plain data");
    std::fs::write(&temporary, json).map_err(io_error(&temporary))?;
    std::fs::rename(&temporary, &sidecar).map_err(io_error(&sidecar))
}

/// The name a visitor gave a file, made safe to keep: only the last part of a path, no control
/// characters, no leading dots, and short enough for a file system, cutting the stem and keeping
/// the extension.
fn clean_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = last.chars().filter(|c| !c.is_control()).collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim();
    if cleaned.len() <= MAX_NAME_BYTES {
        return cleaned.to_owned();
    }
    let (stem, extension) = cleaned
        .rsplit_once('.')
        .map_or((cleaned, ""), |(stem, extension)| (stem, extension));
    let room = MAX_NAME_BYTES.saturating_sub(extension.len() + 1);
    let mut cut = room.min(stem.len());
    while !stem.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}.{extension}", &stem[..cut])
}
