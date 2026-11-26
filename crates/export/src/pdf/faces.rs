//! The faces a PDF sets its text in, and the shaping of a piece of text, so that the width a line
//! is measured at is the width it is drawn at.

use krilla::text::{Font, GlyphId, KrillaGlyph, Tag};
use rustybuzz::{Direction, UnicodeBuffer};
use unicode_segmentation::UnicodeSegmentation;

use crate::ExportError;

const LITERATA: &[u8] = include_bytes!("../../assets/fonts/Literata[opsz,wght].ttf");
const LITERATA_ITALIC: &[u8] = include_bytes!("../../assets/fonts/Literata-Italic[opsz,wght].ttf");
const SOURCE_CODE: &[u8] = include_bytes!("../../assets/fonts/SourceCodePro[wght].ttf");
const STIX_TWO_MATH: &[u8] = include_bytes!("../../assets/fonts/STIXTwoMath-Regular.otf");
const OPTICAL_SIZE: f32 = 14.0;
const REGULAR: f32 = 400.0;
const SEMIBOLD: f32 = 600.0;
/// The shaper counts the distance from an accent back to its letter in 16 bits, and panics past
/// it, so text is shaped in pieces far shorter than that.
const MOST_CHARACTERS_SHAPED_AT_ONCE: usize = 4096;

/// A face of text. Which file and weight each one is lives in [`Faces::new`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Typeface {
    Serif,
    SerifStrong,
    SerifItalic,
    SerifStrongItalic,
    Code,
}

/// A font file as the PDF writer holds it, and as the shaper holds it.
struct Loaded {
    font: Font,
    shaper: rustybuzz::Face<'static>,
    units_per_em: f32,
}

impl Loaded {
    fn new(
        name: &str,
        bytes: &'static [u8],
        variations: &[(&[u8; 4], f32)],
    ) -> Result<Loaded, ExportError> {
        let unreadable = || ExportError::Pdf {
            reason: format!("the font {name} cannot be read"),
        };
        let tags: Vec<(Tag, f32)> = variations
            .iter()
            .map(|(tag, value)| (Tag::new(tag), *value))
            .collect();
        let font = Font::new_variable(bytes.into(), 0, &tags).ok_or_else(unreadable)?;
        let mut shaper = rustybuzz::Face::from_slice(bytes, 0).ok_or_else(unreadable)?;
        for (tag, value) in variations {
            shaper.set_variation(rustybuzz::ttf_parser::Tag::from_bytes(tag), *value);
        }
        let units_per_em = f32::from(shaper.units_per_em() as u16);
        Ok(Loaded {
            font,
            shaper,
            units_per_em,
        })
    }

    fn has(&self, character: char) -> bool {
        self.shaper.glyph_index(character).is_some()
    }
}

/// A piece of text in one font, shaped.
pub(super) struct Run {
    pub(super) font: Font,
    pub(super) text: String,
    pub(super) glyphs: Vec<KrillaGlyph>,
}

impl Run {
    pub(super) fn width(&self, size: f32) -> f32 {
        self.glyphs.iter().map(|glyph| glyph.x_advance * size).sum()
    }
}

pub(super) struct Faces {
    serif: Loaded,
    serif_strong: Loaded,
    serif_italic: Loaded,
    serif_strong_italic: Loaded,
    code: Loaded,
    /// Draws a sign that the face of the text does not have.
    math: Loaded,
}

impl Faces {
    pub(super) fn new() -> Result<Faces, ExportError> {
        let serif = |bytes, weight| {
            Loaded::new(
                "Literata",
                bytes,
                &[(b"wght", weight), (b"opsz", OPTICAL_SIZE)],
            )
        };
        Ok(Faces {
            serif: serif(LITERATA, REGULAR)?,
            serif_strong: serif(LITERATA, SEMIBOLD)?,
            serif_italic: serif(LITERATA_ITALIC, REGULAR)?,
            serif_strong_italic: serif(LITERATA_ITALIC, SEMIBOLD)?,
            code: Loaded::new("Source Code Pro", SOURCE_CODE, &[(b"wght", REGULAR)])?,
            math: Loaded::new("STIX Two Math", STIX_TWO_MATH, &[])?,
        })
    }

    fn loaded(&self, typeface: Typeface) -> &Loaded {
        match typeface {
            Typeface::Serif => &self.serif,
            Typeface::SerifStrong => &self.serif_strong,
            Typeface::SerifItalic => &self.serif_italic,
            Typeface::SerifStrongItalic => &self.serif_strong_italic,
            Typeface::Code => &self.code,
        }
    }

    /// The width of `text` set in `typeface` at `size` points.
    pub(super) fn width(&self, text: &str, typeface: Typeface, size: f32) -> f32 {
        self.shape(text, typeface)
            .iter()
            .map(|run| run.width(size))
            .sum()
    }

