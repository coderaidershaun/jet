//! Removes the `mood: <word>` line that starts every reply, even when its characters
//! arrive in separate pieces, so the chat bubble never shows it.

use crate::chat::Mood;

/// A mood line is short; a longer opening line is ordinary text.
const LONGEST_MOOD_LINE: usize = 40;

/// What a piece of the reply turned into. `mood` appears at most once, first.
#[derive(Debug, Default, PartialEq)]
pub(super) struct Split {
    pub mood: Option<Mood>,
    pub text: String,
}

enum State {
    /// Holding back the start of the reply until it is clear whether it is a mood line.
    Buffering(String),
    /// The mood line is gone; drop the blank lines that follow it.
    SkippingBlankLines,
    Passing,
}

pub(super) struct MoodSplitter {
    state: State,
}

enum Verdict<'a> {
    Wait,
    Release,
    Mood { mood: Mood, rest: &'a str },
}

impl MoodSplitter {
    pub(super) fn new() -> MoodSplitter {
        MoodSplitter {
            state: State::Buffering(String::new()),
        }
    }

    pub(super) fn push(&mut self, delta: &str) -> Split {
        match &mut self.state {
            State::Passing => Split::text(delta),
            State::SkippingBlankLines => self.skip_blank_lines(delta),
            State::Buffering(buffer) => {
                buffer.push_str(delta);
                let held = std::mem::take(buffer);
                self.settle(held, false)
            }
        }
    }

    /// Releases whatever is still held back. Call once the reply is over.
    pub(super) fn finish(&mut self) -> Split {
        match std::mem::replace(&mut self.state, State::Passing) {
            State::Buffering(held) => self.settle(held, true),
            State::SkippingBlankLines | State::Passing => Split::default(),
        }
    }

    fn settle(&mut self, held: String, at_end: bool) -> Split {
        match judge(&held, at_end) {
            Verdict::Wait => {
                self.state = State::Buffering(held);
                Split::default()
            }
            Verdict::Release => {
                self.state = State::Passing;
                Split::text(&held)
            }
            Verdict::Mood { mood, rest } => {
                self.state = State::SkippingBlankLines;
                let mut split = self.skip_blank_lines(rest);
                split.mood = Some(mood);
                split
            }
        }
    }

    fn skip_blank_lines(&mut self, text: &str) -> Split {
        let rest = text.trim_start_matches(['\n', '\r']);
        if !rest.is_empty() {
            self.state = State::Passing;
        }
        Split::text(rest)
    }
}

impl Split {
    fn text(text: &str) -> Split {
        Split {
            mood: None,
            text: text.to_owned(),
        }
    }
}

fn judge(held: &str, at_end: bool) -> Verdict<'_> {
    let (first, rest, line_complete) = match held.split_once('\n') {
        Some((first, rest)) => (first, rest, true),
        None => (held, "", false),
    };
    if line_complete || at_end {
        return match mood_word(first) {
            Some(word) => Verdict::Mood {
                mood: Mood::from_word(word).unwrap_or(Mood::Neutral),
                rest,
            },
            None => Verdict::Release,
        };
    }
    if could_become_mood_line(first) {
        Verdict::Wait
    } else {
        Verdict::Release
    }
}

/// The word of a `mood: <word>` line, case and spacing aside.
fn mood_word(line: &str) -> Option<&str> {
    let (label, word) = line.trim().split_once(':')?;
    let word = word.trim();
    let is_one_word = !word.is_empty() && !word.contains(char::is_whitespace);
    (label.trim().eq_ignore_ascii_case("mood") && is_one_word).then_some(word)
}

fn could_become_mood_line(partial: &str) -> bool {
    if partial.len() > LONGEST_MOOD_LINE {
        return false;
    }
    let lowered = partial.trim_start().to_ascii_lowercase();
    match lowered.strip_prefix("mood") {
        Some(after_label) => {
            let after_label = after_label.trim_start();
            after_label.is_empty() || after_label.starts_with(':')
        }
        None => "mood".starts_with(&lowered),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(pieces: &[&str]) -> (Vec<Mood>, String) {
        let mut splitter = MoodSplitter::new();
        let mut moods = Vec::new();
        let mut text = String::new();
        for piece in pieces {
            let split = splitter.push(piece);
            moods.extend(split.mood);
            text.push_str(&split.text);
        }
        let last = splitter.finish();
        moods.extend(last.mood);
        text.push_str(&last.text);
        (moods, text)
    }

    #[test]
    fn mood_line_split_across_deltas_is_removed() {
        let (moods, text) = run(&["mo", "od: exc", "ited\n", "\n", "Hello", " there"]);
        assert_eq!(moods, vec![Mood::Excited]);
        assert_eq!(text, "Hello there");
    }

    #[test]
    fn reply_without_mood_line_is_untouched() {
        for pieces in [
            &["Hello ", "there"][..],
            &["Mostly fine.\nSecond line"][..],
            &["mood: so sad about it\nBody"][..],
            &["mo"][..],
        ] {
            let (moods, text) = run(pieces);
            assert!(moods.is_empty(), "pieces: {pieces:?}");
            assert_eq!(text, pieces.concat(), "pieces: {pieces:?}");
        }
    }

    #[test]
    fn unknown_mood_word_is_neutral() {
        let (moods, text) = run(&["Mood :  FLABBERGASTED\nAnswer"]);
        assert_eq!(moods, vec![Mood::Neutral]);
        assert_eq!(text, "Answer");
    }
}
