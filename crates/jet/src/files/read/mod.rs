//! Reads one file inside the reader process: its details when it arrives, and its contents when
//! Jet asks for them. PDFs read by page, workbooks and CSV by row, other text by line, and
//! pictures as one JPEG small enough for the model.

mod excerpt;
mod pdf;
mod picture;
mod text;
mod workbook;

use serde::{Deserialize, Serialize};

use super::kind::FileKind;
use excerpt::{Wanted, read_lines};
use text::{counted, csv_columns, csv_rows, decode, html_title};

/// Why a file could not be read. Each one makes the reader refuse the file, except a missing sheet,
/// which is the asker's mistake and goes back to Jet as a message.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ReadError {
    #[error("not a readable PDF: {0}")]
    Pdf(#[from] pdf_extract::Error),
    #[error("the text of a PDF page could not be read: {0}")]
    PdfText(#[from] pdf_extract::OutputError),
    #[error("not a readable workbook: {0}")]
    Workbook(#[from] calamine::XlsxError),
    #[error("not a readable picture: {0}")]
    Picture(#[from] image::ImageError),
    #[error("the picture could not be read: {0}")]
    PictureBytes(#[from] std::io::Error),
    #[error("there is no sheet {asked:?}; the sheets are {sheets}")]
    NoSuchSheet { asked: String, sheets: String },
    #[error("the picture could not be encoded: {0}")]
    Encode(#[source] image::ImageError),
}

/// Which part of a file to read. Missing numbers mean the beginning and the usual length.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Range {
    pub sheet: Option<String>,
    /// The first page, row or line, counted from 1.
    pub start: Option<usize>,
    pub count: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Unit {
    Pages,
    Rows,
    Lines,
}

/// What a read gave back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum Reading {
    Text {
        text: String,
        unit: Unit,
        start: usize,
        /// The last unit in `text`. Read again from `end + 1` while `more` is true.
        end: usize,
        total: usize,
        more: bool,
        /// The sheets of a workbook, empty for anything else.
        sheets: Vec<String>,
    },
    Image {
        /// The picture as a JPEG, in base64.
        data: String,
        width: u32,
        height: u32,
    },
}

/// The details line of a file: `12 pages`, `3 sheets: Prices 1,204 × 6, Notes 12 × 2, Q3 40 × 9`,
/// `1,204 rows × 6 columns`, `320 lines`, `1600 × 900 px`.
///
/// # Errors
/// [`ReadError`] when the file is not what its kind says.
pub(crate) fn describe(kind: FileKind, bytes: &[u8]) -> Result<String, ReadError> {
    match kind {
        FileKind::Pdf => pdf::describe(bytes),
        FileKind::Xlsx => workbook::describe(bytes),
        FileKind::Csv => {
            let text = decode(bytes);
            let (mut rows, mut columns) = (0, 0);
            for row in csv_rows(&text) {
                rows += 1;
                columns = columns.max(csv_columns(row));
            }
            Ok(format!(
                "{} × {}",
                counted(rows, "row"),
                counted(columns, "column")
            ))
        }
        FileKind::Markdown | FileKind::Text => Ok(counted(decode(bytes).lines().count(), "line")),
        FileKind::Html => {
            let text = decode(bytes);
            let lines = counted(text.lines().count(), "line");
            Ok(match html_title(&text) {
                Some(title) => format!("{lines} · “{title}”"),
                None => lines,
            })
        }
        FileKind::Png | FileKind::Jpeg | FileKind::Gif | FileKind::Webp => picture::describe(bytes),
    }
}

/// Reads the part of the file that `range` asks for.
///
/// # Errors
/// [`ReadError`] when the file is not what its kind says, or the sheet asked for is missing.
pub(crate) fn read(kind: FileKind, bytes: &[u8], range: &Range) -> Result<Reading, ReadError> {
    let wanted = Wanted::new(kind, range);
    match kind {
        FileKind::Pdf => pdf::read(bytes, wanted),
        FileKind::Xlsx => workbook::read(bytes, range.sheet.as_deref(), wanted),
        FileKind::Csv => Ok(read_lines(csv_rows(&decode(bytes)), Unit::Rows, wanted)),
        FileKind::Markdown | FileKind::Html | FileKind::Text => {
            Ok(read_lines(decode(bytes).lines(), Unit::Lines, wanted))
        }
        FileKind::Png | FileKind::Jpeg | FileKind::Gif | FileKind::Webp => picture::read(bytes),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use base64::Engine;
    use export::{Block, Document, Format};
    use image::{DynamicImage, ImageFormat};

    use super::*;

    const SHEET: &[u8] = include_bytes!("../../../tests/fixtures/uploads/sheet.xlsx");

    fn picture(width: u32, height: u32, format: ImageFormat) -> Vec<u8> {
        let canvas = if format == ImageFormat::Jpeg {
            DynamicImage::new_rgb8(width, height)
        } else {
            DynamicImage::new_rgba8(width, height)
        };
        let mut bytes = Vec::new();
        canvas
            .write_to(&mut Cursor::new(&mut bytes), format)
            .unwrap();
        bytes
    }

    fn pdf() -> Vec<u8> {
        let document = Document {
            title: "Quarterly note".into(),
            origin: String::new(),
            blocks: vec![Block::Text {
                markdown: "Volatility smiles slope downward.".into(),
                cites: Vec::new(),
            }],
            sources: Vec::new(),
        };
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("note.pdf");
        export::write(&document, Format::Pdf, &path).unwrap();
        std::fs::read(path).unwrap()
    }

    fn text_of(
        kind: FileKind,
        bytes: &[u8],
        range: &Range,
    ) -> (String, Unit, usize, usize, usize, bool, Vec<String>) {
        match read(kind, bytes, range).unwrap() {
            Reading::Text {
                text,
                unit,
                start,
                end,
                total,
                more,
                sheets,
            } => (text, unit, start, end, total, more, sheets),
            Reading::Image { .. } => panic!("{kind:?} read as a picture"),
        }
    }

    fn jpeg_size(reading: Reading) -> (u32, u32, u32, u32, [u8; 3]) {
        let Reading::Image {
            data,
            width,
            height,
        } = reading
        else {
            panic!("a picture reads as a picture");
        };
        let jpeg = base64::engine::general_purpose::STANDARD
            .decode(data)
            .unwrap();
        assert!(jpeg.starts_with(b"\xff\xd8\xff"), "the reading is a JPEG");
        let decoded = image::load_from_memory(&jpeg).unwrap().to_rgb8();
        (
            width,
            height,
            decoded.width(),
            decoded.height(),
            decoded.get_pixel(0, 0).0,
        )
    }

    #[test]
    fn every_kind_is_described_and_read() {
        let whole = Range::default();

        let pdf = pdf();
        assert_eq!(describe(FileKind::Pdf, &pdf).unwrap(), "1 page");
        let (text, unit, _, end, total, more, _) = text_of(FileKind::Pdf, &pdf, &whole);
        assert!(text.starts_with("--- page 1 ---\n"), "{text}");
        assert!(text.contains("Volatility smiles slope downward"), "{text}");
        assert_eq!((unit, end, total, more), (Unit::Pages, 1, 1, false));

        assert_eq!(
            describe(FileKind::Xlsx, SHEET).unwrap(),
            "2 sheets: Prices 4 × 3, Notes 2 × 1"
        );
        let (text, unit, _, end, total, more, sheets) = text_of(FileKind::Xlsx, SHEET, &whole);
        assert_eq!(
            text,
            "Ticker,Price,Volume\nACME,101.5,12\n\"Globex, Inc.\",87.25,7\nInitech,230,3"
        );
        assert_eq!((unit, end, total, more), (Unit::Rows, 4, 4, false));
        assert_eq!(sheets, ["Prices", "Notes"]);
        let notes = Range {
            sheet: Some("Notes".into()),
            ..Range::default()
        };
        assert_eq!(
            text_of(FileKind::Xlsx, SHEET, &notes).0,
            "Prices are closing prices.\nChecked on Friday."
        );
        let missing = Range {
            sheet: Some("Costs".into()),
            ..Range::default()
        };
        let error = read(FileKind::Xlsx, SHEET, &missing)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("\"Costs\"") && error.contains("\"Prices\", \"Notes\""),
            "{error}"
        );

        let csv = b"name,qty\r\nAcme,\"1,5\"\r\n\"multi\nline\",3\r\ncaf\xe9,4\r\n";
        assert_eq!(describe(FileKind::Csv, csv).unwrap(), "4 rows × 2 columns");
        let (text, unit, _, end, total, more, _) = text_of(FileKind::Csv, csv, &whole);
        assert!(
            text.contains("\"multi\nline\",3") && text.contains("caf\u{fffd},4"),
            "{text:?}"
        );
        assert_eq!((unit, end, total, more), (Unit::Rows, 4, 4, false));

        let long: String = (1..=1200).map(|n| format!("line {n}\n")).collect();
        assert_eq!(
            describe(FileKind::Text, long.as_bytes()).unwrap(),
            "1,200 lines"
        );
        let (text, unit, start, end, total, more, _) =
            text_of(FileKind::Text, long.as_bytes(), &whole);
        assert!(
            text.starts_with("line 1\n") && text.ends_with("line 500"),
            "{text}"
        );
        assert_eq!(
            (unit, start, end, total, more),
            (Unit::Lines, 1, 500, 1200, true)
        );
        let rest = Range {
            start: Some(501),
            count: Some(800),
            ..Range::default()
        };
        let (text, _, _, end, _, more, _) = text_of(FileKind::Text, long.as_bytes(), &rest);
        assert!(text.starts_with("line 501\n") && text.ends_with("line 1200"));
        assert_eq!((end, more), (1200, false));
        let past = Range {
            start: Some(5000),
            ..Range::default()
        };
        let (text, _, _, end, _, more, _) = text_of(FileKind::Text, long.as_bytes(), &past);
        assert_eq!((text.as_str(), end, more), ("", 1200, false));

        let wide: String = "x".repeat(60_000);
        let (text, _, _, end, _, more, _) = text_of(FileKind::Text, wide.as_bytes(), &whole);
        assert_eq!(
            (text.chars().count(), end, more),
            (40_000, 1, false),
            "a reading is cut to its limit"
        );

        assert_eq!(
            describe(FileKind::Markdown, b"# Title\n\nbody\n").unwrap(),
            "3 lines"
        );
        assert_eq!(
            text_of(FileKind::Markdown, b"# Title\n\nbody\n", &whole).0,
            "# Title\n\nbody"
        );

        let page =
            b"<html><head><title>  Weekly\n   report </title></head>\n<body>hi</body></html>";
        assert_eq!(
            describe(FileKind::Html, page).unwrap(),
            "3 lines · “Weekly report”"
        );
        assert_eq!(text_of(FileKind::Html, page, &whole).4, 3);

        for (kind, format) in [
            (FileKind::Png, ImageFormat::Png),
            (FileKind::Jpeg, ImageFormat::Jpeg),
            (FileKind::Gif, ImageFormat::Gif),
            (FileKind::Webp, ImageFormat::WebP),
        ] {
            let bytes = picture(64, 32, format);
            assert_eq!(describe(kind, &bytes).unwrap(), "64 × 32 px", "{kind:?}");
            let (width, height, jpeg_width, jpeg_height, corner) =
                jpeg_size(read(kind, &bytes, &whole).unwrap());
            assert_eq!(
                (width, height, jpeg_width, jpeg_height),
                (64, 32, 64, 32),
                "{kind:?}"
            );
            if kind != FileKind::Jpeg {
                assert!(
                    corner.iter().all(|&channel| channel > 240),
                    "{kind:?}: see-through pixels are laid on white, got {corner:?}"
                );
            }
        }

        let strip = picture(2000, 8, ImageFormat::Png);
        assert_eq!(describe(FileKind::Png, &strip).unwrap(), "2000 × 8 px");
        let (width, height, jpeg_width, jpeg_height, _) =
            jpeg_size(read(FileKind::Png, &strip, &whole).unwrap());
        assert_eq!(
            (width, height, jpeg_width, jpeg_height),
            (2000, 8, 1568, 6),
            "a long side is scaled to fit"
        );
    }
}