    /// How far a face rises above its baseline and falls below it, in em.
    pub(super) fn extent(&self, typeface: Typeface) -> (f32, f32) {
        let shaper = self.loaded(typeface);
        let per_em = |units: i16| f32::from(units) / shaper.units_per_em;
        (
            per_em(shaper.shaper.ascender()),
            -per_em(shaper.shaper.descender()),
        )
    }

    /// The text as runs, each in the face of the text when it has every sign of the run, and in
    /// the math font for a sign that only that font has.
    pub(super) fn shape(&self, text: &str, typeface: Typeface) -> Vec<Run> {
        let primary = self.loaded(typeface);
        let mut runs = Vec::new();
        let mut start = 0;
        let mut in_math = false;
        for (at, character) in text.char_indices() {
            let needs_math = !primary.has(character) && self.math.has(character);
            if needs_math != in_math && at > start {
                runs.push(
                    self.shaped(&text[start..at], if in_math { &self.math } else { primary }),
                );
                start = at;
            }
            in_math = needs_math;
        }
        if start < text.len() {
            runs.push(self.shaped(&text[start..], if in_math { &self.math } else { primary }));
        }
        runs
    }

    /// The run shaped in pieces of at most `MOST_CHARACTERS_SHAPED_AT_ONCE` characters.
    fn shaped(&self, text: &str, loaded: &Loaded) -> Run {
        let starts = piece_starts(text);
        let mut glyphs = Vec::new();
        for (n, &start) in starts.iter().enumerate() {
            let end = starts.get(n + 1).copied().unwrap_or(text.len());
            glyphs.extend(shape_piece(&text[start..end], start, loaded));
        }
        Run {
            font: loaded.font.clone(),
            text: text.to_owned(),
            glyphs,
        }
    }
}

/// Where each piece of a run starts. A piece ends between two letters with their accents, so
/// that a letter is shaped with its accents, unless one letter alone is longer than a piece.
fn piece_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![0];
    let mut count = 0;
    for (at, letter) in text.grapheme_indices(true) {
        if count > 0 && count + letter.chars().count() > MOST_CHARACTERS_SHAPED_AT_ONCE {
            starts.push(at);
            count = 0;
        }
        for (inside, _) in letter.char_indices() {
            if count == MOST_CHARACTERS_SHAPED_AT_ONCE {
                starts.push(at + inside);
                count = 0;
            }
            count += 1;
        }
    }
    starts
}

/// The glyphs of a piece of a run that starts at byte `offset` of the run.
fn shape_piece(text: &str, offset: usize, loaded: &Loaded) -> Vec<KrillaGlyph> {
    let mut buffer = UnicodeBuffer::new();
    buffer.push_str(text);
    buffer.set_direction(Direction::LeftToRight);
    buffer.guess_segment_properties();
    let shaped = rustybuzz::shape(&loaded.shaper, &[], buffer);
    let infos = shaped.glyph_infos();
    let positions = shaped.glyph_positions();
    // A cluster ends where the next glyph with another cluster starts. Walking back from the
    // last glyph, a glyph in the same cluster as the one after it has the same end.
    let mut ends = vec![text.len(); infos.len()];
    for at in (0..infos.len().saturating_sub(1)).rev() {
        let (cluster, next) = (infos[at].cluster, infos[at + 1].cluster);
        ends[at] = if next == cluster {
            ends[at + 1]
        } else {
            next as usize
        };
    }
    infos
        .iter()
        .zip(positions)
        .zip(ends)
        .map(|((info, position), end)| {
            let start = info.cluster as usize;
            let per_em = |units: i32| units as f32 / loaded.units_per_em;
            KrillaGlyph::new(
                GlyphId::new(info.glyph_id),
                per_em(position.x_advance),
                per_em(position.x_offset),
                per_em(position.y_offset),
                per_em(position.y_advance),
                offset + start..offset + end,
                None,
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_letter_with_many_accents_is_shaped() {
        let faces = Faces::new().expect("the fonts load");
        let text = format!("a{}", "\u{301}".repeat(70_000));
        let runs = faces.shape(&text, Typeface::Serif);
        assert!(!runs.is_empty());
    }

    #[test]
    fn a_letter_at_the_end_of_a_piece_is_shaped_with_its_accent() {
        let faces = Faces::new().expect("the fonts load");
        let glyphs = |text: &str| -> usize {
            let runs = faces.shape(text, Typeface::Serif);
            runs.iter().map(|run| run.glyphs.len()).sum()
        };
        let accented = "e\u{301}";
        let filler = "a".repeat(MOST_CHARACTERS_SHAPED_AT_ONCE - 1);
        assert_eq!(
            glyphs(&format!("{filler}{accented}")),
            filler.len() + glyphs(accented)
        );
    }
}
