//! A document as one HTML file that stands alone: one inline style sheet, each formula as one
//! picture inside the file that every use of it shows, nothing loaded from outside and nothing run.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use pulldown_cmark::{CowStr, Event, HeadingLevel, Tag, TagEnd, html::push_html};

use std::collections::HashMap;

use crate::commonmark;
use crate::math::{Display, Formulas};
use crate::{Document, Source};

/// Fonts are named and not carried: a reader without them gets a serif or a monospace font of
/// their own.
const STYLE: &str = r#"
body { margin: 0; background: #fff; color: #1c1c1c; font: 17px/1.6 Literata, "Iowan Old Style", Georgia, serif; }
article { max-width: 42rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
h1 { margin: 0 0 .5rem; font-size: 1.9rem; line-height: 1.25; }
h2 { margin: 2rem 0 .5rem; font-size: 1.3rem; line-height: 1.3; }
p { margin: 0 0 1rem; }
.origin { margin-bottom: 2rem; color: #666; font-style: italic; }
a.cite { color: #666; text-decoration: none; }
code, pre { font-family: "Source Code Pro", ui-monospace, Menlo, monospace; }
code { font-size: .92em; }
pre { margin: 0; padding: .75rem 1rem; overflow-x: auto; border-radius: 4px; background: #f4f4f4; font-size: .85rem; line-height: 1.45; }
pre code { font-size: inherit; }
svg.math { font-size: 1.12em; }
.display-math { display: block; margin: 1rem 0; text-align: center; }
.display-math svg.math, figure.formula svg.math { max-width: 100%; height: auto; font-size: 1.25em; }
svg.pictures { position: absolute; width: 0; height: 0; }
.points { margin: 0 0 1rem; padding-left: 1.4rem; }
.points li { margin-bottom: .25rem; }
table { border-collapse: collapse; margin: 0 auto; font-size: .95rem; line-height: 1.4; }
th, td { padding: .2rem .8rem; text-align: left; }
thead tr { border-top: 2px solid #444; border-bottom: 1px solid #444; }
tbody tr:last-child { border-bottom: 2px solid #444; }
figure { margin: 1.5rem 0; }
figure > img { display: block; max-width: 100%; height: auto; margin: 0 auto; }
figcaption { margin-top: .5rem; color: #666; font-size: .9rem; font-style: italic; text-align: center; }
figure.table figcaption { margin: 0 0 .5rem; }
figure.formula { text-align: center; }
figure.formula .label { float: right; color: #666; }
figure.code { position: relative; }
figure.code .language { position: absolute; top: .3rem; right: .6rem; color: #666; font-size: .75rem; }
.sources ul { margin: 0; padding-left: 0; list-style: none; font-size: .95rem; }
.sources li { margin-bottom: .3rem; padding-left: 2rem; text-indent: -2rem; }
"#;

pub(crate) fn render(document: &Document) -> String {
    let mut page = Page::default();
    let title = escape(&document.title);
    let mut body = format!("<h1>{title}</h1>\n");
    if !document.origin.is_empty() {
        body.push_str(&format!(
            "<p class=\"origin\">{}</p>\n",
            escape(&document.origin)
        ));
    }
    body.push_str(&page.paragraphs(&document.markdown));
    if !document.sources.is_empty() {
        body.push_str(&source_list(&document.sources));
    }
    if !page.pictures.is_empty() {
        body.push_str(&format!(
            "<svg class=\"pictures\" aria-hidden=\"true\"><defs>\n{}</defs></svg>\n",
            page.pictures
        ));
    }
    format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>{title}</title>\n<style>{STYLE}</style>\n</head>\n<body>\n<article>\n{body}</article>\n</body>\n</html>\n"
    )
}

/// What the file is made of while it is written.
#[derive(Default)]
struct Page {
    formulas: Formulas,
    /// The number of each formula picture in `pictures`.
    numbers: HashMap<(String, Display), usize>,
    /// Each formula picture once, as an SVG image that every use of the formula points to.
    pictures: String,
}

fn source_list(sources: &[Source]) -> String {
    let items: String = sources
        .iter()
        .map(|source| {
            format!(
                "<li id=\"source-{n}\">[{n}] {}</li>\n",
                escape(&source.text),
                n = source.number
            )
        })
        .collect();
    format!("<section class=\"sources\"><h2>Sources</h2>\n<ul>\n{items}</ul>\n</section>\n")
}

impl Page {
    /// The Markdown as blocks.
    fn paragraphs(&mut self, markdown: &str) -> String {
        let events = self.events(markdown);
        let mut html = String::new();
        push_html(&mut html, events.into_iter());
        html
    }

    /// The Markdown as events that can only write text, a formula picture or a mark of the
    /// document itself: raw HTML is shown as text, and a link or a picture of the Markdown is
    /// shown as its words, so a file never reaches outside itself. A first-level heading is read
    /// as a second-level one, under the title of the file.
    fn events<'m>(&mut self, markdown: &'m str) -> Vec<Event<'m>> {
        // The `1-` is from when a file held several texts, each numbering its notes from one.
        // Files keep the ids they had.
        let note_id = |label: &str| -> CowStr<'static> { format!("note-1-{label}").into() };
        let mut events = Vec::new();
        for event in commonmark::parse(markdown) {
            match event {
                Event::FootnoteReference(label) => {
                    events.push(Event::FootnoteReference(note_id(&label)));
                }
                Event::Start(Tag::FootnoteDefinition(label)) => {
                    events.push(Event::Start(Tag::FootnoteDefinition(note_id(&label))));
                }
                Event::Start(Tag::Heading {
                    level: HeadingLevel::H1,
                    id,
                    classes,
                    attrs,
                }) => events.push(Event::Start(Tag::Heading {
                    level: HeadingLevel::H2,
                    id,
                    classes,
                    attrs,
                })),
                Event::End(TagEnd::Heading(HeadingLevel::H1)) => {
                    events.push(Event::End(TagEnd::Heading(HeadingLevel::H2)));
                }
                Event::InlineMath(latex) => {
                    events.push(Event::InlineHtml(self.math(&latex, Display::Inline).into()));
                }
                Event::DisplayMath(latex) => events.push(Event::Html(
                    format!(
                        "<span class=\"display-math\">{}</span>",
                        self.math(&latex, Display::Block)
                    )
                    .into(),
                )),
                Event::Html(text) | Event::InlineHtml(text) => events.push(Event::Text(text)),
                Event::Start(Tag::Image { .. } | Tag::Link { .. })
                | Event::End(TagEnd::Image | TagEnd::Link) => {}
                event => events.push(event),
            }
        }
        events
    }

    /// A picture of the formula, sized in em so that it grows with the text around it. The LaTeX
    /// is its label, and the page shows it as code when the formula cannot be typeset.
    fn math(&mut self, latex: &str, display: Display) -> String {
        let Some(formula) = self.formulas.get(latex, display) else {
            return format!("<code class=\"math\">{}</code>", escape(latex));
        };
        let (width, height) = (formula.picture_width_em(), formula.picture_height_em());
        let next = self.numbers.len();
        let number = *self
            .numbers
            .entry((latex.to_owned(), display))
            .or_insert_with(|| {
                self.pictures.push_str(&format!(
                    "<image id=\"formula-{next}\" width=\"{width:.4}\" height=\"{height:.4}\" href=\"{}\"/>\n",
                    png_data_uri(&formula.png)
                ));
                next
            });
        // A formula set apart is given only its width, so that a wide one shrinks to the page and
        // keeps its shape. A formula in a line also needs its height and its place on the baseline.
        let style = match display {
            Display::Block => format!("width:{width:.4}em"),
            Display::Inline => format!(
                "width:{width:.4}em;height:{height:.4}em;vertical-align:-{:.4}em;margin:0 -{:.4}em",
                formula.descent_em + formula.bleed_em,
                formula.bleed_em,
            ),
        };
        format!(
            "<svg class=\"math\" role=\"img\" aria-label=\"{}\" viewBox=\"0 0 {width:.4} {height:.4}\" style=\"{style}\"><use href=\"#formula-{number}\"/></svg>",
            escape(latex),
        )
    }
}

/// The address that holds the bytes of a PNG inside the text that names it.
fn png_data_uri(bytes: &[u8]) -> String {
    format!("data:image/png;base64,{}", STANDARD.encode(bytes))
}

fn escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            other => escaped.push(other),
        }
    }
    escaped
}
