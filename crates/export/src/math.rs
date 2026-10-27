//! Typesets a formula as a picture of black ink on a clear ground. It is the only module that
//! talks to the typesetting library. A file keeps the formulas it has made, so a formula that
//! comes twice is typeset once.

use std::cell::OnceCell;
use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::rc::Rc;

use krilla::image::Image;
use ratex_layout::{LayoutOptions, layout, to_display_list};
use ratex_parser::{ParseError, parser::parse};
use ratex_render::{RenderOptions, render_to_png};
use ratex_types::color::Color;
use ratex_types::display_item::DisplayList;
use ratex_types::math_style::MathStyle;

/// Pixels to the em of a picture: about 600 dots to the inch at the size of the body text.
const EM_PX: u16 = 96;
/// The size a formula is tried at once more when the first picture would be too large.
const SMALLER_EM_PX: u16 = 48;
const MAX_LATEX_BYTES: usize = 4096;
const MAX_PICTURE_SIDE: u32 = 8192;
/// The most pixels one picture may have, margin included. Drawing a picture takes memory and time
/// in proportion to its pixels, however empty it looks.
const MAX_PICTURE_PIXELS: u64 = 4_000_000;
/// The most pixels of pictures one file may place, every use counted. Without it, a few hundred
/// characters of Markdown that repeat a large formula make a page of hundreds of megabytes.
const MAX_PLACED_PIXELS: u64 = 64_000_000;
const SOFT_HYPHEN: char = '\u{ad}';
const BLEED_EM: f64 = 0.1;
const MIN_BLEED_PX: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Display {
    Inline,
    Block,
}

/// A typeset formula. The lengths in em are those of the box of the formula. The picture is that
/// box and a clear margin of `bleed_em` on every side, because ink reaches a little outside the
/// box.
pub(crate) struct Formula {
    pub(crate) png: Vec<u8>,
    /// The pixels of the whole picture, margin included.
    pixels: u64,
    pub(crate) width_em: f64,
    pub(crate) ascent_em: f64,
    pub(crate) descent_em: f64,
    pub(crate) bleed_em: f64,
    /// The picture as the PDF writer holds it, made at the first use so that every use of the
    /// formula shares one decoded picture. `None` when the picture cannot be read.
    pub(crate) pdf_image: OnceCell<Option<Image>>,
}

impl Formula {
    /// The whole picture's width in em, margin included.
    pub(crate) fn picture_width_em(&self) -> f64 {
        self.width_em + 2.0 * self.bleed_em
    }

    pub(crate) fn picture_height_em(&self) -> f64 {
        self.ascent_em + self.descent_em + 2.0 * self.bleed_em
    }
}

/// The formulas of one file, each typeset once. `None` stands for a formula that cannot be
/// typeset: the file then shows its LaTeX.
#[derive(Default)]
pub(crate) struct Formulas {
    made: HashMap<(String, Display), Option<Rc<Formula>>>,
    placed_pixels: u64,
}

impl Formulas {
    /// The picture of a formula for one more place in the file, or `None` when the file must show
    /// its LaTeX there: the formula cannot be typeset, or its picture would take the file past
    /// `MAX_PLACED_PIXELS`.
    pub(crate) fn get(&mut self, latex: &str, display: Display) -> Option<Rc<Formula>> {
        let room = MAX_PLACED_PIXELS - self.placed_pixels;
        // The room only shrinks, so a formula left out for lack of room stays out.
        let formula = self
            .made
            .entry((latex.to_owned(), display))
            .or_insert_with(|| {
                typeset_safely(latex, display, room.min(MAX_PICTURE_PIXELS)).map(Rc::new)
            })
            .clone()?;
        if formula.pixels > room {
            return None;
        }
        self.placed_pixels += formula.pixels;
        Some(formula)
    }
}

/// The typesetting library can panic on a formula it does not expect, and no formula is a reason
/// to stop writing a file.
fn typeset_safely(latex: &str, display: Display, max_pixels: u64) -> Option<Formula> {
    catch_unwind(AssertUnwindSafe(|| {
        typeset(latex, display, EM_PX, max_pixels)
            .or_else(|| typeset(latex, display, SMALLER_EM_PX, max_pixels))
    }))
    .ok()
    .flatten()
}

fn typeset(latex: &str, display: Display, em_px: u16, max_pixels: u64) -> Option<Formula> {
    let made = typeset_png(latex, display, em_px, max_pixels).ok()?;
    Some(Formula {
        png: made.png,
        pixels: made.pixels,
        width_em: made.width_em,
        ascent_em: made.ascent_em,
        descent_em: made.descent_em,
        bleed_em: f64::from(made.bleed_px) / f64::from(em_px),
        pdf_image: OnceCell::new(),
    })
}

