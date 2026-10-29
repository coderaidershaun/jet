//! Picks the words of a reply that Jet says aloud: prose, link text and headings, but not code,
//! tables, web addresses, formulas or emoji.

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd, TextMergeStream};

use super::protect::Protected;
use super::restore::Piece;

/// The Markdown cut down to what is spoken: one line per paragraph, heading or list item, with a
/// full stop added to a heading or list item that has no end mark, so that the voice pauses.
pub(crate) fn spoken_words(markdown: &str) -> String {
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let protected = Protected::new(markdown);
    let events = TextMergeStream::new(Parser::new_ext(&protected.text, options));
    let mut speaker = Speaker::default();
    for event in events {
        match event {
            Event::Start(tag) => speaker.start(&tag),
            Event::End(tag) => speaker.end(tag),
            Event::Text(text) => speaker.text(&protected, &text),
            Event::Code(code) => speaker.code(&code),
            Event::SoftBreak | Event::HardBreak => speaker.current.push(' '),
            _ => {}
        }
    }
    speaker.flush(false);
    speaker.blocks.join("\n")
}

#[derive(Default)]
struct Speaker {
    blocks: Vec<String>,
    current: String,
    /// How many code blocks, tables, images, struck-out runs and HTML blocks are open. Nothing
    /// inside one is spoken.
    silent: u32,
    items: u32,
}

impl Speaker {
    fn start(&mut self, tag: &Tag) {
        match tag {
            Tag::CodeBlock(_)
            | Tag::Table(_)
            | Tag::Image { .. }
            | Tag::Strikethrough
            | Tag::HtmlBlock
            | Tag::FootnoteDefinition(_) => self.silent += 1,
            Tag::Emphasis | Tag::Strong | Tag::Link { .. } => {}
            Tag::Item => {
                self.flush(self.items > 0);
                self.items += 1;
            }
            _ => self.flush(self.items > 0),
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::CodeBlock
            | TagEnd::Table
            | TagEnd::Image
            | TagEnd::Strikethrough
            | TagEnd::HtmlBlock
            | TagEnd::FootnoteDefinition => self.silent = self.silent.saturating_sub(1),
            TagEnd::Emphasis | TagEnd::Strong | TagEnd::Link => {}
            TagEnd::Heading(_) => self.flush(true),
            TagEnd::Item => {
                self.flush(true);
                self.items = self.items.saturating_sub(1);
            }
            TagEnd::Paragraph => self.flush(self.items > 0),
            _ => self.flush(false),
        }
    }

    fn text(&mut self, protected: &Protected, text: &str) {
        if self.silent > 0 {
            return;
        }
        for piece in protected.pieces(text) {
            match piece {
                Piece::Plain(plain) => self.current.push_str(plain),
                Piece::Marker(marker) => {
                    if let Some(math) = &marker.math
                        && !math.display
                        && is_plain_name(&math.tex)
                    {
                        self.current.push_str(&math.tex);
                    }
                }
            }
        }
    }

    fn code(&mut self, code: &str) {
        if self.silent == 0 && is_plain_name(code) {
            self.current.push_str(code);
        }
    }

    fn flush(&mut self, needs_end_mark: bool) {
        let mut line = clean(&std::mem::take(&mut self.current));
        if line.is_empty() {
            return;
        }
        if needs_end_mark && !has_end_mark(&line) {
            line.push('.');
        }
        self.blocks.push(line);
    }
}

/// Code or a formula is spoken only when it is a plain name: letters, digits, spaces and hyphens.
// SMELL: the chat page times each word with its own copy of these rules (plain names, web
// addresses and `[1]` markers), so a change here has to be made there too.
fn is_plain_name(text: &str) -> bool {
    text.chars().any(char::is_alphanumeric)
        && text
            .chars()
            .all(|c| c.is_alphanumeric() || c == ' ' || c == '-')
}

