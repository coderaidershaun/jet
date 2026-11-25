//! Taking in a file the user attached: the name cleaned, the kind checked by extension and by the
//! first bytes, the size held to the limits, and the file described by the reader process before
//! it is kept.

use super::kind::FileKind;
use super::{About, FileError, Files, Origin};
use crate::store::UserId;

/// The largest file, in bytes.
pub(crate) const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
/// The most one user's files and their kept earlier versions may take, in bytes.
pub(super) const MAX_USER_BYTES: u64 = 256 * 1024 * 1024;
/// The most the files of all users may take together, in bytes.
pub(super) const MAX_STORE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// The longest file name a file system takes.
const MAX_NAME_BYTES: usize = 255;

impl Files {
    /// Keeps a file the user uploaded, hidden from Jet until its message is sent. Only a file the
    /// reader could describe is kept, so nothing unreadable is ever served.
    ///
    /// # Errors
    /// - [`FileError::Unsupported`] when the name is not a kind Jet takes, or the first bytes
    ///   say the file is something else.
    /// - [`FileError::TooLarge`] when the file is over 32 MiB.
    /// - [`FileError::StoreFull`] when it would take the store past 2 GiB.
    /// - [`FileError::UserFull`] when it would take the user's files past their limit.
    /// - [`FileError::Unreadable`] when the reader cannot describe it.
    pub async fn upload(
        &self,
        user: UserId,
        name: &str,
        bytes: Vec<u8>,
    ) -> Result<About, FileError> {
        let name = clean_name(name);
        let kind = FileKind::of_name(&name)
            .filter(|kind| kind.matches(&bytes))
            .ok_or_else(|| FileError::Unsupported(name.clone()))?;
        if bytes.len() > MAX_FILE_BYTES {
            return Err(FileError::TooLarge(name));
        }
        let details = self.sandbox.describe(kind, &bytes, &name).await?;
        let mut about = About::new(name, kind, &bytes, Origin::Upload, agent::now_ms());
        about.details = details;
        let (files, kept) = (self.clone(), about.clone());
        tokio::task::spawn_blocking(move || files.keep(user, None, &kept, &bytes))
            .await
            .map_err(|error| FileError::Worker(error.into()))??;
        Ok(about)
    }
}

/// The name a visitor gave a file, made safe to keep: only the last part of a path, no control
/// characters, no leading dots, and short enough for a file system, cutting the stem and keeping
/// the extension.
pub(super) fn clean_name(name: &str) -> String {
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
