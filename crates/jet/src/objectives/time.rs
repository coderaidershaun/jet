//! Turning the local dates and times Jet writes into the instants the server stores, in the
//! user's own time zone.

use jiff::{Timestamp, civil, tz::AmbiguousOffset, tz::TimeZone};

#[derive(Debug, thiserror::Error)]
pub(crate) enum TimeError {
    #[error("`{text}` is not a time; write it as {expected}")]
    Unreadable {
        text: String,
        expected: &'static str,
    },
    #[error("`{zone}` is not a time zone name the server knows")]
    UnknownZone { zone: String },
    #[error("{local} does not exist in {zone}, because the clocks skip it; pick another time")]
    DoesNotExist { local: String, zone: String },
    #[error("{local} in {zone} is already in the past; pick a later time")]
    InThePast { local: String, zone: String },
}

const DATE: &str = "YYYY-MM-DD";
const DATE_TIME: &str = "YYYY-MM-DDTHH:MM, the user's local time";

pub(super) fn zone(name: &str) -> Result<TimeZone, TimeError> {
    TimeZone::get(name).map_err(|_| TimeError::UnknownZone {
        zone: name.to_owned(),
    })
}

/// A calendar date as `YYYY-MM-DD`.
pub(super) fn date(text: &str) -> Result<civil::Date, TimeError> {
    civil::Date::strptime("%Y-%m-%d", text).map_err(|_| TimeError::Unreadable {
        text: text.to_owned(),
        expected: DATE,
    })
}

/// The instant, in Unix seconds, of a local time `YYYY-MM-DDTHH:MM` in the zone, which must be
/// after `now`. When the clocks go back and the time happens twice, the earlier instant is taken.
/// A time the clocks skip is refused.
pub(super) fn to_utc(text: &str, zone_name: &str, now: u64) -> Result<(u64, String), TimeError> {
    let local =
        civil::DateTime::strptime("%Y-%m-%dT%H:%M", text).map_err(|_| TimeError::Unreadable {
            text: text.to_owned(),
            expected: DATE_TIME,
        })?;
    let zone = zone(zone_name)?;
    let shown = local.strftime("%Y-%m-%dT%H:%M").to_string();
    let ambiguous = zone.to_ambiguous_timestamp(local);
    if matches!(ambiguous.offset(), AmbiguousOffset::Gap { .. }) {
        return Err(TimeError::DoesNotExist {
            local: shown,
            zone: zone_name.to_owned(),
        });
    }
    let instant = ambiguous.earlier().map_err(|_| TimeError::Unreadable {
        text: text.to_owned(),
        expected: DATE_TIME,
    })?;
    let utc = u64::try_from(instant.as_second()).unwrap_or(0);
    if utc <= now {
        return Err(TimeError::InThePast {
            local: shown,
            zone: zone_name.to_owned(),
        });
    }
    Ok((utc, shown))
}

/// The date in the zone at `now`.
pub(super) fn today(zone: &TimeZone, now: u64) -> civil::Date {
    let instant =
        Timestamp::from_second(i64::try_from(now).unwrap_or(i64::MAX)).unwrap_or(Timestamp::MAX);
    zone.to_datetime(instant).date()
}

/// Whole days from `from` to `to`; negative when `to` is earlier.
pub(super) fn days_between(from: civil::Date, to: civil::Date) -> i64 {
    i64::from(from.until(to).map_or(0, |span| span.get_days()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-01-01 00:00 UTC, before every time below.
    const NOW: u64 = 1_767_225_600;
    const NEW_YORK: &str = "America/New_York";

    fn utc(text: &str, zone: &str) -> Result<String, TimeError> {
        let (seconds, _) = to_utc(text, zone, NOW)?;
        Ok(Timestamp::from_second(seconds as i64).unwrap().to_string())
    }

    #[test]
    fn a_local_time_is_the_right_instant_on_both_sides_of_a_clock_change() {
        // Clocks go forward on 2026-03-08 and back on 2026-11-01.
        assert_eq!(
            utc("2026-03-07T09:00", NEW_YORK).unwrap(),
            "2026-03-07T14:00:00Z"
        );
        assert_eq!(
            utc("2026-03-09T09:00", NEW_YORK).unwrap(),
            "2026-03-09T13:00:00Z"
        );
        assert_eq!(
            utc("2026-10-31T09:00", NEW_YORK).unwrap(),
            "2026-10-31T13:00:00Z"
        );
        assert_eq!(
            utc("2026-11-02T09:00", NEW_YORK).unwrap(),
            "2026-11-02T14:00:00Z"
        );
        // 01:30 happens twice on 2026-11-01; the earlier one is still summer time.
        assert_eq!(
            utc("2026-11-01T01:30", NEW_YORK).unwrap(),
            "2026-11-01T05:30:00Z"
        );
    }

    #[test]
    fn bad_time_is_refused() {
        let refused = |text, zone| to_utc(text, zone, NOW).unwrap_err();
        assert!(matches!(
            refused("2025-12-31T09:00", NEW_YORK),
            TimeError::InThePast { .. }
        ));
        assert!(matches!(
            refused("2026-03-08T02:30", NEW_YORK),
            TimeError::DoesNotExist { .. }
        ));
        assert!(matches!(
            refused("next friday afternoon", NEW_YORK),
            TimeError::Unreadable { .. }
        ));
        assert!(matches!(
            refused("2026-13-40T09:00", NEW_YORK),
            TimeError::Unreadable { .. }
        ));
        assert!(matches!(
            refused("2026-03-07T09:00", "Mars/Olympus"),
            TimeError::UnknownZone { .. }
        ));
    }
}
