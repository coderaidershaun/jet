//! A deliberate live check of Gemini's hearing and latency; never contacts it by default.

use std::time::Instant;

/// Gemini speaks at 24 kHz and Jet hears 16 kHz, so one output sample is taken every 1.5 input
/// samples, from the two input samples around that place.
fn to_16_khz(pcm_24_khz: &[u8]) -> Vec<u8> {
    let samples: Vec<i16> = pcm_24_khz
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| i16::from_le_bytes(*pair))
        .collect();
    let count = samples.len() * 2 / 3;
    (0..count)
        .flat_map(|index| {
            let place = index as f64 * 1.5;
            let before = place as usize;
            let after = (before + 1).min(samples.len() - 1);
            let share = place - before as f64;
            let sample =
                f64::from(samples[before]) * (1.0 - share) + f64::from(samples[after]) * share;
            (sample.round() as i16).to_le_bytes()
        })
        .collect()
}

/// One second of quiet white noise from a fixed seed.
fn noise() -> Vec<u8> {
    let mut state: u32 = 0x2545_F491;
    (0..agent::voice::HEAR_SAMPLE_RATE)
        .flat_map(|_| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            ((state >> 16) as i16 % 300).to_le_bytes()
        })
        .collect()
}

fn spoken_at_16_khz(words: &str) -> Vec<u8> {
    // Google limits how often speech may be asked for, so a refused call waits and tries once more.
    let pcm = match agent::voice::speak(words, None) {
        Err(agent::voice::VoiceError::RateLimited) => {
            std::thread::sleep(std::time::Duration::from_secs(20));
            agent::voice::speak(words, None)
        }
        first => first,
    }
    .expect("live Gemini speech failed");
    assert!(!pcm.is_empty(), "{words:?} came back as no audio");
    to_16_khz(&pcm)
}

fn heard(label: &str, clip: &[u8]) -> Result<String, agent::voice::VoiceError> {
    let start = Instant::now();
    let text = agent::voice::hear(clip, &["Jet".into(), "Quanty".into()]);
    eprintln!(
        "Gemini hearing, {label}: {:.1} s of audio in {} ms -> {text:?}",
        clip.len() as f64 / 2.0 / f64::from(agent::voice::HEAR_SAMPLE_RATE),
        start.elapsed().as_millis()
    );
    text
}

#[test]
#[ignore = "calls live Gemini"]
fn gemini_hears_speech_and_says_nothing_for_noise_and_coughs() {
    if std::env::var("REX_PROD_API").as_deref() != Ok("true") {
        return;
    }
    let sentence = heard(
        "a spoken sentence",
        &spoken_at_16_khz("Hello Jet, what time is it in Lisbon?"),
    );
    let noise = heard("noise", &noise());
    let cough = heard(
        "a cough and a sneeze",
        &spoken_at_16_khz("<cough> <short pause> <sneeze> <short pause> <throat-clearing>"),
    );

    let sentence = sentence.expect("live Gemini hearing failed; check GEMINI_API_KEY");
    let lower = sentence.to_lowercase();
    assert!(
        lower.contains("time") && lower.contains("lisbon"),
        "the sentence came back as {sentence:?}"
    );
    for (label, text) in [("noise", noise), ("the cough", cough)] {
        let text = text.expect("live Gemini hearing failed");
        assert!(
            !text.chars().any(char::is_alphabetic),
            "{label} came back as words: {text:?}"
        );
    }
}
