//! The vocal cues a reply may hold, such as `<laugh>`: the voice performs them and the chat
//! bubble hides them. The chat page gets the same list, so that it times them as the voice says
//! them.

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
/// after it. With no later line, or when the next one opens a code fence, it joins the one
/// before; a text of nothing but a cue stays as it is. Lines inside a code fence never change.
// SMELL: a cue line inside code that is indented instead of fenced is still joined, which changes
// that code. Replies fence their code, so this is accepted.
pub(super) fn inline_cues(text: &str) -> String {
    let mut lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
    let mut fence: Option<String> = None;
    let mut at = 0;
    while at < lines.len() {
        if let Some(marker) = fence_marker(&lines[at]) {
            match &fence {
                None => fence = Some(marker),
                Some(open) if marker.starts_with(open.as_str()) => fence = None,
                Some(_) => {}
            }
        } else if fence.is_none() && only_cues(&lines[at]) {
            if let Some(next) = next_words(&lines, at) {
                let joined = format!("{} {}", lines[at].trim(), lines[next].trim_start());
                lines[next] = joined;
                lines.drain(at..next);
                continue;
            }
            if let Some(before) = previous_words(&lines, at) {
                let joined = format!("{} {}", lines[before].trim_end(), lines[at].trim());
                lines[before] = joined;
                lines.drain(before + 1..=at);
                at = before + 1;
                continue;
            }
        }
        at += 1;
    }
    lines.join("\n")
}

/// The run of backticks or tildes that opens or closes a fence on this line, if it has one.
fn fence_marker(line: &str) -> Option<String> {
    let line = line.trim_start();
    let first = line.chars().next().filter(|c| matches!(c, '`' | '~'))?;
    let marker: String = line.chars().take_while(|c| *c == first).collect();
    (marker.len() >= 3).then_some(marker)
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

/// The first line after `at` that is not blank, unless that line is a code fence.
fn next_words(lines: &[String], at: usize) -> Option<usize> {
    let next = (at + 1..lines.len()).find(|&i| !lines[i].trim().is_empty())?;
    fence_marker(&lines[next]).is_none().then_some(next)
}

/// The last line before `at` that is not blank, unless that line is a code fence.
fn previous_words(lines: &[String], at: usize) -> Option<usize> {
    let before = (0..at).rev().find(|&i| !lines[i].trim().is_empty())?;
    fence_marker(&lines[before]).is_none().then_some(before)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_listed_cue_is_a_well_formed_tag_with_a_weight() {
        for cue in CUES {
            let name = cue
                .tag
                .strip_prefix('<')
                .and_then(|tag| tag.strip_suffix('>'))
                .unwrap_or_else(|| panic!("{} is not in angle brackets", cue.tag));
            assert!(!name.is_empty(), "{} is empty", cue.tag);
            assert!(
                name.chars()
                    .all(|c| c.is_ascii_lowercase() || c == ' ' || c == '-'),
                "{} holds a character other than lowercase letters, spaces and hyphens",
                cue.tag
            );
            assert!(cue.weight > 0, "{} weighs nothing", cue.tag);
        }
    }

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
