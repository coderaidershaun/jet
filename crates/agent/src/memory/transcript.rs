//! `transcript.jsonl`: the thread as the chat page shows it, one entry per line. Entries
//! are only ever added at the end; "forget" moves the whole file aside.

use std::io::{Seek, SeekFrom, Write};

use super::{DataDir, MemoryError};
use crate::chat::{Entry, EntryId, EntryStatus, Mood, Role, ToolCall};

const FILE_NAME: &str = "transcript.jsonl";

/// An entry before it has an id and a time.
pub(crate) struct NewEntry {
    pub role: Role,
    pub text: String,
    pub mood: Option<Mood>,
    pub status: EntryStatus,
    pub error: Option<String>,
    pub tools: Vec<ToolCall>,
}

impl NewEntry {
    pub(crate) fn user(text: &str) -> NewEntry {
        NewEntry {
            role: Role::User,
            text: text.to_owned(),
            mood: None,
            status: EntryStatus::Complete,
            error: None,
            tools: Vec::new(),
        }
    }

    /// The entry as saved, once it has its place in the thread and its time.
    pub(crate) fn into_entry(self, id: EntryId, at: u64) -> Entry {
        Entry {
            id,
            role: self.role,
            text: self.text,
            mood: self.mood,
            status: self.status,
            error: self.error,
            tools: self.tools,
            at,
        }
    }
}

pub(crate) struct Transcript {
    dir: DataDir,
}

impl Transcript {
    pub(crate) fn open(dir: &DataDir) -> Transcript {
        Transcript { dir: dir.clone() }
    }

    /// Adds an entry at the end. A half-written last line, left by a crash, is dropped
    /// first so it cannot end up in the middle of the file.
    // SMELL: every append reads the whole file to find the last id, so a very long thread
    // makes each message a little slower.
    pub(crate) fn append(&self, new: NewEntry, at: u64) -> Result<Entry, MemoryError> {
        let path = self.dir.path(FILE_NAME);
        let text = self.dir.read(FILE_NAME)?.unwrap_or_default();
        let whole_lines = text.rfind('\n').map_or(0, |last_newline| last_newline + 1);
        let last_id = parse(&text[..whole_lines], &path)?
            .last()
            .map_or(0, |entry| entry.id.0);
        let entry = new.into_entry(EntryId(last_id + 1), at);
        let mut line = serde_json::to_string(&entry).map_err(|source| MemoryError::Json {
            path: path.clone(),
            line: 0,
            source,
        })?;
        line.push('\n');

        let write_failed = |source| MemoryError::Write {
            path: path.clone(),
            source,
        };
        std::fs::create_dir_all(self.dir.root()).map_err(write_failed)?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&path)
            .map_err(write_failed)?;
        file.set_len(whole_lines as u64).map_err(write_failed)?;
        file.seek(SeekFrom::End(0)).map_err(write_failed)?;
        file.write_all(line.as_bytes()).map_err(write_failed)?;
        Ok(entry)
    }

    /// Every entry, oldest first. A torn last line is skipped; a bad line anywhere else
    /// is an error.
    pub(crate) fn entries(&self) -> Result<Vec<Entry>, MemoryError> {
        let text = self.dir.read(FILE_NAME)?.unwrap_or_default();
        parse(&text, &self.dir.path(FILE_NAME))
    }

    /// The newest `limit` entries, oldest first.
    pub(crate) fn last(&self, limit: usize) -> Result<Vec<Entry>, MemoryError> {
        let mut entries = self.entries()?;
        let skip = entries.len().saturating_sub(limit);
        Ok(entries.split_off(skip))
    }

    /// Entries newer than `id`, oldest first.
    pub(crate) fn after(&self, id: EntryId) -> Result<Vec<Entry>, MemoryError> {
        let mut entries = self.entries()?;
        entries.retain(|entry| entry.id > id);
        Ok(entries)
    }

    /// Moves the thread aside as `transcript.<UTC time>.jsonl`. The next entry starts a
    /// new thread at id 1.
    pub(crate) fn rotate(&self, at: u64) -> Result<(), MemoryError> {
        let from = self.dir.path(FILE_NAME);
        if !from.exists() {
            return Ok(());
        }
        let to = self
            .dir
            .path(&format!("transcript.{}.jsonl", utc_stamp(at)));
        std::fs::rename(&from, &to).map_err(|source| MemoryError::Write { path: from, source })
    }
}

fn parse(text: &str, path: &std::path::Path) -> Result<Vec<Entry>, MemoryError> {
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
                return Err(MemoryError::Json {
                    path: path.to_path_buf(),
                    line: index + 1,
                    source,
                });
            }
        }
    }
    Ok(entries)
}

/// `2026-10-14T11-20-05` for a Unix time in milliseconds.
fn utc_stamp(at_ms: u64) -> String {
    let seconds = at_ms / 1000;
    let (year, month, day) = civil_date(seconds / 86_400);
    let second_of_day = seconds % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}-{:02}-{:02}",
        second_of_day / 3600,
        second_of_day % 3600 / 60,
        second_of_day % 60
    )
}

/// Year, month and day for a count of days since 1970-01-01 (proleptic Gregorian).
fn civil_date(days_since_epoch: u64) -> (u64, u64, u64) {
    let shifted = days_since_epoch + 719_468;
    let era = shifted / 146_097;
    let day_of_era = shifted % 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + u64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jet(text: &str) -> NewEntry {
        NewEntry {
            role: Role::Jet,
            text: text.to_owned(),
            mood: Some(Mood::Happy),
            status: EntryStatus::Complete,
            error: None,
            tools: Vec::new(),
        }
    }

    #[test]
    fn a_torn_last_line_is_skipped() {
        let dir = DataDir::scratch("transcript-torn");
        let transcript = Transcript::open(&dir);
        transcript.append(NewEntry::user("one"), 10).unwrap();
        transcript.append(jet("two"), 20).unwrap();

        let path = dir.path(FILE_NAME);
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.write_all(br#"{"id":3,"role":"us"#).unwrap();

        let entries = transcript.entries().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].text, "two");

        // The next entry replaces the torn fragment instead of gluing onto it.
        let third = transcript.append(NewEntry::user("three"), 30).unwrap();
        assert_eq!(third.id, EntryId(3));
        assert_eq!(transcript.entries().unwrap().len(), 3);

        let mut broken = std::fs::read_to_string(&path).unwrap();
        broken = broken.replacen("\"two\"", "tw0", 1);
        std::fs::write(&path, broken).unwrap();
        assert!(matches!(
            transcript.entries(),
            Err(MemoryError::Json { line: 2, .. })
        ));
    }

    #[test]
    fn rotated_transcript_is_named_by_utc_time_and_ids_restart() {
        let dir = DataDir::scratch("transcript-rotate");
        let transcript = Transcript::open(&dir);
        transcript.append(NewEntry::user("one"), 10).unwrap();
        // 2026-10-14T11:20:05Z
        transcript.rotate(1_791_976_805_000).unwrap();
        assert!(dir.path("transcript.2026-10-14T11-20-05.jsonl").exists());
        assert!(transcript.entries().unwrap().is_empty());
        assert_eq!(
            transcript.append(NewEntry::user("again"), 11).unwrap().id,
            EntryId(1)
        );
    }
}
