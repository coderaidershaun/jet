//! PDFs: how many pages, and the plain text of a run of pages.

use pdf_extract::{Document, PlainTextOutput};

use super::excerpt::{Excerpt, Wanted};
use super::text::counted;
use super::{ReadError, Reading, Unit};

/// The document, decrypted with the empty password when it is encrypted, as most PDFs that are
/// only protected against printing or copying are.
fn open(bytes: &[u8]) -> Result<Document, ReadError> {
    let mut document = Document::load_mem(bytes)?;
    if document.is_encrypted() {
        document.decrypt("")?;
    }
    Ok(document)
}

/// `12 pages`.
pub(super) fn describe(bytes: &[u8]) -> Result<String, ReadError> {
    Ok(counted(open(bytes)?.get_pages().len(), "page"))
}

pub(super) fn read(bytes: &[u8], wanted: Wanted) -> Result<Reading, ReadError> {
    let document = open(bytes)?;
    let total = document.get_pages().len();
    let mut excerpt = Excerpt::new(wanted);
    for number in (wanted.start..=total).take(wanted.count) {
        if excerpt.is_full {
            break;
        }
        let mut page = String::new();
        pdf_extract::output_doc_page(
            &document,
            &mut PlainTextOutput::new(&mut page),
            u32::try_from(number).unwrap_or(u32::MAX),
        )?;
        excerpt.push(
            number,
            "\n\n",
            &format!("--- page {number} ---\n{}", page.trim()),
        );
    }
    Ok(excerpt.into_reading(Unit::Pages, total, Vec::new()))
}
