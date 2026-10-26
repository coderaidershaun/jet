//! Keeps a reply from carrying anything that runs: raw HTML becomes text, links are limited
//! to web and mail addresses, and images become text.

use pulldown_cmark::{Event, Tag, TagEnd};

pub(super) fn make_safe<'a>(
    events: impl Iterator<Item = Event<'a>>,
) -> impl Iterator<Item = Event<'a>> {
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
        Event::Text(alt) | Event::Code(alt) if in_image => Some(Event::Text(alt)),
        _ if in_image => None,
        other => Some(other),
    })
}

fn is_allowed_link(url: &str) -> bool {
    let url = url.trim().to_ascii_lowercase();
    ["http://", "https://", "mailto:"]
        .iter()
        .any(|scheme| url.starts_with(scheme))
}
