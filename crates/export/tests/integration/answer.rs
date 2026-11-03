//! A document written as an HTML file, a Markdown file and a PDF.

use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use export::{Document, Format, write};

use crate::support;

#[test]
fn an_answer_is_written_whole_and_standalone_in_every_format() {
    let folder = tempfile::tempdir().expect("a temporary folder");
    for (format, file, check) in [
        (
            Format::Html,
            "answer.html",
            html_holds_the_whole_document_typeset_and_standalone as fn(&Path),
        ),
        (
            Format::Markdown,
            "answer.md",
            markdown_holds_the_whole_document_and_stands_alone,
        ),
        (
            Format::Pdf,
            "answer.pdf",
            pdf_holds_the_whole_document_with_its_pictures,
        ),
    ] {
        let path = folder.path().join(file);
        write(&support::answer_like(), format, &path).expect("the file is written");
        check(&path);
    }
}

fn html_holds_the_whole_document_typeset_and_standalone(path: &Path) {
    let html = support::text_of(path);
    assert!(html.starts_with("<!DOCTYPE html>"));
    assert!(html.contains("<title>Black–Scholes formula and its assumptions</title>"));
    for phrase in [
        "Question: How is the Black–Scholes formula derived?",
        "Why the hedge removes risk",
        "Price change per unit of the stock",
        "def call_price(spot, strike):",
        "Natenberg, chapter 1: Volatility, p. 5",
    ] {
        assert!(html.contains(phrase), "the page has no {phrase:?}");
    }

    // The inline formula and the formula set apart are pictures, and no LaTeX stays outside the
    // text that stands in for a picture.
    assert_eq!(html.matches("<img class=\"math\"").count(), 2);
    let mut without_alternatives = html.clone();
    for alternative in support::attribute_values(&html, "alt") {
        without_alternatives = without_alternatives.replace(&format!("alt=\"{alternative}\""), "");
    }
    assert!(!without_alternatives.contains("\\frac"));
    assert!(!without_alternatives.contains('$'));

    assert!(!html.contains("<link"));
    assert!(!html.contains("<script"));
    for address in support::attribute_values(&html, "src") {
        assert!(
            address.starts_with("data:"),
            "{address} must be inside the file"
        );
    }
    assert!(!html.contains("tests/integration"));
    assert!(!html.contains("http"));
}

fn markdown_holds_the_whole_document_and_stands_alone(path: &Path) {
    let text = support::text_of(path);
    let document = support::answer_like();
    assert!(text.starts_with(
        "# Black–Scholes formula and its assumptions\n\n> Question: How is the Black–Scholes formula derived?\n\n"
    ));
    assert!(
        text.contains(document.markdown.trim_end()),
        "the text is in the file as it was given"
    );
    assert!(text.ends_with(
        "\n## Sources\n\n- [1] Hull, chapter 2: Options, p. 7\n- [2] Natenberg, chapter 1: Volatility, p. 5\n"
    ));
    assert!(!text.contains("http"), "the file needs no network");
}

fn pdf_holds_the_whole_document_with_its_pictures(path: &Path) {
    assert!(std::fs::read(path).unwrap().starts_with(b"%PDF-"));
    let text = support::pdf_text(path);
    for phrase in [
        "Question:HowistheBlack–Scholesformuladerived?",
        "Black–Scholesformulaanditsassumptions",
        "Whythehedgeremovesrisk",
        "Thepriceofanoptionfollowsfromapartialdifferentialequation",
        "thevolatility",
        "isconstant.",
        "Delta",
        "Pricechangeperunitofthestock",
        "defcall_price(spot,strike):",
        "Sources",
        "Hull,chapter2:Options,p.7",
        "Natenberg,chapter1:Volatility,p.5",
    ] {
        assert!(
            text.contains(phrase),
            "the PDF has no {phrase:?} in {text:?}"
        );
    }
    assert!(!text.contains("\\frac"), "formulas are pictures, not LaTeX");
    assert!(
        support::pdf_pictures(path).len() >= 2,
        "the inline formula and the one set apart are pictures"
    );
}

/// The most pixels of pictures one file may place, as the writer promises it.
const BUDGET_PIXELS: u64 = 64_000_000;

#[test]
fn formulas_past_the_budget_are_written_as_their_source() {
    let folder = tempfile::tempdir().expect("a temporary folder");
    let write_text = |markdown: &str, format: Format, file: &str| {
        let document = Document {
            title: "Large formulas".to_owned(),
            markdown: markdown.to_owned(),
            ..Document::default()
        };
        let path = folder.path().join(file);
        write(&document, format, &path).expect("the file is written");
        path
    };

    // A picture over the limit for one picture is refused at both sizes, so only its source is
    // written.
    let huge = write_text(r"$\rule{84em}{84em}$", Format::Html, "huge.html");
    let html = support::text_of(&huge);
    assert_eq!(html.matches("<img class=\"math\"").count(), 0);
    assert_eq!(
        html.matches("<code class=\"math\">\\rule{84em}{84em}</code>")
            .count(),
        1
    );

    // Each use of a medium formula places a picture until the budget of the file is spent, and
    // the repeats from the cache count like any other use.
    let uses = 30;
    let markdown = r"$\rule{20em}{20em}$ ".repeat(uses);
    let path = write_text(&markdown, Format::Html, "medium.html");
    let html = support::text_of(&path);
    let address = support::attribute_values(&html, "src")
        .into_iter()
        .next()
        .expect("the first formula is a picture");
    let picture = STANDARD
        .decode(address.strip_prefix("data:image/png;base64,").unwrap())
        .expect("the picture is base64");
    // A PNG holds its width and height as two numbers at bytes 16 to 24.
    let side = |from: usize| u32::from_be_bytes(picture[from..from + 4].try_into().unwrap());
    let (width, height) = (side(16), side(20));
    let area = u64::from(width) * u64::from(height);
    assert!(
        area < 4_000_000,
        "the formula is under the limit for one picture"
    );
    let placed = (BUDGET_PIXELS / area) as usize;
    assert!(
        placed < uses,
        "the budget must run out before the last use: {width} by {height} pixels to a picture"
    );

    assert_eq!(html.matches("<img class=\"math\"").count(), placed);
    assert_eq!(
        html.matches("<code class=\"math\">\\rule{20em}{20em}</code>")
            .count(),
        uses - placed
    );
    assert!(
        html.len() < 4 << 20,
        "the page is {} bytes, and a rule packs to about 110 KB",
        html.len()
    );

    let path = write_text(&markdown, Format::Pdf, "medium.pdf");
    assert!(std::fs::read(&path).unwrap().starts_with(b"%PDF-"));
    let sources = support::pdf_text(&path)
        .matches(r"\rule{20em}{20em}")
        .count();
    assert_eq!(sources, uses - placed);
}
