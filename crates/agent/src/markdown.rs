//! Turns a reply into HTML the chat page can insert as it is. Raw HTML in the reply is
//! shown as text, links are limited to web and mail addresses, and images become text,
//! so nothing a reply contains can run.

use pulldown_cmark::{Alignment, Event, Options, Parser, Tag, TagEnd, html};

/// Renders Markdown (tables, strikethrough and task lists included) to safe HTML.
pub fn render_markdown(text: &str) -> String {
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let mut out = String::with_capacity(text.len() * 3 / 2);
    html::push_html(&mut out, make_safe(Parser::new_ext(text, options)));
    out
}

fn make_safe<'a>(events: impl Iterator<Item = Event<'a>>) -> impl Iterator<Item = Event<'a>> {
    let mut in_dropped_link = false;
    let mut in_image = false;
    events.filter_map(move |event| match event {
        Event::Html(raw) | Event::InlineHtml(raw) => Some(Event::Text(raw)),
        Event::Start(Tag::Link { dest_url, .. }) if !is_allowed_link(&dest_url) => {
            in_dropped_link = true;
            None
        }
        Event::End(TagEnd::Link) if in_dropped_link => {
            in_dropped_link = false;
            None
        }
        Event::Start(Tag::Image { .. }) => {
            in_image = true;
            Some(Event::Text("[image: ".into()))
        }
        Event::End(TagEnd::Image) => {
            in_image = false;
            Some(Event::Text("]".into()))
        }
        Event::Text(alt) if in_image => Some(Event::Text(alt)),
        Event::Code(alt) if in_image => Some(Event::Text(alt)),
        _ if in_image => None,
        Event::Start(Tag::Table(alignments)) => Some(Event::Start(Tag::Table(vec![
            Alignment::None;
            alignments
                .len()
        ]))),
        other => Some(other),
    })
}

fn is_allowed_link(url: &str) -> bool {
    let url = url.trim().to_ascii_lowercase();
    ["http://", "https://", "mailto:"]
        .iter()
        .any(|scheme| url.starts_with(scheme))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_html_is_escaped_and_unsafe_links_dropped() {
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
        assert!(!html.contains("style="), "{html}");
        assert!(html.contains("<table>"), "{html}");
    }
}
