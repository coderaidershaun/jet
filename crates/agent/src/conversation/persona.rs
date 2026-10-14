//! Writes the system prompt that makes Claude into Jet, and fingerprints the inputs that
//! shape it. The prompt holds no clock, so the same inputs always give the same bytes and
//! Claude's prompt cache keeps hitting.

use crate::chat::{Effort, Model, Notes, Persona, Tone};

const TEMPLATE: &str = include_str!("persona.md");

/// How much of the user's own notes about Jet goes into the prompt.
const PERSONA_NOTES_LIMIT: usize = 600;

const ANNOYED_LINE: &str = "- annoyed: the user keeps repeating a mistake or ignoring a risk you already raised. Say so kindly, once.\n";

/// How far the behaviour wheel must move from the centre before Jet takes a side.
const NEUTRAL_RADIUS: f64 = 0.2;
const STRONG: f64 = 0.6;

/// The whole system prompt: who Jet is, how to talk, and the three notes.
pub(super) fn compose(persona: &Persona, tone: &Tone, notes: &Notes) -> String {
    let annoyed = if tone.candid >= NEUTRAL_RADIUS {
        ANNOYED_LINE
    } else {
        ""
    };
    let mut prompt = fill(
        TEMPLATE,
        &[
            ("name", &persona.name),
            ("job_title", &persona.job_title),
            ("annoyed_line", annoyed),
        ],
    );
    for line in tone_lines(tone) {
        prompt.push_str(line);
        prompt.push('\n');
    }
    let own_notes = persona_notes(persona);
    if !own_notes.is_empty() {
        prompt.push_str("\n## Notes from the user about how you should be\n");
        prompt.push_str(&own_notes);
        prompt.push('\n');
    }
    for (tag, text) in [
        ("memory", &notes.memory),
        ("user", &notes.user),
        ("recent", &notes.recent),
    ] {
        let text = note_or_empty(text);
        prompt.push_str(&format!("\n<{tag}>\n{text}\n</{tag}>"));
    }
    prompt.push('\n');
    prompt
}

/// A fingerprint of everything the user can change that is baked into a session's prompt.
/// The notes are left out on purpose: the review updates them all the time, and that must
/// never end a session.
pub(super) fn prompt_hash(persona: &Persona, tone: &Tone, model: Model, effort: Effort) -> String {
    let mut hash = Fnv1a::new();
    let own_notes = persona_notes(persona);
    let tone_lines = tone_lines(tone);
    let parts = [
        persona.name.as_str(),
        persona.job_title.as_str(),
        own_notes.as_str(),
    ]
    .into_iter()
    .chain(tone_lines)
    .chain([model.alias(), effort.alias()]);
    for part in parts {
        hash.write(part.as_bytes());
        hash.write(&[0xff]);
    }
    format!("{:016x}", hash.finish())
}

/// A note as Claude reads it: trimmed, or `(empty)` when there is nothing in it.
pub(super) fn note_or_empty(text: &str) -> &str {
    let text = text.trim();
    if text.is_empty() { "(empty)" } else { text }
}

fn persona_notes(persona: &Persona) -> String {
    persona
        .notes
        .trim()
        .chars()
        .take(PERSONA_NOTES_LIMIT)
        .collect()
}

fn tone_lines(tone: &Tone) -> Vec<&'static str> {
    let (candid, playful) = (tone.candid, tone.playful);
    if candid.hypot(playful) < NEUTRAL_RADIUS {
        return vec![
            "Be even and matter-of-fact, like a good tool: answer what was asked and keep opinions for when you are asked.",
        ];
    }
    let mut lines = Vec::new();
    if candid >= NEUTRAL_RADIUS {
        lines.push("Be direct. Lead with your view, say plainly when an idea is weak or when you disagree, and don't hedge what you are sure of.");
        if candid >= STRONG {
            lines.push("Push back once, clearly, then go with the user's decision.");
        }
    } else if candid <= -NEUTRAL_RADIUS {
        lines.push("Lead with what the user wants. Offer ideas as options, ask before changing course, and raise disagreement gently and only when it matters.");
        if candid <= -STRONG {
            lines.push("Never argue: flag a concern once and move on.");
        }
    } else {
        lines.push("Balance directness with tact.");
    }
    if playful >= NEUTRAL_RADIUS {
        lines.push("Keep it light: warmth and a playful turn of phrase are welcome, as long as the answer stays clear.");
        if playful >= STRONG {
            lines.push("A little wit in most replies is good.");
        }
    } else if playful <= -NEUTRAL_RADIUS {
        lines.push(
            "Keep it plain and focused: no jokes, no exclamation marks, precision over flourish.",
        );
    } else {
        lines.push("Friendly and plain; humour only when it fits.");
    }
    lines
}

/// Replaces each `{key}` in one pass. Text that was put in is never scanned again, so a
/// name that looks like a placeholder stays exactly as the user typed it.
pub(super) fn fill(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        rest = &rest[open..];
        let hit = values.iter().find_map(|(key, value)| {
            let after = rest[1..].strip_prefix(key)?.strip_prefix('}')?;
            Some((after, *value))
        });
        match hit {
            Some((after, value)) => {
                out.push_str(value);
                rest = after;
            }
            None => {
                out.push('{');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// A 64-bit FNV-1a hash. Written out here because the standard hasher may change its
/// output between Rust releases, and a changed hash would end every saved session.
struct Fnv1a(u64);

impl Fnv1a {
    fn new() -> Fnv1a {
        Fnv1a(0xcbf2_9ce4_8422_2325)
    }

    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(0x0100_0000_01b3);
        }
    }

    fn finish(&self) -> u64 {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::Mood;

    fn prompt_for(candid: f64) -> String {
        compose(
            &Persona::default(),
            &Tone {
                candid,
                playful: 0.0,
            },
            &Notes::default(),
        )
    }

    #[test]
    fn prompt_lists_moods_and_hides_annoyed_unless_candid() {
        for candid in [0.2, 0.55, 1.0] {
            let prompt = prompt_for(candid);
            for mood in Mood::ALL {
                assert!(
                    prompt.contains(&format!("- {}:", mood.word())),
                    "{mood:?} at {candid}"
                );
            }
        }
        let gentle = prompt_for(0.19);
        assert!(!gentle.contains("- annoyed:"));
        for mood in Mood::ALL.into_iter().filter(|mood| *mood != Mood::Annoyed) {
            assert!(gentle.contains(&format!("- {}:", mood.word())), "{mood:?}");
        }
    }

    #[test]
    fn user_text_is_inserted_verbatim() {
        let persona = Persona {
            name: "{job_title}".into(),
            job_title: "{name}".into(),
            notes: "call me {annoyed_line} and {memory}".into(),
        };
        let notes = Notes {
            memory: "- likes {name}".into(),
            ..Notes::default()
        };
        let prompt = compose(&persona, &Tone::default(), &notes);
        assert!(
            prompt.starts_with("You are {job_title}, the user's {name}. "),
            "{prompt}"
        );
        assert!(prompt.contains("call me {annoyed_line} and {memory}"));
        assert!(prompt.contains("<memory>\n- likes {name}\n</memory>"));
        assert!(prompt.contains("<user>\n(empty)\n</user>"));
    }

    #[test]
    fn prompt_has_no_timestamp() {
        let first = compose(&Persona::default(), &Tone::default(), &Notes::default());
        let second = compose(&Persona::default(), &Tone::default(), &Notes::default());
        assert_eq!(first, second);
        assert!(!first.contains("[local time"));
    }
}
