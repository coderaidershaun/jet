//! The vocal cues a reply may hold, such as `<laugh>`: the voice performs them and the chat
//! bubble hides them. The chat page gets the same list, so that it times them as the voice says
//! them.

use pulldown_cmark::{Event, Parser, Tag};
use serde::Serialize;

/// One vocal cue and the time it takes to say, in letters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Cue {
    pub tag: &'static str,
    pub weight: u32,
}

const fn cue(tag: &'static str, weight: u32) -> Cue {
    Cue { tag, weight }
}

/// Google's documented cues. Square brackets are not documented, so only the angle form is used.
pub const CUES: [Cue; 40] = [
    cue("<argh>", 4),
    cue("<breath>", 4),
    cue("<heavy breath>", 4),
    cue("<exhales>", 4),
    cue("<cackle>", 4),
    cue("<cheer>", 4),
    cue("<chuckle>", 4),
    cue("<chuckles>", 4),
    cue("<cough>", 4),
    cue("<cry>", 4),
    cue("<gasp>", 4),
    cue("<giggle>", 4),
    cue("<groan>", 4),
    cue("<growl>", 4),
    cue("<grunt>", 4),
    cue("<grr>", 4),
    cue("<hiss>", 4),
    cue("<laugh>", 8),
    cue("<laughter>", 8),
    cue("<moan>", 4),
    cue("<pant>", 4),
    cue("<pff>", 4),
    cue("<phew>", 4),
    cue("<scream>", 4),
    cue("<shout>", 4),
    cue("<shriek>", 4),
    cue("<sigh>", 4),
    cue("<sighs>", 4),
    cue("<sneeze>", 4),
    cue("<snicker>", 4),
    cue("<snort>", 4),
    cue("<sob>", 4),
    cue("<throat-clearing>", 4),
    cue("<tsk>", 4),
    cue("<whimper>", 4),
    cue("<whispers>", 4),
    cue("<whispering>", 4),
    cue("<yawn>", 4),
    cue("<short pause>", 3),
    cue("<long pause>", 6),
];

/// True when `raw`, the text of one inline HTML tag, is a listed cue.
pub(super) fn is_cue(raw: &str) -> bool {
    CUES.iter().any(|cue| cue.tag == raw)
}

/// The text with every line that holds only cues joined onto the next line that has words, so
/// that Markdown does not read the cue as the start of an HTML block and swallow the paragraph
/// after it. With no later line, or when the next one is code, it joins the one before; a text of
/// nothing but a cue stays as it is. Lines of code, fenced or indented, never change.
pub(super) fn inline_cues(text: &str) -> String {
    let mut lines: Vec<Line> = text
        .split('\n')
        .zip(code_lines(text))
        .map(|(text, is_code)| Line {
            text: text.to_owned(),
            is_code,
        })
        .collect();
    let mut at = 0;
    while at < lines.len() {
        if !lines[at].is_code && only_cues(&lines[at].text) {
            if let Some(next) = next_words(&lines, at) {
                lines[next].text = format!(
                    "{} {}",
                    lines[at].text.trim(),
                    lines[next].text.trim_start()
                );
                lines.drain(at..next);
                continue;
            }
            if let Some(before) = previous_words(&lines, at) {
                lines[before].text = format!(
                    "{} {}",
                    lines[before].text.trim_end(),
                    lines[at].text.trim()
                );
                lines.drain(before + 1..=at);
                at = before + 1;
                continue;
            }
        }
        at += 1;
    }
    let texts: Vec<String> = lines.into_iter().map(|line| line.text).collect();
    texts.join("\n")
}

struct Line {
    text: String,
    is_code: bool,
}

/// For each line, whether it lies in a code block. Each line of only cues is first made plain
/// text, because Markdown would read it as an HTML block that swallows a code fence after it.
fn code_lines(text: &str) -> Vec<bool> {
    let plain: Vec<String> = text
        .split('\n')
        .map(|line| {
            if only_cues(line) {
                line.replace('<', "x")
            } else {
                line.to_owned()
            }
        })
        .collect();
    let mut spans = Vec::with_capacity(plain.len());
    let mut start = 0;
    for line in &plain {
        // A line runs up to and including its line break.
        spans.push(start..start + line.len() + 1);
        start += line.len() + 1;
    }
    let mut is_code = vec![false; spans.len()];
    for (event, block) in Parser::new(&plain.join("\n")).into_offset_iter() {
        if let Event::Start(Tag::CodeBlock(_)) = event {
            for (line, span) in spans.iter().enumerate() {
                is_code[line] |= span.start < block.end && block.start < span.end;
            }
        }
    }
    is_code
}

/// True when the line is one or more listed cues with only spaces between them.
pub(super) fn only_cues(line: &str) -> bool {
    let mut rest = line.trim();
    if rest.is_empty() {
        return false;
    }
    while !rest.is_empty() {
        let Some(cue) = CUES.iter().find(|cue| rest.starts_with(cue.tag)) else {
            return false;
        };
        rest = rest[cue.tag.len()..].trim_start();
    }
    true
}

/// The first line after `at` that is not blank, unless that line is code.
fn next_words(lines: &[Line], at: usize) -> Option<usize> {
    let next = (at + 1..lines.len()).find(|&i| !lines[i].text.trim().is_empty())?;
    (!lines[next].is_code).then_some(next)
}

/// The last line before `at` that is not blank, unless that line is code.
fn previous_words(lines: &[Line], at: usize) -> Option<usize> {
    let before = (0..at).rev().find(|&i| !lines[i].text.trim().is_empty())?;
    (!lines[before].is_code).then_some(before)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_of_only_cues_joins_the_next_line_or_else_the_previous() {
        let cases = [
            ("Ha <laugh> yes.", "Ha <laugh> yes."),
            ("<laugh>\nSo true.", "<laugh> So true."),
            ("<laugh>\n\n\nSo true.", "<laugh> So true."),
            ("  <sigh> <long pause>  \nOk.", "<sigh> <long pause> Ok."),
            ("<laugh>\n<sigh>\nOk.", "<laugh> <sigh> Ok."),
            ("Fine.\n\n<sigh>", "Fine. <sigh>"),
            ("Fine.\n\n<sigh>\n", "Fine. <sigh>\n"),
            ("<sigh>", "<sigh>"),
            ("<zap>\nText", "<zap>\nText"),
            ("<laugh> and more\nText", "<laugh> and more\nText"),
            (
                "```\n<laugh>\nx\n```\n<sigh>\nEnd.",
                "```\n<laugh>\nx\n```\n<sigh> End.",
            ),
            ("~~~\n<laugh>\n~~~", "~~~\n<laugh>\n~~~"),
            (
                "Code:\n\n    <laugh>\n    x\n\nEnd.",
                "Code:\n\n    <laugh>\n    x\n\nEnd.",
            ),
            ("Text\n\n<sigh>\n\n    x", "Text <sigh>\n\n    x"),
            ("Code:\n```\nx\n```\n<sigh>", "Code:\n```\nx\n```\n<sigh>"),
            ("<sigh>\n```\nx\n```", "<sigh>\n```\nx\n```"),
            (
                "Text\n\n<sigh>\n```\nx\n```\n<laugh>\nEnd.",
                "Text <sigh>\n```\nx\n```\n<laugh> End.",
            ),
        ];
        for (text, joined) in cases {
            assert_eq!(inline_cues(text), joined, "{text:?}");
        }
    }
}
