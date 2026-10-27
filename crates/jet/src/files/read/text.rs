//! Reading the text of a file the way people mean it: the byte-order mark dropped, bad bytes
//! replaced, CSV rows cut where a row ends, not where a quoted line break falls, and the title
//! of an HTML page.

use std::borrow::Cow;

const TITLE_CHARS: usize = 80;
/// How far into an HTML file the title is looked for.
const TITLE_PROBE_BYTES: usize = 64 * 1024;

/// The text of a file. Bytes that are not UTF-8 become the replacement character.
pub(super) fn decode(bytes: &[u8]) -> Cow<'_, str> {
    String::from_utf8_lossy(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes))
}

/// The rows of a CSV text, one at a time, without their line ends. A line break inside quotes
/// does not end a row.
pub(super) fn csv_rows(text: &str) -> impl Iterator<Item = &str> {
    let mut rest = text;
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let mut quoted = false;
        let mut row = rest;
        let mut after = "";
        // A quote and a line break are single bytes that never occur inside another UTF-8
        // character, so the text can be cut at them.
        for (index, byte) in rest.bytes().enumerate() {
            match byte {
                b'"' => quoted = !quoted,
                b'\n' if !quoted => {
                    row = &rest[..index];
                    after = &rest[index + 1..];
                    break;
                }
                _ => {}
            }
        }
        rest = after;
        Some(row.strip_suffix('\r').unwrap_or(row))
    })
}

/// How many cells a CSV row has: the commas outside quotes, plus one.
pub(super) fn csv_columns(row: &str) -> usize {
    if row.is_empty() {
        return 0;
    }
    let mut quoted = false;
    1 + row
        .bytes()
        .filter(|&byte| {
            if byte == b'"' {
                quoted = !quoted;
            }
            byte == b',' && !quoted
        })
        .count()
}

/// A number with thousands separators, such as `1,204`.
pub(super) fn grouped(number: usize) -> String {
    let digits = number.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// `1 row`, `1,204 rows`.
pub(super) fn counted(number: usize, noun: &str) -> String {
    let plural = if number == 1 { "" } else { "s" };
    format!("{} {noun}{plural}", grouped(number))
}

/// A name or title from inside a file, safe to show in a line: control characters dropped,
/// runs of white space made one space, and cut to `limit` characters.
pub(super) fn cleaned(text: &str, limit: usize) -> String {
    let spaced: String = text
        .chars()
        .filter(|character| !character.is_control() || character.is_whitespace())
        .map(|character| {
            if character.is_whitespace() {
                ' '
            } else {
                character
            }
        })
        .collect();
    let words: Vec<&str> = spaced.split(' ').filter(|word| !word.is_empty()).collect();
    words.join(" ").chars().take(limit).collect()
}

/// The `<title>` of an HTML page, cleaned and cut short, when it has one near the top.
pub(super) fn html_title(text: &str) -> Option<String> {
    let mut end = text.len().min(TITLE_PROBE_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let head = &text[..end];
    // Lower-casing ASCII keeps every byte position the same in both copies.
    let lower = head.to_ascii_lowercase();
    let open = lower.find("<title")?;
    let body = open + lower[open..].find('>')? + 1;
    let close = body + lower[body..].find("</title")?;
    let title = cleaned(&head[body..close], TITLE_CHARS);
    (!title.is_empty()).then_some(title)
}
