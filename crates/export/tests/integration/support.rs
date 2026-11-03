//! The documents the tests write, and the ways to read a written file back.

use std::path::Path;

use export::{Document, Source};
use lopdf::Object;

/// An answer with a heading, a formula in the text and one set apart, a table, a code listing
/// and two sources.
pub fn answer_like() -> Document {
    let markdown = "The price of an option follows from a *partial differential equation* once \
        the `Delta` hedge removes risk, where the volatility $\\sigma$ is constant.\n\n\
        ## Why the hedge removes risk\n\n\
        $$\n\\frac{\\partial V}{\\partial t} + \\frac{1}{2}\\sigma^2 S^2 \\frac{\\partial^2 V}{\\partial S^2} + rS \\frac{\\partial V}{\\partial S} - rV = 0\n$$\n\n\
        | Greek | Measures |\n| --- | --- |\n| Delta | Price change per unit of the stock |\n| Vega | Price change per unit of volatility |\n\n\
        ```python\ndef call_price(spot, strike):\n    return max(spot - strike, 0) if spot > 0 else 0\n```\n";
    Document {
        title: "Black–Scholes formula and its assumptions".to_owned(),
        origin: "Question: How is the Black–Scholes formula derived?".to_owned(),
        markdown: markdown.to_owned(),
        sources: vec![
            Source {
                number: 1,
                text: "Hull, chapter 2: Options, p. 7".to_owned(),
            },
            Source {
                number: 2,
                text: "Natenberg, chapter 1: Volatility, p. 5".to_owned(),
            },
        ],
    }
}

/// All the text of a PDF with every space and line break taken out, because the reader joins two
/// lines with nothing between them.
pub fn pdf_text(path: &Path) -> String {
    let pdf = open_pdf(path);
    let pages: Vec<u32> = pdf.get_pages().keys().copied().collect();
    let text = pdf.extract_text(&pages).expect("the pages have text");
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

/// The width and the height in pixels of every picture the PDF holds.
pub fn pdf_pictures(path: &Path) -> Vec<(i64, i64)> {
    let pdf = open_pdf(path);
    pdf.objects
        .values()
        .filter_map(|object| {
            let Object::Stream(stream) = object else {
                return None;
            };
            let is_picture = stream
                .dict
                .get(b"Subtype")
                .and_then(Object::as_name)
                .is_ok_and(|name| name == b"Image");
            let side = |key: &[u8]| stream.dict.get(key).and_then(Object::as_i64).ok();
            if !is_picture {
                return None;
            }
            Some((side(b"Width")?, side(b"Height")?))
        })
        .collect()
}

fn open_pdf(path: &Path) -> lopdf::Document {
    let bytes = std::fs::read(path).expect("the PDF can be read");
    lopdf::Document::load_mem(&bytes).expect("the PDF opens")
}

pub fn text_of(path: &Path) -> String {
    std::fs::read_to_string(path).expect("the file can be read")
}

/// The text between the quotes of every `attribute="…"` in the file, for each place the file
/// has it.
pub fn attribute_values(html: &str, attribute: &str) -> Vec<String> {
    let opener = format!("{attribute}=\"");
    html.match_indices(&opener)
        .map(|(at, _)| {
            let rest = &html[at + opener.len()..];
            rest[..rest.find('"').expect("the attribute is closed")].to_owned()
        })
        .collect()
}
