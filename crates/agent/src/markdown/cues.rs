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
    let lines: Vec<Line> = text
        .split('\n')
        .zip(code_lines(text))
        .map(|(text, is_code)| Line {
            text: text.to_owned(),
            is_code,
        })
        .collect();
    let mut done: Vec<Line> = Vec::with_capacity(lines.len());
    // The lines of only cues waiting for the next line with words, joined as they come, and the
    // blank lines after them, which go if the cues join forward and stay if they join back.
    let mut cues: Option<String> = None;
    let mut blanks: Vec<Line> = Vec::new();
    for line in lines {
        match cues.take() {
            None if !line.is_code && only_cues(&line.text) => cues = Some(line.text),
            None => done.push(line),
            Some(waiting) if line.text.trim().is_empty() => {
                cues = Some(waiting);
                blanks.push(line);
            }
            Some(mut waiting) if !line.is_code && only_cues(&line.text) => {
                join_cues(&mut waiting, &line.text);
                cues = Some(waiting);
            }
            Some(waiting) if !line.is_code => {
                blanks.clear();
                done.push(Line {
                    text: format!("{} {}", waiting.trim(), line.text.trim_start()),
                    is_code: false,
                });
            }
            Some(waiting) => {
                place_cues(&mut done, waiting);
                done.append(&mut blanks);
                done.push(line);
            }
        }
    }
    if let Some(waiting) = cues {
        place_cues(&mut done, waiting);
        done.append(&mut blanks);
    }
    let texts: Vec<String> = done.into_iter().map(|line| line.text).collect();
    texts.join("\n")
}

/// Adds one more line of cues to the cues that wait, with one space between.
fn join_cues(waiting: &mut String, next: &str) {
    let kept = waiting.trim_end().len();
    waiting.truncate(kept);
    waiting.push(' ');
    waiting.push_str(next.trim_start());
}

/// Joins cues that have no line with words after them onto the last line with words before them,
/// dropping the blank lines between. With none, or when that line is code, they stay a line.
fn place_cues(done: &mut Vec<Line>, cues: String) {
    let before = done.iter().rposition(|line| !line.text.trim().is_empty());
    match before {
        Some(before) if !done[before].is_code => {
            done[before].text = format!("{} {}", done[before].text.trim_end(), cues.trim());
            done.truncate(before + 1);
        }
        _ => done.push(Line {
            text: cues,
            is_code: false,
        }),
    }
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
            // Lines are in order, so a block finds its first line by search instead of walking them all.
            let first = spans.partition_point(|span| span.end <= block.start);
            for line in first..spans.len() {
                if spans[line].start >= block.end {
                    break;
                }
                is_code[line] = true;
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

    /// Each of these took seconds or minutes in a debug build when the work grew with the square of the input.
    #[test]
    fn long_replies_are_read_in_time_proportional_to_their_size() {
        let fences = "```rust\nfn main() { println!(\"hi\"); }\n```\n\n".repeat(8000);
        let cue_lines = "<sigh>\n\n".repeat(20000) + "End.";
        for (name, text) in [("fences", fences), ("cue lines", cue_lines)] {
            let started = std::time::Instant::now();
            let read = inline_cues(&text);
            assert!(!read.is_empty());
            assert!(
                started.elapsed() < std::time::Duration::from_secs(1),
                "{name}: {} KB took {:?}",
                text.len() / 1024,
                started.elapsed()
            );
        }
    }
}
