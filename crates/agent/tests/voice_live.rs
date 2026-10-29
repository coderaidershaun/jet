//! A deliberate live check of Gemini's voice and latency; never contacts it by default.

#[test]
#[ignore = "calls live Gemini"]
fn gemini_speaks_with_the_configured_voice() {
    if std::env::var("REX_PROD_API").as_deref() != Ok("true") {
        return;
    }
    let start = std::time::Instant::now();
    let pcm = agent::voice::speak("Hello, I am Jet, and this is my voice.", None)
        .expect("live Gemini speech failed; check GEMINI_API_KEY and GEMINI_VOICE_ID");
    let elapsed = start.elapsed();
    let seconds = pcm.len() as f64 / 2.0 / f64::from(agent::voice::SAMPLE_RATE);
    eprintln!(
        "Gemini speech: {seconds:.2} s of audio in {} ms",
        elapsed.as_millis()
    );
    assert!(
        seconds > 0.5,
        "one sentence came back as {seconds:.2} s of audio"
    );
    assert!(elapsed < std::time::Duration::from_secs(5));
}
