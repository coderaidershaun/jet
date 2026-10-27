//! The part of a file that one reading holds: which pages, rows or lines were asked for, and how
//! many of them fit under the limit on characters.

use super::{FileKind, Range, Reading, Unit};

/// The most characters one reading returns, so a single call cannot flood the model.
// SMELL: each reading stays in the transcript as the call's result, so every reload sends it to
// the browser again, although the card shows only a line about it.
const READING_CHARS: usize = 40_000;
const DEFAULT_PAGES: usize = 20;
const DEFAULT_LINES: usize = 500;
const MAX_UNITS: usize = 2000;

/// The start and length of a reading with the defaults and the limit applied.
#[derive(Clone, Copy)]
pub(super) struct Wanted {
    pub start: usize,
    pub count: usize,
}

impl Wanted {
    pub fn new(kind: FileKind, range: &Range) -> Wanted {
        let usual = if kind == FileKind::Pdf {
            DEFAULT_PAGES
        } else {
            DEFAULT_LINES
        };
        Wanted {
            start: range.start.unwrap_or(1).max(1),
            count: range.count.unwrap_or(usual).clamp(1, MAX_UNITS),
        }
    }

    pub fn holds(self, number: usize) -> bool {
        number >= self.start && number - self.start < self.count
    }
}

/// Pieces of a reading, added until the character limit is reached.
pub(super) struct Excerpt {
    start: usize,
    text: String,
    chars: usize,
    pieces: usize,
    end: usize,
    pub is_full: bool,
}

impl Excerpt {
    pub fn new(wanted: Wanted) -> Excerpt {
        Excerpt {
            start: wanted.start,
            text: String::new(),
            chars: 0,
            pieces: 0,
            end: wanted.start - 1,
            is_full: false,
        }
    }

    /// Adds the piece numbered `number`, after `separator` when it is not the first. The first
    /// piece is cut to the limit if it alone is longer; any later piece that would pass the
    /// limit is left out, and so is everything after it.
    // SMELL: the rest of a first piece that is cut is lost. The reading ends at that piece with
    // nothing more to ask for, so Jet cannot read past the first 40,000 characters of one line or
    // page, such as an HTML page saved on a single line.
    pub fn push(&mut self, number: usize, separator: &str, piece: &str) {
        if self.is_full {
            return;
        }
        let joiner = if self.pieces == 0 {
            0
        } else {
            separator.chars().count()
        };
        let room = READING_CHARS.saturating_sub(self.chars + joiner);
        let length = piece.chars().count();
        if length > room && self.pieces > 0 {
            self.is_full = true;
            return;
        }
        if self.pieces > 0 {
            self.text.push_str(separator);
        }
        let kept = length.min(room);
        self.text.extend(piece.chars().take(kept));
        self.chars += joiner + kept;
        self.pieces += 1;
        self.end = number;
        self.is_full = self.chars >= READING_CHARS;
    }

    pub fn into_reading(self, unit: Unit, total: usize, sheets: Vec<String>) -> Reading {
        let end = if self.pieces == 0 { total } else { self.end };
        Reading::Text {
            text: self.text,
            unit,
            start: self.start,
            end,
            total,
            more: end < total,
            sheets,
        }
    }
}

/// The lines or rows of a text that `wanted` asks for, and how many there are in all.
pub(super) fn read_lines<'a>(
    lines: impl Iterator<Item = &'a str>,
    unit: Unit,
    wanted: Wanted,
) -> Reading {
    let mut excerpt = Excerpt::new(wanted);
    let mut total = 0;
    for line in lines {
        total += 1;
        if wanted.holds(total) {
            excerpt.push(total, "\n", line);
        }
    }
    excerpt.into_reading(unit, total, Vec::new())
}
