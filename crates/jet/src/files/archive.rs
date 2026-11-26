//! Puts a user's files in one zip, so the page can download many of them with one tap. The zip
//! is written to a temporary file, one stored file in memory at a time.

use std::collections::HashSet;
use std::fs::File;
use std::io::{Seek, Write};

use jiff::{Timestamp, tz::TimeZone};
use zip::{CompressionMethod, DateTime, ZipWriter, write::SimpleFileOptions};

use super::{FileError, Files, wait_for};
use crate::on_worker;
use crate::store::UserId;

impl Files {
    /// [`Files::archive`] on a worker, once one of the places to build a zip is free.
    ///
    /// # Errors
    /// - [`FileError::Busy`] when no place comes free in time.
    /// - Any error of [`Files::archive`].
    pub async fn zip(
        &self,
        user: UserId,
        ids: Option<Vec<String>>,
    ) -> Result<(String, File), FileError> {
        let _place = wait_for(&self.archives, self.waits.queue).await?;
        let files = self.clone();
        on_worker(move || files.archive(user, ids.as_deref()))
            .await
            .map_err(FileError::Worker)?
    }

    /// The user's files as one zip and its name, newest change first: all the files Jet can see,
    /// or only those of `ids`, in a temporary file that is gone once it is closed. Two files of
    /// one name are told apart by a number.
    ///
    /// # Errors
    /// - [`FileError::NotFound`] naming the first id that is not such a file of the user.
    /// - [`FileError::Archive`] when the zip cannot be written.
    /// - [`FileError::Scratch`] when the temporary file cannot be made.
    pub fn archive(
        &self,
        user: UserId,
        ids: Option<&[String]>,
    ) -> Result<(String, File), FileError> {
        let mut held = self.store.held_by_user(user, usize::MAX)?;
        if let Some(ids) = ids {
            let seen: HashSet<String> = held.iter().map(|file| file.about.id.to_string()).collect();
            if let Some(missing) = ids.iter().find(|id| !seen.contains(*id)) {
                return Err(FileError::NotFound(missing.clone()));
            }
            held.retain(|file| ids.contains(&file.about.id.to_string()));
        }
        let zone = self.zone(user)?;
        let scratch = tempfile::tempfile().map_err(FileError::Scratch)?;
        let mut zip = ZipWriter::new(scratch);
        let mut taken = HashSet::new();
        for file in held {
            let id = file.about.id.to_string();
            let (_, contents) = self
                .store
                .file(Some(user), &id)?
                .ok_or(FileError::NotFound(id))?;
            let options = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Deflated)
                .last_modified_time(zip_time(&zone, file.about.changed_at()));
            zip.start_file(unique_name(&file.about.name, &mut taken), options)?;
            zip.write_all(&contents)
                .map_err(zip::result::ZipError::from)?;
        }
        let today = zone.to_datetime(now()).strftime("%Y-%m-%d");
        let mut written = zip.finish()?;
        written.rewind().map_err(FileError::Scratch)?;
        Ok((format!("Jet files {today}.zip"), written))
    }
}

fn now() -> Timestamp {
    Timestamp::from_millisecond(i64::try_from(agent::now_ms()).unwrap_or(0))
        .unwrap_or(Timestamp::UNIX_EPOCH)
}

/// The name, or when an earlier entry took it, the name with " (2)", " (3)" and so on before its
/// extension. Names are compared without case, because most disks do.
fn unique_name(name: &str, taken: &mut HashSet<String>) -> String {
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (name, String::new()),
    };
    let mut candidate = name.to_owned();
    let mut number = 1;
    while !taken.insert(candidate.to_lowercase()) {
        number += 1;
        candidate = format!("{stem} ({number}){extension}");
    }
    candidate
}

/// A zip keeps a local time with no zone and nothing before 1980.
fn zip_time(zone: &TimeZone, unix_ms: u64) -> DateTime {
    let at = Timestamp::from_millisecond(i64::try_from(unix_ms).unwrap_or(0))
        .unwrap_or(Timestamp::UNIX_EPOCH);
    let at = zone.to_datetime(at);
    let part = |value: i8| u8::try_from(value).unwrap_or(0);
    DateTime::from_date_and_time(
        u16::try_from(at.year()).unwrap_or(0),
        part(at.month()),
        part(at.day()),
        part(at.hour()),
        part(at.minute()),
        part(at.second()),
    )
    .unwrap_or_default()
}
