//! `transcript.jsonl`: the thread as the chat page shows it, one entry per line. Entries
//! are only ever added at the end; "forget" moves the whole file aside.

use std::io::{Seek, SeekFrom, Write};

use super::{DataDir, MemoryError};
use crate::chat::{Entry, EntryId, EntryStatus, Mood, Role, ToolCall, TurnIdentity};

const FILE_NAME: &str = "transcript.jsonl";

/// An entry before it has an id and a time.
pub(crate) struct NewEntry {
    pub turn: Option<TurnIdentity>,
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
            turn: None,
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
            turn: self.turn,
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
        file.sync_data().map_err(write_failed)?;
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

    /// Moves the thread aside as `transcript.<at>.jsonl`, where `at` is Unix milliseconds.
    /// The next entry starts a new thread at id 1.
    pub(crate) fn rotate(&self, at: u64) -> Result<(), MemoryError> {
        let from = self.dir.path(FILE_NAME);
        if !from.exists() {
            return Ok(());
        }
        let to = self.dir.path(&format!("transcript.{at}.jsonl"));
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