/// The words of a line without web addresses, `[1]` markers and emoji. A mark left alone after a
/// marker or an emoji goes back onto the word before it, so that the pause stays.
fn clean(raw: &str) -> String {
    let mut words: Vec<String> = Vec::new();
    for word in raw.split_whitespace() {
        let start = word.trim_start_matches(|c: char| !c.is_alphanumeric());
        if word.contains("://") || start.starts_with("www.") {
            continue;
        }
        let word: String = without_markers(word)
            .chars()
            .filter(|&c| !is_emoji(c))
            .collect();
        if word.chars().any(char::is_alphanumeric) {
            words.push(word);
        } else if !word.is_empty()
            && word.chars().all(|c| ".,;:!?\u{2026}".contains(c))
            && let Some(last) = words.last_mut()
        {
            last.push_str(&word);
        }
    }
    words.join(" ")
}

/// The word without its `[1]`, `[1,2]` and `[1-3]` markers.
fn without_markers(word: &str) -> String {
    let mut kept = String::with_capacity(word.len());
    let mut rest = word;
    while let Some(open) = rest.find('[') {
        let after = &rest[open + 1..];
        match after.find(']') {
            Some(close) if is_marker(&after[..close]) => {
                kept.push_str(&rest[..open]);
                rest = &after[close + 1..];
            }
            _ => {
                kept.push_str(&rest[..=open]);
                rest = after;
            }
        }
    }
    kept.push_str(rest);
    kept
}

fn is_marker(inside: &str) -> bool {
    inside.contains(|c: char| c.is_ascii_digit())
        && inside
            .chars()
            .all(|c| c.is_ascii_digit() || c == ',' || c == '-')
}

fn has_end_mark(line: &str) -> bool {
    line.trim_end_matches(['"', '\'', '\u{201D}', '\u{2019}', ')', ']'])
        .ends_with(['.', '!', '?', '\u{2026}', ':', ';', ','])
}

/// Pictures, symbols and the joiners that build them; the voice would read their names.
fn is_emoji(c: char) -> bool {
    matches!(
        u32::from(c),
        0x1F000..=0x1FAFF | 0x2600..=0x27BF | 0x2B50 | 0x2B55 | 0x200D | 0x20E3 | 0xFE0F
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spoken_words_keep_prose_and_drop_code_tables_urls_and_math() {
        let cases = [
            ("Hello **bold** and *it* world.", "Hello bold and it world."),
            ("un**believ**able", "unbelievable"),
            (
                "See [the docs](https://example.com/x) now.",
                "See the docs now.",
            ),
            (
                "Visit https://example.com/page or www.example.com today.",
                "Visit or today.",
            ),
            ("[https://a.example/c](https://a.example/c)", ""),
            ("# Title\n\nBody text.", "Title.\nBody text."),
            ("## Why?\n\nBecause.", "Why?\nBecause."),
            ("- one\n- two!\n- three", "one.\ntwo!\nthree."),
            (
                "1. first\n\n   more of first\n\n2. second",
                "first.\nmore of first.\nsecond.",
            ),
            ("> quote text here\n\nAfter.", "quote text here\nAfter."),
            ("- [x] done\n- [ ] todo", "done.\ntodo."),
            ("```rust\nlet x = 1;\n```\n\nAfter.", "After."),
            ("| a | b |\n|---|---|\n| 1 | 2 |\n\nDone.", "Done."),
            ("Use `ls -la` or `rm -rf /tmp` here.", "Use ls -la or here."),
            (
                "The energy \\(E\\) equals \\(mc^2\\), see:\n\n\\[\nE = mc^2\n\\]\n\nOk.",
                "The energy E equals, see:\nOk.",
            ),
            (
                "A claim[1] and another [2]. Then [1][2] more.",
                "A claim and another. Then more.",
            ),
            ("Great job \u{1F389} team \u{2705}", "Great job team"),
            ("Done ~~old~~ new", "Done new"),
            ("![alt text](https://x.example/y.png) caption", "caption"),
            ("<div>raw</div>\n\nText", "Text"),
            ("It costs $5 or $10.", "It costs $5 or $10."),
            ("```\nonly code\n```", ""),
            ("", ""),
        ];
        for (markdown, spoken) in cases {
            assert_eq!(spoken_words(markdown), spoken, "{markdown:?}");
        }
    }
}
