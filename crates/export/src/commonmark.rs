//! The one way the Markdown of a document is read, so that the HTML and the PDF agree on what a
//! paragraph, a table, a formula and a footnote are.

use pulldown_cmark::{Options, Parser};

pub(crate) fn parse(markdown: &str) -> Parser<'_> {
    Parser::new_ext(
        markdown,
        Options::ENABLE_TABLES | Options::ENABLE_MATH | Options::ENABLE_FOOTNOTES,
    )
}
