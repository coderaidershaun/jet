//! A deliberate live check of JEV's response and latency; never contacts it by default.

#[test]
fn live_jev_classifies_within_the_backend_cap() {
    if std::env::var("REX_PROD_API").as_deref() != Ok("true") {
        return;
    }
    let start = std::time::Instant::now();
    let feeling = agent::feel_message("Hello, Jet!").expect("live JEV classification failed");
    eprintln!(
        "JEV classification latency: {} ms",
        start.elapsed().as_millis()
    );
    assert!(
        !feeling.scores.is_empty(),
        "live check needs a configured JEV key"
    );
    assert!(
        feeling
            .scores
            .values()
            .all(|score| score.is_finite() && (0.0..=1.0).contains(score))
    );
    assert!(agent::Mood::ALL.contains(&feeling.mood));
    assert!(start.elapsed() < std::time::Duration::from_millis(2200));
}