/// A formula as a PNG: the lengths in em are those of its box, and the picture is that box and a
/// clear margin of `bleed_px` pixels on every side, because ink reaches a little outside the box.
struct TypesetPng {
    png: Vec<u8>,
    pixels: u64,
    width_em: f64,
    ascent_em: f64,
    descent_em: f64,
    bleed_px: u32,
}

#[derive(Debug, thiserror::Error)]
enum TypesetError {
    #[error("the formula is empty")]
    Empty,
    #[error("the formula is {bytes} bytes long, and the limit is {limit}", limit = MAX_LATEX_BYTES)]
    TooLong { bytes: usize },
    #[error("the formula cannot be read")]
    Parse {
        #[from]
        source: ParseError,
    },
    #[error(
        "the box of the formula is not a size: {width_em} em wide, {ascent_em} em above the baseline and {descent_em} em below it"
    )]
    BoxSize {
        width_em: f64,
        ascent_em: f64,
        descent_em: f64,
    },
    #[error("the picture would be {width_px} by {height_px} pixels, and the limit is {limit}")]
    TooLarge {
        width_px: u64,
        height_px: u64,
        limit: u32,
    },
    #[error("the picture would be {pixels} pixels, and the limit is {limit}")]
    TooManyPixels { pixels: u64, limit: u64 },
    #[error("the picture cannot be drawn: {message}")]
    Raster { message: String },
}

/// Typesets `latex` at `em_px` pixels to the em, as black ink. A picture with a side over
/// `MAX_PICTURE_SIDE`, or with more than `max_pixels` pixels, is refused before one pixel of it
/// is made.
fn typeset_png(
    latex: &str,
    display: Display,
    em_px: u16,
    max_pixels: u64,
) -> Result<TypesetPng, TypesetError> {
    let list = lay_out(latex, display)?;
    // Negative space alone has a box narrower than nothing, and no caller can lay that out.
    let is_length = |length: f64| length.is_finite() && length >= 0.0;
    if ![list.width, list.height, list.depth]
        .into_iter()
        .all(is_length)
    {
        return Err(TypesetError::BoxSize {
            width_em: list.width,
            ascent_em: list.height,
            descent_em: list.depth,
        });
    }
    let bleed_px = ((BLEED_EM * f64::from(em_px)).ceil() as u32).max(MIN_BLEED_PX);
    let margin = 2 * u64::from(bleed_px);
    let pixels =
        |length_em: f64| ((length_em * f64::from(em_px)).ceil() as u64).saturating_add(margin);
    let (width_px, height_px) = (pixels(list.width), pixels(list.height + list.depth));
    check_size(width_px, height_px, max_pixels)?;
    let options = RenderOptions {
        font_size: f32::from(em_px),
        padding: bleed_px as f32,
        background_color: Color::new(0.0, 0.0, 0.0, 0.0),
        font_dir: String::new(),
        device_pixel_ratio: 1.0,
    };
    let png = render_to_png(&list, &options).map_err(|message| TypesetError::Raster { message })?;
    Ok(TypesetPng {
        png,
        pixels: width_px * height_px,
        width_em: list.width,
        ascent_em: list.height,
        descent_em: list.depth,
        bleed_px,
    })
}

fn check_size(width_px: u64, height_px: u64, max_pixels: u64) -> Result<(), TypesetError> {
    let limit = MAX_PICTURE_SIDE;
    if width_px > u64::from(limit) || height_px > u64::from(limit) {
        return Err(TypesetError::TooLarge {
            width_px,
            height_px,
            limit,
        });
    }
    let pixels = width_px * height_px;
    if pixels > max_pixels {
        return Err(TypesetError::TooManyPixels {
            pixels,
            limit: max_pixels,
        });
    }
    Ok(())
}

/// Soft hyphens are dropped, because the typesetting library would answer them with a slow scan
/// of the fonts of the system.
fn lay_out(latex: &str, display: Display) -> Result<DisplayList, TypesetError> {
    let without_hyphens: String = latex.chars().filter(|&c| c != SOFT_HYPHEN).collect();
    let latex = without_hyphens.trim();
    if latex.is_empty() {
        return Err(TypesetError::Empty);
    }
    if latex.len() > MAX_LATEX_BYTES {
        return Err(TypesetError::TooLong { bytes: latex.len() });
    }
    let nodes = parse(latex)?;
    let style = match display {
        Display::Block => MathStyle::Display,
        Display::Inline => MathStyle::Text,
    };
    let options = LayoutOptions::default()
        .with_style(style)
        .with_color(Color::BLACK);
    Ok(to_display_list(&layout(&nodes, &options)))
}
