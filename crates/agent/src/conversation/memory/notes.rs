//! `MEMORY.md`, `USER.md` and `RECENT.md`, each cut to its limit on a line boundary so the
//! prompt cannot grow without bound.

use super::{DataDir, MemoryError};
use crate::chat::{MEMORY_LIMIT, Notes, RECENT_LIMIT, USER_LIMIT};

const MEMORY_FILE: &str = "MEMORY.md";
const USER_FILE: &str = "USER.md";
const RECENT_FILE: &str = "RECENT.md";

impl Notes {
    /// The saved notes. A note that was never written is empty.
    pub(crate) fn load(dir: &DataDir) -> Result<Notes, MemoryError> {
        let read = |name| dir.read(name).map(Option::unwrap_or_default);
        Ok(Notes {
            memory: read(MEMORY_FILE)?,
            user: read(USER_FILE)?,
            recent: read(RECENT_FILE)?,
        }
        .trimmed())
    }

    /// Saves the notes after cutting them to their limits, and returns what was saved.
    pub(crate) fn save(&self, dir: &DataDir) -> Result<Notes, MemoryError> {
        let notes = self.trimmed();
        dir.write(MEMORY_FILE, &notes.memory)?;
        dir.write(USER_FILE, &notes.user)?;
        dir.write(RECENT_FILE, &notes.recent)?;
        Ok(notes)
    }

    pub(crate) fn trimmed(&self) -> Notes {
        Notes {
            memory: trim_to_limit(&self.memory, MEMORY_LIMIT),
            user: trim_to_limit(&self.user, USER_LIMIT),
            recent: trim_to_limit(&self.recent, RECENT_LIMIT),
        }
    }
}

/// Keeps whole lines from the top while they fit in `limit` characters. A first line that
/// is longer than the limit by itself is cut in the middle.
pub(crate) fn trim_to_limit(text: &str, limit: usize) -> String {
    let mut kept: Vec<&str> = Vec::new();
    let mut used = 0;
    for line in text.lines() {
        let cost = line.chars().count() + usize::from(!kept.is_empty());
        if used + cost > limit {
            break;
        }
        kept.push(line);
        used += cost;
    }
    if kept.is_empty() {
        return text
            .lines()
            .next()
            .unwrap_or_default()
            .chars()
            .take(limit)
            .collect();
    }
    kept.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_are_trimmed_to_their_caps_on_a_line_boundary() {
        assert_eq!(trim_to_limit("a\nbb\nccc", 4), "a\nbb");
        assert_eq!(trim_to_limit("short note", 100), "short note");
        assert_eq!(trim_to_limit("ééééé\nnext", 3), "ééé");

        let dir = DataDir::scratch("notes-caps");
        let long_line = "- fact\n".repeat(MEMORY_LIMIT);
        let saved = Notes {
            memory: long_line,
            user: "u".repeat(USER_LIMIT + 50),
            recent: String::new(),
        }
        .save(&dir)
        .unwrap();
        assert!(saved.memory.chars().count() <= MEMORY_LIMIT);
        assert!(saved.memory.ends_with("- fact"), "cut on a line boundary");
        assert_eq!(saved.user.chars().count(), USER_LIMIT);
        assert_eq!(Notes::load(&dir).unwrap(), saved);
    }
}
