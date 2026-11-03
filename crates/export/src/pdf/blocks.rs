//! The parts of a document as chunks of a page: the title, the origin, a formula set apart, code
//! on a bed, and the list of sources. The text between them is read in `pieces`.

use super::TEXT_WIDTH;
use super::faces::Typeface;
use super::flow::{Align, BODY, Layout, Look, SMALL, formula_picture, keep_lines_together};
use super::pages::{Chunk, INK_BED, INK_TEXT, Item};
use super::pieces::{ITEM_AFTER, space};
use super::read::Span;
use crate::math::Display;
use crate::{Document, Source};

const TITLE_AFTER: f32 = 8.0;
const ORIGIN_AFTER: f32 = 16.0;
const DISPLAY_FORMULA_EM: f32 = 11.0 * 1.25;
/// A formula set apart takes at most this share of the height of a page.
const FORMULA_MAX_SHARE: f32 = 0.45;
/// The room above and below a formula.
const BLOCK_ROOM: f32 = 8.0;
const CODE_SIZE: f32 = 8.5;
const CODE_LEADING: f32 = 11.5;
const CODE_PADDING: f32 = 6.0;
const LANGUAGE_SIZE: f32 = 7.5;
/// The least room between the end of a line of code and the language beside it.
const LANGUAGE_GAP: f32 = 12.0;
/// How far the code moves down when the language needs a row of its own.
const LANGUAGE_ROW: f32 = LANGUAGE_SIZE + 3.0;
const SOURCE_MARK_WIDTH: f32 = 24.0;

