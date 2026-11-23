//! Removes the header lines that start a reply, `mood: <word>` and `react: <emoji>`, even when
//! their characters arrive in separate pieces, so the chat bubble never shows them.

use crate::chat::{Mood, Reaction};

/// A header line is short; a longer opening line is ordinary text.
const LONGEST_HEADER_LINE: usize = 48;

/// What a piece of the reply turned into. `mood` and `reaction` appear at most once, first.
#[derive(Debug, Default, PartialEq)]
pub(super) struct Split {
    pub mood: Option<Mood>,
    /// The emoji of a `react:` line. `react: none` gives nothing.
    pub reaction: Option<String>,
    pub text: String,
}

enum State {
    /// Holding back the start of the reply until it is clear whether it is a header line.
    Buffering(String),
    Passing,
}

pub(super) struct MoodSplitter {
    state: State,
    /// True once a header line is gone, so the blank lines after it are dropped too.
    saw_header: bool,
}

enum Header<'a> {
    Mood(&'a str),
    React(&'a str),
}

enum Verdict<'a> {
    Wait,
    Release,
    Header { header: Header<'a>, rest: &'a str },
}

impl MoodSplitter {
    pub(super) fn new() -> MoodSplitter {
        MoodSplitter {
            state: State::Buffering(String::new()),
            saw_header: false,
        }
    }

    pub(super) fn push(&mut self, delta: &str) -> Split {
        match &mut self.state {
            State::Passing => Split::text(delta),
            State::Buffering(buffer) => {
                buffer.push_str(delta);
                let held = std::mem::take(buffer);
                self.settle(&held, false)
            }
        }
    }

    /// Releases whatever is still held back. Call once the reply is over.
    pub(super) fn finish(&mut self) -> Split {
        match std::mem::replace(&mut self.state, State::Passing) {
            State::Buffering(held) => self.settle(&held, true),
            State::Passing => Split::default(),
        }
    }

    fn settle(&mut self, held: &str, at_end: bool) -> Split {
        let mut split = Split::default();
        let mut rest = held;
        loop {
            if self.saw_header {
                rest = rest.trim_start_matches(['\n', '\r']);
            }
            match judge(rest, at_end) {
                Verdict::Wait => {
                    self.state = State::Buffering(rest.to_owned());
                    return split;
                }
                Verdict::Release => {
                    self.state = State::Passing;
                    split.text = rest.to_owned();
                    return split;
                }
                Verdict::Header {
                    header,
                    rest: after,
                } => {
                    self.saw_header = true;
                    split.take(header);
                    rest = after;
                }
            }
        }
    }
}

impl Split {
    fn text(text: &str) -> Split {
        Split {
            text: text.to_owned(),
            ..Split::default()
        }
    }

    fn take(&mut self, header: Header) {
        match header {
            Header::Mood(word) => {
                self.mood
                    .get_or_insert(Mood::from_word(word).unwrap_or(Mood::Neutral));
            }
            Header::React(emoji) if Reaction::is_emoji(emoji) && self.reaction.is_none() => {
                self.reaction = Some(emoji.to_owned());
            }
            Header::React(_) => {}
        }
    }
}

fn judge(held: &str, at_end: bool) -> Verdict<'_> {
    if held.is_empty() {
        return if at_end {
            Verdict::Release
        } else {
            Verdict::Wait
        };
    }
    let (first, rest, line_complete) = match held.split_once('\n') {
        Some((first, rest)) => (first, rest, true),
        None => (held, "", false),
    };
    if line_complete || at_end {
        return match header(first) {
            Some(header) => Verdict::Header { header, rest },
            None => Verdict::Release,
        };
    }
    if could_become_header(first) {
        Verdict::Wait
    } else {
        Verdict::Release
    }
}

/// The header a `mood: <word>` or `react: <emoji>` line holds, case and spacing aside.
fn header(line: &str) -> Option<Header<'_>> {
    let (label, word) = line.trim().split_once(':')?;
    let word = word.trim();
    if word.is_empty() || word.contains(char::is_whitespace) {
        return None;
    }
    let label = label.trim();
    if label.eq_ignore_ascii_case("mood") {
        Some(Header::Mood(word))
    } else if label.eq_ignore_ascii_case("react") {
        Some(Header::React(word))
    } else {
        None
    }
}

fn could_become_header(partial: &str) -> bool {
    if partial.len() > LONGEST_HEADER_LINE {
        return false;
    }
    let lowered = partial.trim_start().to_ascii_lowercase();
    ["mood", "react"]
        .into_iter()
        .any(|label| match lowered.strip_prefix(label) {
            Some(after_label) => {
                let after_label = after_label.trim_start();
                after_label.is_empty() || after_label.starts_with(':')
            }
            None => label.starts_with(&lowered),
        })
}
