//! Puts the math back into the parser's events as inert elements that carry the TeX.

use pulldown_cmark::{CodeBlockKind, CowStr, Event, LinkType, Tag, TagEnd};

use super::protect::{CLOSE, Marker, Math, OPEN, Protected};

enum Piece<'t> {
    Plain(&'t str),
    Marker(&'t Marker),
}

/// What a backslash means where a marker sits, so its source comes back as the parser would
/// have read it there.
#[derive(Clone, Copy)]
enum Backslash {
    /// In code and in an autolink, a backslash is just a backslash.
    Literal,
    /// In a link address or title and in a code fence's language, a backslash before
    /// punctuation only escapes it.
    Escape,
}

impl Protected {
    /// Puts the math back into the parser's events. Math becomes an inert element for ordinary
    /// text only; in code, link addresses and titles the original source comes back.
    pub(super) fn restore<'a>(&self, events: Vec<Event<'a>>) -> Vec<Event<'a>> {
        let mut out = Vec::with_capacity(events.len());
        let mut events = events.into_iter().peekable();
        let mut in_code_block = false;
        while let Some(event) = events.next() {
            match event {
                Event::Text(text) if in_code_block => {
                    out.push(Event::Text(self.source_back(text, Backslash::Literal)));
                }
                Event::Text(text) => {
                    let alone_in_paragraph =
                        matches!(out.last(), Some(Event::Start(Tag::Paragraph)))
                            && matches!(events.peek(), Some(Event::End(TagEnd::Paragraph)));
                    if alone_in_paragraph && let Some(block) = self.display_block(&text) {
                        out.pop();
                        events.next();
                        out.push(block);
                    } else {
                        self.push_text(&mut out, text);
                    }
                }
                Event::Code(code) => {
                    out.push(Event::Code(self.source_back(code, Backslash::Literal)));
                }
                Event::Start(Tag::CodeBlock(kind)) => {
                    in_code_block = true;
                    let kind = match kind {
                        CodeBlockKind::Fenced(info) => {
                            CodeBlockKind::Fenced(self.source_back(info, Backslash::Escape))
                        }
                        CodeBlockKind::Indented => CodeBlockKind::Indented,
                    };
                    out.push(Event::Start(Tag::CodeBlock(kind)));
                }
                Event::End(TagEnd::CodeBlock) => {
                    in_code_block = false;
                    out.push(Event::End(TagEnd::CodeBlock));
                }
                Event::Start(Tag::Link {
                    link_type,
                    dest_url,
                    title,
                    id,
                }) => {
                    let backslash = match link_type {
                        LinkType::Autolink | LinkType::Email => Backslash::Literal,
                        _ => Backslash::Escape,
                    };
                    out.push(Event::Start(Tag::Link {
                        link_type,
                        dest_url: self.source_back(dest_url, backslash),
                        title: self.source_back(title, backslash),
                        id,
                    }));
                }
                other => out.push(other),
            }
        }
        out
    }

    /// The `<div>` for a paragraph that holds one display formula and nothing else.
    fn display_block(&self, text: &str) -> Option<Event<'static>> {
        let [
            Piece::Marker(Marker {
                math: Some(math), ..
            }),
        ] = self.pieces(text).as_slice()
        else {
            return None;
        };
        math.display
            .then(|| Event::Html(format!("{}\n", element("div", math)).into()))
    }

    fn push_text<'a>(&self, out: &mut Vec<Event<'a>>, text: CowStr<'a>) {
        if !text.contains(OPEN) {
            out.push(Event::Text(text));
            return;
        }
        for piece in self.pieces(&text) {
            out.push(match piece {
                Piece::Plain(plain) => Event::Text(plain.to_string().into()),
                Piece::Marker(Marker {
                    math: Some(math), ..
                }) => Event::InlineHtml(element("span", math).into()),
                Piece::Marker(Marker { source, math: None }) => Event::Text(source.clone().into()),
            });
        }
    }

    /// The text with each marker replaced by the source it stood for.
    fn source_back<'a>(&self, text: CowStr<'a>, backslash: Backslash) -> CowStr<'a> {
        if !text.contains(OPEN) {
            return text;
        }
        let mut restored = String::with_capacity(text.len());
        for piece in self.pieces(&text) {
            match (piece, backslash) {
                (Piece::Plain(plain), _) => restored.push_str(plain),
                (Piece::Marker(marker), Backslash::Literal) => restored.push_str(&marker.source),
                (Piece::Marker(marker), Backslash::Escape) => {
                    push_unescaped(&mut restored, &marker.source);
                }
            }
        }
        restored.into()
    }

    /// Splits text at its markers. A stray marker character with no known marker behind it ends
    /// the split, and the rest stays plain.
    fn pieces<'s>(&'s self, text: &'s str) -> Vec<Piece<'s>> {
        let mut pieces = Vec::new();
        let mut rest = text;
        while let Some((before, after_open)) = rest.split_once(OPEN) {
            let Some((marker, after_close)) = self.marker_in(after_open) else {
                break;
            };
            if !before.is_empty() {
                pieces.push(Piece::Plain(before));
            }
            pieces.push(Piece::Marker(marker));
            rest = after_close;
        }
        if !rest.is_empty() {
            pieces.push(Piece::Plain(rest));
        }
        pieces
    }

    /// The marker whose number starts `text` and the text after its closing character.
    fn marker_in<'s>(&'s self, text: &'s str) -> Option<(&'s Marker, &'s str)> {
        let (number, after) = text.split_once(CLOSE)?;
        Some((self.markers.get(number.parse::<usize>().ok()?)?, after))
    }
}

/// Writes `source` as the parser reads it where backslash escapes count: a backslash before
/// ASCII punctuation is dropped. Unlike the parser, it leaves an entity such as `&amp;` as written.
fn push_unescaped(out: &mut String, source: &str) {
    let mut chars = source.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\'
            && let Some(punctuation) = chars.next_if(char::is_ascii_punctuation)
        {
            out.push(punctuation);
        } else {
            out.push(c);
        }
    }
}

fn element(tag: &str, math: &Math) -> String {
    let class = if math.display {
        "math math-display"
    } else {
        "math"
    };
    let tex = escape(&math.tex);
    format!("<{tag} class=\"{class}\" data-tex=\"{tex}\">{tex}</{tag}>")
}

/// Escapes `&`, `<`, `>` and `"` so TeX can sit in an attribute and in text. A `'` stays, because
/// it is part of the formula.
fn escape(tex: &str) -> String {
    tex.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
