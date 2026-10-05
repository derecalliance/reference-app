// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Wall-clock instants as this API puts them on the wire.
//!
//! Only one field needs a calendar date today (`last_polled_at` on
//! `GET /actors`), which does not justify a date-time dependency. Formatting a
//! UTC instant is a closed, well-known computation, so it lives here with its
//! own tests instead.

use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch, now.
///
/// A clock set before 1970 reads as the epoch itself rather than failing: the
/// value is informational, and nothing decides anything on it.
pub fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// `ms` since the Unix epoch as an RFC 3339 UTC timestamp with millisecond
/// precision, e.g. `2026-10-03T14:05:09.120Z`.
pub fn rfc3339_from_unix_ms(ms: u64) -> String {
    let secs = ms / 1000;
    let millis = ms % 1000;
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
    )
}

/// The proleptic Gregorian date `days` after 1970-01-01.
///
/// Howard Hinnant's `civil_from_days`, restricted to non-negative inputs —
/// which is all a `u64` of milliseconds can produce. The calendar repeats
/// every 400 years (146 097 days), so the date is found within that era and
/// the era added back.
fn civil_from_days(days: u64) -> (u64, u64, u64) {
    // Shift the epoch to 0000-03-01, so the leap day is the last of the year.
    let z = days + 719_468;
    let era = z / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    // Months counted from March: 0 = March … 11 = February.
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + u64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_epoch_is_midnight_on_new_years_day_1970() {
        assert_eq!(rfc3339_from_unix_ms(0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn a_known_instant_formats_exactly() {
        // `date -u -r 1700000000` → Tue Nov 14 22:13:20 UTC 2023.
        assert_eq!(
            rfc3339_from_unix_ms(1_700_000_000_123),
            "2023-11-14T22:13:20.123Z"
        );
    }

    #[test]
    fn a_leap_day_and_the_day_after_it_are_both_right() {
        assert_eq!(
            rfc3339_from_unix_ms(951_782_400_000),
            "2000-02-29T00:00:00.000Z"
        );
        assert_eq!(
            rfc3339_from_unix_ms(951_868_800_000),
            "2000-03-01T00:00:00.000Z"
        );
    }

    #[test]
    fn the_last_millisecond_of_a_year_stays_in_that_year() {
        assert_eq!(
            rfc3339_from_unix_ms(1_735_689_599_999),
            "2024-12-31T23:59:59.999Z"
        );
    }
}