impl Layout<'_> {
    pub(super) fn document(&mut self, document: &Document) -> Vec<Chunk> {
        let mut chunks = Vec::new();
        let mut title = self.set(
            &[Span::text(&document.title)],
            Look::new(20.0, 26.0).strong(),
            (0.0, TEXT_WIDTH),
            Align::Left,
        );
        space(&mut title, 0.0, TITLE_AFTER);
        chunks.extend(title);
        if !document.origin.is_empty() {
            let mut origin = self.set(
                &[Span::text(&document.origin)],
                BODY.italic().secondary(),
                (0.0, TEXT_WIDTH),
                Align::Left,
            );
            space(&mut origin, 0.0, ORIGIN_AFTER);
            chunks.extend(origin);
        }
        chunks.extend(self.markdown(&document.markdown));
        if !document.sources.is_empty() {
            chunks.extend(self.sources(&document.sources));
        }
        chunks
    }

    /// A formula set apart. A formula that cannot be typeset is shown as its LaTeX in code type.
    pub(super) fn formula(&mut self, latex: &str) -> Vec<Chunk> {
        let Some(formula) = self.formulas.get(latex, Display::Block) else {
            let mut chunks = self.set(&[Span::code(latex)], BODY, (0.0, TEXT_WIDTH), Align::Left);
            space(&mut chunks, BLOCK_ROOM, BLOCK_ROOM);
            return chunks;
        };
        let em = DISPLAY_FORMULA_EM;
        let whole_width = formula.picture_width_em() as f32 * em;
        let whole_height = formula.picture_height_em() as f32 * em;
        let scale = (TEXT_WIDTH / whole_width)
            .min(super::CONTENT_HEIGHT * FORMULA_MAX_SHARE / whole_height)
            .min(1.0);
        let em = em * scale;
        let ascent = formula.ascent_em as f32 * em;
        let bleed = formula.bleed_em as f32 * em;
        let baseline = bleed + ascent;
        let width = formula.width_em as f32 * em;
        // Centred, but never past the right margin.
        let left = ((TEXT_WIDTH - width) / 2.0).min(TEXT_WIDTH - width - bleed);
        let items: Vec<Item> = formula_picture(&formula, em, (left, baseline))
            .into_iter()
            .collect();
        let height = formula.picture_height_em() as f32 * em;
        let mut chunk = Chunk::new(height, items);
        chunk.before = BLOCK_ROOM;
        chunk.after = BLOCK_ROOM;
        vec![chunk]
    }

    /// Code on a grey bed, one line of the bed to a chunk so that a long listing can run over a
    /// page. A line that is wider than the bed is wrapped at a character.
    pub(super) fn code(&mut self, code: &str, language: Option<&str>) -> Vec<Chunk> {
        let advance = self.faces.width("0", Typeface::Code, CODE_SIZE);
        let inner_width = TEXT_WIDTH - 2.0 * CODE_PADDING;
        let per_row = ((inner_width / advance) as usize).max(1);
        let rows = wrap_code(code, per_row);
        let (rise, fall) = self.faces.extent(Typeface::Code);
        let baseline = (CODE_LEADING - (rise + fall) * CODE_SIZE) / 2.0 + rise * CODE_SIZE;
        let language = language.filter(|language| !language.is_empty());
        // The language stands at the right end of the first line, or on a row of its own above
        // it when the line would reach it.
        let tag_row = language.map_or(0.0, |language| {
            let tag_width = self.faces.width(language, Typeface::Serif, LANGUAGE_SIZE);
            let first_width = rows
                .first()
                .map_or(0.0, |row| self.faces.width(row, Typeface::Code, CODE_SIZE));
            if first_width + LANGUAGE_GAP + tag_width > inner_width {
                LANGUAGE_ROW
            } else {
                0.0
            }
        });
        let count = rows.len();
        let mut chunks: Vec<Chunk> = Vec::with_capacity(count);
        for (at, row) in rows.iter().enumerate() {
            let top_padding = if at == 0 { CODE_PADDING + tag_row } else { 0.0 };
            let bottom_padding = if at + 1 == count { CODE_PADDING } else { 0.0 };
            let height = top_padding + CODE_LEADING + bottom_padding;
            let mut items = vec![Item::Bed {
                x: 0.0,
                y: 0.0,
                width: TEXT_WIDTH,
                height,
                ink: INK_BED,
            }];
            if at == 0
                && let Some(language) = language
            {
                let tag = BODY.secondary();
                let tag = Look {
                    size: LANGUAGE_SIZE,
                    ..tag
                };
                let width = self.faces.width(language, Typeface::Serif, LANGUAGE_SIZE);
                let at_x = TEXT_WIDTH - CODE_PADDING - width;
                self.draw_text(
                    language,
                    tag,
                    (at_x, CODE_PADDING + LANGUAGE_SIZE),
                    &mut items,
                );
            }
            let mut x = CODE_PADDING;
            for run in self.faces.shape(row, Typeface::Code) {
                let width = run.width(CODE_SIZE);
                items.push(Item::Glyphs {
                    x,
                    y: top_padding + baseline,
                    run,
                    size: CODE_SIZE,
                    ink: INK_TEXT,
                });
                x += width;
            }
            chunks.push(Chunk::new(height, items));
        }
        keep_lines_together(&mut chunks);
        space(&mut chunks, 4.0, 8.0);
        chunks
    }

    fn sources(&mut self, sources: &[Source]) -> Vec<Chunk> {
        let mut chunks = self.heading(2, &[Span::text("Sources")]);
        let look = SMALL;
        for source in sources {
            let marker = format!("[{}]", source.number);
            let spans = [Span::text(&source.text)];
            let mut item = self.hanging(&marker, &spans, look, (0.0, SOURCE_MARK_WIDTH));
            space(&mut item, 0.0, ITEM_AFTER);
            chunks.extend(item);
        }
        chunks
    }
}

/// The lines of the code, each cut into rows of at most `per_row` characters.
fn wrap_code(code: &str, per_row: usize) -> Vec<String> {
    let mut rows = Vec::new();
    for line in code.trim_end_matches('\n').split('\n') {
        let line = line.trim_end_matches('\r').replace('\t', "    ");
        let characters: Vec<char> = line.chars().collect();
        if characters.is_empty() {
            rows.push(String::new());
        }
        for row in characters.chunks(per_row) {
            rows.push(row.iter().collect());
        }
    }
    rows
}
