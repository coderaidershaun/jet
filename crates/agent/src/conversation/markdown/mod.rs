//! Turns a reply into HTML the chat page can insert as it is, so nothing a reply contains can run.
//! Math is left as inert elements that carry its TeX, for the page to typeset.

mod protect;
mod restore;
mod safe;
mod table;

use pulldown_cmark::{Options, Parser, TextMergeStream, html};

use protect::Protected;

/// Renders Markdown (tables, strikethrough and task lists included) to safe HTML. Math comes back
/// as `.math` elements holding the TeX.
pub fn render_markdown(text: &str) -> String {
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let protected = Protected::new(text);
    let parser = TextMergeStream::new(Parser::new_ext(&protected.text, options));
    // `make_safe` turns every HTML event into text, so the table and math markup come after it.
    let events = table::mark_number_columns(safe::make_safe(parser).collect());
    let mut out = String::with_capacity(text.len() * 3 / 2);
    html::push_html(&mut out, protected.restore(events).into_iter());
    out
}

/// Rewrites chat math (`\( \)`, `\[ \]`, `$$ $$`) as the `$ $` and `$$ $$` that a Markdown file
/// reader takes, and writes each single `$`, which chat treats as money, as `\$`. Code spans and
/// fences come back byte for byte, and a delimiter that opens no math stays as written.
// SMELL: the scanner knows code fences and code spans, but not indented code, autolinks or raw
// HTML, so a `$` in one of those gains a backslash and chat math there is rewritten.
pub fn dollar_math(text: &str) -> String {
    Protected::with_money_escaped(text).dollar_text()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    /// Each case is a Markdown source and the HTML it must render to.
    const VECTORS: &str = include_str!("math-vectors.json");

    #[derive(Deserialize)]
    struct VectorFile {
        vectors: Vec<Vector>,
    }

    #[derive(Deserialize)]
    struct Vector {
        name: String,
        markdown: String,
        html: String,
    }

    /// Newlines beside a tag are only layout, so the cases are written without them.
    fn without_layout_newlines(html: &str) -> String {
        let chars: Vec<char> = html.chars().collect();
        let mut kept = String::with_capacity(html.len());
        for (i, &c) in chars.iter().enumerate() {
            let after_tag = i > 0 && chars[i - 1] == '>';
            let before_tag = chars.get(i + 1) == Some(&'<');
            if c != '\n' || !(after_tag || before_tag) {
                kept.push(c);
            }
        }
        kept
    }

    /// True when some tag holds a `style` attribute, which the page's content rules block.
    fn has_style_attribute(html: &str) -> bool {
        html.split('<').skip(1).any(|after_open| {
            let tag = after_open.split('>').next().unwrap_or_default();
            tag.char_indices().any(|(i, c)| {
                c.is_whitespace()
                    && tag[i + c.len_utf8()..]
                        .strip_prefix("style")
                        .is_some_and(|rest| rest.trim_start().starts_with('='))
            })
        })
    }

    #[test]
    fn dollar_math_matches_chat_math() {
        assert_eq!(
            dollar_math("Let \\( x^2 \\) hold, then\n\n\\[\nE = mc^2\n\\]\n\nand $$a+b$$ too."),
            "Let $x^2$ hold, then\n\n$$E = mc^2$$\n\nand $$a+b$$ too."
        );
        assert_eq!(
            dollar_math("It costs $5 or $10, not \\$7."),
            "It costs \\$5 or \\$10, not \\$7."
        );
        let code = "Use `\\(a\\) $5` and\n\n```\n$x$ \\[y\\]\n```\n";
        assert_eq!(dollar_math(code), code);
        assert_eq!(
            dollar_math("An open \\( never closes, nor does \\[ this"),
            "An open \\( never closes, nor does \\[ this"
        );
    }

    #[test]
    fn rendered_html_is_safe_and_math_and_tables_match_the_vectors() {
        let html = render_markdown(
            "<script>alert(1)</script>\n\nhi <img src=x onerror=alert(2)> there\n\n\
             [bad](javascript:alert(3)) and [good](https://example.com) and <javascript:alert(4)>\n\n\
             ![cat *fluffy*](https://example.com/cat.png)\n\n\
             | a | b |\n|:--|--:|\n| 1 | 2 |",
        );
        assert!(!html.contains("<script"), "{html}");
        assert!(html.contains("&lt;script&gt;"), "{html}");
        assert!(!html.contains("<img"), "{html}");
        assert!(!html.contains(r#"href="javascript"#), "{html}");
        assert!(html.contains("bad and"), "link text survives: {html}");
        assert!(
            html.contains(r#"<a href="https://example.com">good</a>"#),
            "{html}"
        );
        assert!(html.contains("[image: cat fluffy]"), "{html}");
        assert!(html.contains("<table>"), "{html}");
        assert!(!has_style_attribute(&html), "{html}");

        let file: VectorFile = serde_json::from_str(VECTORS).expect("the vector file is valid");
        assert!(!file.vectors.is_empty(), "the vector file holds no cases");
        for vector in file.vectors {
            let actual = without_layout_newlines(&render_markdown(&vector.markdown));
            assert_eq!(actual, vector.html, "{}", vector.name);
            assert!(!has_style_attribute(&actual), "{}: {actual}", vector.name);
        }
    }
}
