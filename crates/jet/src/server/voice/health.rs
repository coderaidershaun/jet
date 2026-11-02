//! What Google last refused on one voice route, so the page can say so as soon as the person
//! switches the mic or the speaker on.

use agent::voice::VoiceError;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

/// How long a refusal is still reported when Google has not answered since.
const REMEMBERED_FOR: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
pub(in crate::server) struct VoiceHealth {
    /// Google's message and when it refused.
    refusal: Mutex<Option<(String, Instant)>>,
}

impl VoiceHealth {
    /// An answer clears the refusal, and a failed call to Google replaces it. An error raised
    /// before the call, such as a missing key, changes nothing. `at` is passed in so that the
    /// time limit can be tested.
    pub(super) fn record<T>(&self, outcome: &Result<T, VoiceError>, at: Instant) {
        let mut refusal = self.refusal.lock().unwrap_or_else(PoisonError::into_inner);
        match outcome {
            Ok(_) => *refusal = None,
            Err(
                error @ (VoiceError::RateLimited
                | VoiceError::Rejected { .. }
                | VoiceError::Http
                | VoiceError::Decode),
            ) => *refusal = Some((error.to_string(), at)),
            Err(_) => {}
        }
    }

    /// Google's last refusal on this route, while it is under ten minutes old and Google has not
    /// answered since.
    pub(super) fn warning(&self, at: Instant) -> Option<String> {
        let refusal = self.refusal.lock().unwrap_or_else(PoisonError::into_inner);
        refusal
            .as_ref()
            .filter(|(_, refused_at)| at.duration_since(*refused_at) < REMEMBERED_FOR)
            .map(|(message, _)| message.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_is_reported_until_an_answer_or_ten_minutes() {
        let health = VoiceHealth::default();
        let start = Instant::now();
        let quota = "Google's voice quota is used up";
        assert_eq!(health.warning(start), None);

        health.record::<()>(&Err(VoiceError::RateLimited), start);
        assert_eq!(health.warning(start).as_deref(), Some(quota));

        // A missing key never reached Google, so the refusal and its time stay as they were.
        let missing = VoiceError::NotConfigured {
            missing: "GEMINI_API_KEY".into(),
        };
        health.record::<()>(&Err(missing), start + Duration::from_secs(1));
        assert_eq!(
            health.warning(start + Duration::from_secs(1)).as_deref(),
            Some(quota)
        );
        assert_eq!(health.warning(start + REMEMBERED_FOR), None);

        health.record::<()>(&Err(VoiceError::RateLimited), start + REMEMBERED_FOR);
        assert_eq!(
            health.warning(start + REMEMBERED_FOR).as_deref(),
            Some(quota)
        );
        health.record(&Ok(()), start + REMEMBERED_FOR);
        assert_eq!(health.warning(start + REMEMBERED_FOR), None);
    }
}
