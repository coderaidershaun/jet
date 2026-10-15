//! Writes the system prompt that makes Claude into Jet, and fingerprints the inputs that
//! shape it. The prompt holds no clock, so the same inputs always give the same bytes and
//! Claude's prompt cache keeps hitting.

use std::collections::BTreeSet;

use crate::chat::{Effort, McpServers, Model, Notes, Persona, Tone};

const TEMPLATE: &str = include_str!("persona.md");

/// How much of the user's own notes about Jet goes into the prompt.
const PERSONA_NOTES_LIMIT: usize = 600;

const ANNOYED_LINE: &str = "- annoyed: the user keeps repeating a mistake or ignoring a risk you already raised. Say so kindly, once.\n";

/// What the prompt says about a quanty import and a polysim engine. The `PER_REPLY` words
/// are for a library that Claude Code starts for each reply and closes after it; the
/// `SHARED` words are for one the app keeps running.
const INGEST_PER_REPLY: &str = "It runs only while your reply runs, so you must keep checking `mcp__quanty__ingest_status` until it is no longer running, and each check is another paid request.";
const INGEST_SHARED: &str = "The job keeps running after your reply ends; check `mcp__quanty__ingest_status` only when the user asks how it is going.";
const ENGINE_PER_REPLY: &str =
    "An engine you start stops when your reply ends, so say so before you start one.";
const ENGINE_SHARED: &str = "An engine you or the user start keeps running after your reply ends, until it is stopped or Jet closes.";

/// How far the behaviour wheel must move from the centre before Jet takes a side.
const NEUTRAL_RADIUS: f64 = 0.2;
const STRONG: f64 = 0.6;

/// The whole system prompt: who Jet is, how to talk, and the three notes. `shared` names the
/// libraries the app keeps running, which the prompt says outlive a reply. Names only, never
/// addresses: an address changes at every launch and would end every conversation.
pub(super) fn compose(
    persona: &Persona,
    tone: &Tone,
    notes: &Notes,
    shared: &BTreeSet<&str>,
) -> String {
    let annoyed = if tone.candid >= NEUTRAL_RADIUS {
        ANNOYED_LINE
    } else {
        ""
    };
    let (ingest, engine) = lifetimes(shared);
    let mut prompt = fill(
        TEMPLATE,
        &[
            ("name", &persona.name),
            ("job_title", &persona.job_title),
            ("annoyed_line", annoyed),
            ("ingest_lifetime", ingest),
            ("engine_lifetime", engine),
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

/// What the prompt says about how long a quanty import and a polysim engine last. They
/// outlive the reply when the app keeps that library running.
fn lifetimes(shared: &BTreeSet<&str>) -> (&'static str, &'static str) {
    let ingest = if shared.contains("quanty") {
        INGEST_SHARED
    } else {
        INGEST_PER_REPLY
    };
    let engine = if shared.contains("polysim") {
        ENGINE_SHARED
    } else {
        ENGINE_PER_REPLY
    };
    (ingest, engine)
}

/// A fingerprint of everything baked into a session's prompt: every fixed word of the prompt,
/// the model, the thinking level, which servers are enabled and which of them the app keeps
/// running. A change to any of them starts a fresh conversation. The notes are left out on
/// purpose: the review updates them all the time, and that must never end a session.
pub(super) fn prompt_hash(
    persona: &Persona,
    tone: &Tone,
    model: Model,
    effort: Effort,
    mcp: &McpServers,
    shared: &BTreeSet<&str>,
) -> String {
    let mut hash = Fnv1a::new();
    let prompt = compose(persona, tone, &Notes::default(), shared);
    let servers = mcp.enabled().map(|(name, _)| name);
    let parts = [prompt.as_str(), model.alias(), effort.alias()]
        .into_iter()
        .chain(servers);
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
    use std::collections::BTreeSet;

    use super::*;
    use crate::chat::{McpServer, Mood};

    fn prompt_for(candid: f64) -> String {
        compose(
            &Persona::default(),
            &Tone {
                candid,
                playful: 0.0,
            },
            &Notes::default(),
            &BTreeSet::new(),
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
        let prompt = compose(&persona, &Tone::default(), &notes, &BTreeSet::new());
        assert!(
            prompt.starts_with("You are {job_title}, the user's {name}. "),
            "{prompt}"
        );
        assert!(prompt.contains("call me {annoyed_line} and {memory}"));
        assert!(prompt.contains("<memory>\n- likes {name}\n</memory>"));
        assert!(prompt.contains("<user>\n(empty)\n</user>"));
    }

    #[test]
    fn the_prompt_teaches_the_libraries() {
        let prompt = prompt_for(0.55);
        for rule in [
            "mcp__quanty__search",
            "mcp__quanty__read_page",
            "[n]",
            r"\(",
            r"\[",
            "never with $",
            "ingest_pdf",
            "mcp__polysim__",
            "listed mode is live",
            "stops when your reply ends",
            "keep checking `mcp__quanty__ingest_status`",
            "starts with `Jet:`",
        ] {
            assert!(prompt.contains(rule), "the prompt lost: {rule}");
        }
        assert!(!prompt.contains("You have no tools"));
        assert!(!prompt.contains("keeps running after your reply ends"));

        // A library the app keeps running outlives the reply, and the prompt says so.
        let compose_with = |shared: &[&str]| {
            let shared: BTreeSet<&str> = shared.iter().copied().collect();
            compose(
                &Persona::default(),
                &Tone::default(),
                &Notes::default(),
                &shared,
            )
        };
        let both = compose_with(&["polysim", "quanty"]);
        assert!(both.contains("The job keeps running after your reply ends"));
        assert!(both.contains("keeps running after your reply ends, until it is stopped"));
        assert!(!both.contains("stops when your reply ends"));
        assert!(!both.contains("keep checking `mcp__quanty__ingest_status`"));
        assert!(both.contains("starts with `Jet:`"));
        let polysim_only = compose_with(&["polysim"]);
        assert!(polysim_only.contains("keep checking `mcp__quanty__ingest_status`"));
        assert!(!polysim_only.contains("stops when your reply ends"));
    }

    #[test]
    fn the_fingerprint_of_the_defaults_is_pinned() {
        let hash = |mcp: &McpServers, shared: &[&str]| {
            prompt_hash(
                &Persona::default(),
                &Tone::default(),
                Model::Sonnet,
                Effort::Medium,
                mcp,
                &shared.iter().copied().collect(),
            )
        };
        let none = McpServers::default();
        assert_eq!(hash(&none, &[]), "a2240ff01ec6dc23");
        let quanty = McpServers {
            quanty: McpServer {
                enabled: true,
                ..McpServer::default()
            },
            ..McpServers::default()
        };
        assert_ne!(hash(&quanty, &[]), hash(&none, &[]));
        // Sharing a library changes what the prompt says about it, so it starts a new
        // conversation; the address it is shared at never reaches the prompt.
        assert_ne!(hash(&quanty, &["quanty"]), hash(&quanty, &[]));
    }

    #[test]
    fn prompt_has_no_timestamp() {
        let none = BTreeSet::new();
        let first = compose(
            &Persona::default(),
            &Tone::default(),
            &Notes::default(),
            &none,
        );
        let second = compose(
            &Persona::default(),
            &Tone::default(),
            &Notes::default(),
            &none,
        );
        assert_eq!(first, second);
        assert!(!first.contains("[local time"));
    }
}
