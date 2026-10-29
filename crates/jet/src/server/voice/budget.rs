//! Limits on the hear route, because every clip it sends to Google spends quota.

use super::refusal::Refusal;
use agent::voice::{self, VoiceError};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// The most calls to Google that hearing makes at once.
const MOST_CALLS_AT_ONCE: usize = 4;
/// The most seconds of audio heard in any minute.
const MOST_SECONDS_PER_MINUTE: u32 = 90;
const MINUTE: Duration = Duration::from_secs(60);
const SECONDS_PER_DAY: u64 = 86_400;

/// When a clip asks to be heard: the instant for the limit a minute, and the UTC day for the
/// limit a day.
#[derive(Clone, Copy)]
pub(super) struct Moment {
    instant: Instant,
    /// Whole days since 1 January 1970, in UTC.
    utc_day: u64,
}

impl Moment {
    pub(super) fn now() -> Self {
        let since_epoch = SystemTime::now().duration_since(UNIX_EPOCH);
        Self {
            instant: Instant::now(),
            utc_day: since_epoch.map_or(0, |elapsed| elapsed.as_secs() / SECONDS_PER_DAY),
        }
    }
}

/// What the hear route may still spend: how many calls run at once, how much audio it hears in a
/// minute and how much in a day. A caller over any limit is refused, never queued.
pub(in crate::server) struct HearBudget {
    calls: Arc<Semaphore>,
    spent: Mutex<Spent>,
}

#[derive(Default)]
struct Spent {
    /// When each clip of the last minute was admitted, and its seconds.
    minute: VecDeque<(Instant, u32)>,
    /// The UTC day that `day_seconds` counts, and the seconds heard on it.
    day: u64,
    day_seconds: u32,
}

impl HearBudget {
    pub(in crate::server) fn new() -> Self {
        Self {
            calls: Arc::new(Semaphore::new(MOST_CALLS_AT_ONCE)),
            spent: Mutex::default(),
        }
    }

    /// Lets a clip of `seconds` be heard, or says why not. The clip is charged now and not given
    /// back, even if Google fails. The permit holds one of the calls until it is dropped.
    /// `at` is passed in so that the limits can be tested.
    pub(super) fn admit(
        &self,
        seconds: u32,
        at: Moment,
        daily_minutes: u32,
    ) -> Result<OwnedSemaphorePermit, Refusal> {
        if seconds > voice::MAX_CLIP_SECONDS {
            return Err(VoiceError::AudioTooLong {
                seconds,
                limit: voice::MAX_CLIP_SECONDS,
            }
            .into());
        }
        let permit = Arc::clone(&self.calls).try_acquire_owned().map_err(|_| {
            Refusal::rate_limited("Jet is hearing as much as it can; try again soon")
        })?;
        let mut spent = self.spent.lock().unwrap_or_else(|error| error.into_inner());
        while spent
            .minute
            .front()
            .is_some_and(|(admitted, _)| at.instant.duration_since(*admitted) >= MINUTE)
        {
            spent.minute.pop_front();
        }
        if spent.day != at.utc_day {
            spent.day = at.utc_day;
            spent.day_seconds = 0;
        }
        let minute_seconds: u32 = spent.minute.iter().map(|(_, seconds)| seconds).sum();
        if minute_seconds + seconds > MOST_SECONDS_PER_MINUTE {
            return Err(Refusal::rate_limited(
                "Jet is hearing too much at once; try again in a moment",
            ));
        }
        if spent.day_seconds + seconds > daily_minutes.saturating_mul(60) {
            return Err(Refusal::rate_limited(
                "Today's listening allowance is used up",
            ));
        }
        spent.minute.push_back((at.instant, seconds));
        spent.day_seconds += seconds;
        Ok(permit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(instant: Instant, utc_day: u64) -> Moment {
        Moment { instant, utc_day }
    }

    fn kind(result: Result<OwnedSemaphorePermit, Refusal>) -> &'static str {
        result.map_or_else(|refusal| refusal.kind, |_| "heard")
    }

    #[test]
    fn hearing_is_capped_by_clip_length_calls_at_once_audio_a_minute_and_audio_a_day() {
        let budget = HearBudget::new();
        let start = Instant::now();

        // A clip over 20 seconds is refused; one of exactly 20 is heard.
        assert_eq!(kind(budget.admit(21, at(start, 1), 60)), "tooLong");
        assert_eq!(kind(budget.admit(20, at(start, 1), 60)), "heard");

        // Four calls at once are allowed, and a fifth is refused, not queued.
        let held: Vec<_> = (0..4)
            .map(|_| budget.admit(1, at(start, 1), 60).unwrap())
            .collect();
        assert_eq!(kind(budget.admit(1, at(start, 1), 60)), "rateLimited");
        drop(held);

        // 24 seconds are spent so far, so 66 more fit in the minute and no more.
        for _ in 0..3 {
            assert_eq!(kind(budget.admit(20, at(start, 1), 600)), "heard");
        }
        assert_eq!(kind(budget.admit(6, at(start, 1), 600)), "heard");
        assert_eq!(kind(budget.admit(1, at(start, 1), 600)), "rateLimited");
        assert_eq!(
            kind(budget.admit(1, at(start + MINUTE - Duration::from_secs(1), 1), 600)),
            "rateLimited"
        );
        assert_eq!(kind(budget.admit(20, at(start + MINUTE, 1), 600)), "heard");

        // The day allows 60 minutes: 3,600 seconds in all, then it is refused with its own words.
        let budget = HearBudget::new();
        let mut now = start;
        for _ in 0..180 {
            assert_eq!(kind(budget.admit(20, at(now, 7), 60)), "heard");
            now += MINUTE;
        }
        let refusal = budget.admit(1, at(now, 7), 60).unwrap_err();
        assert_eq!(refusal.kind, "rateLimited");
        assert_eq!(refusal.message, "Today's listening allowance is used up");
        assert_eq!(kind(budget.admit(20, at(now, 8), 60)), "heard");
    }
}
