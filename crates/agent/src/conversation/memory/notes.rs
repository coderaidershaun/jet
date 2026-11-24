//! The three notes, each cut to its limit on a line boundary so the prompt cannot grow without
//! bound.

use crate::chat::{MEMORY_LIMIT, Notes, RECENT_LIMIT, USER_LIMIT};

impl Notes {
    /// The notes cut to their limits on line boundaries.
    pub fn trimmed(&self) -> Notes {
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
