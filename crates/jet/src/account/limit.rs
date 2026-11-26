//! Slows password guessing: failed sign-ins are counted per email and per client network.

use crate::store::Email;
use std::{
    collections::HashMap,
    net::IpAddr,
    time::{Duration, Instant},
};

const WINDOW: Duration = Duration::from_secs(15 * 60);
const EMAIL_FAILURES: u32 = 5;
const ADDRESS_FAILURES: u32 = 20;
/// At most this many emails and networks are counted at once, so guesses at many emails from
/// many addresses cannot grow memory without end. When the counts are full of live ones, every
/// new client waits: refusing sign-ins is safer than forgetting failures.
const MAX_KEYS: usize = 65_536;
/// A full set of counts is swept for expired ones at most this often, so a flood of new clients
/// does not cost a sweep each.
const SWEEP_EVERY: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Key {
    Email(Email),
    Address(IpAddr),
}

/// One IPv6 client holds a whole /64, so it is counted as one, as an IPv4 address is.
fn network(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V6(ip) => match ip.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6((u128::from(ip) & !u128::from(u64::MAX)).into()),
        },
        v4 => v4,
    }
}

#[derive(Default)]
pub(super) struct Failures {
    counts: HashMap<Key, (Instant, u32)>,
    swept: Option<Instant>,
}

impl Failures {
    /// Counts this attempt as a failure before its password is checked, so attempts that run
    /// at the same time cannot all get past the limit. Returns the seconds to wait instead when
    /// the email or the address has failed too often.
    pub(super) fn begin(
        &mut self,
        email: &Email,
        address: IpAddr,
        now: Instant,
    ) -> Result<(), u64> {
        if let Some(wait) = self.wait(email, address, now) {
            return Err(wait);
        }
        let keys = [Key::Email(email.clone()), Key::Address(network(address))];
        if self.counts.len() + self.added(&keys) > MAX_KEYS {
            if self
                .swept
                .is_none_or(|swept| now.duration_since(swept) >= SWEEP_EVERY)
            {
                self.counts
                    .retain(|_, (start, _)| now.duration_since(*start) < WINDOW);
                self.swept = Some(now);
            }
            if self.counts.len() + self.added(&keys) > MAX_KEYS {
                return Err(WINDOW.as_secs());
            }
        }
        for key in keys {
            let entry = self.counts.entry(key).or_insert((now, 0));
            if now.duration_since(entry.0) >= WINDOW {
                *entry = (now, 0);
            }
            entry.1 += 1;
        }
        Ok(())
    }

    fn added(&self, keys: &[Key]) -> usize {
        keys.iter()
            .filter(|key| !self.counts.contains_key(key))
            .count()
    }

    /// Takes back the failure that `begin` counted, for an attempt whose password was right.
    pub(super) fn succeeded(&mut self, email: &Email, address: IpAddr) {
        self.counts.remove(&Key::Email(email.clone()));
        if let Some((_, count)) = self.counts.get_mut(&Key::Address(network(address))) {
            *count = count.saturating_sub(1);
        }
    }

    fn wait(&self, email: &Email, address: IpAddr, now: Instant) -> Option<u64> {
        let full = |key: Key, limit: u32| {
            let (start, count) = self.counts.get(&key)?;
            let left = WINDOW
                .checked_sub(now.duration_since(*start))
                .filter(|left| !left.is_zero())?;
            (*count >= limit).then_some(left.as_secs().max(1))
        };
        full(Key::Email(email.clone()), EMAIL_FAILURES)
            .max(full(Key::Address(network(address)), ADDRESS_FAILURES))
    }
}

/// The address a sign-in comes from. Behind the reverse proxy every connection comes from the
/// proxy, which appends the real client to `X-Forwarded-For`; that header is believed only when
/// the connection is from the proxy, since anyone else can write it.
pub(super) fn client_address(
    peer: IpAddr,
    forwarded_for: Option<&str>,
    proxy: Option<IpAddr>,
) -> IpAddr {
    let from_proxy = match proxy {
        Some(proxy) => peer == proxy,
        None => peer.is_loopback(),
    };
    if !from_proxy {
        return peer;
    }
    forwarded_for
        .and_then(|list| list.rsplit(',').next())
        .and_then(|last| last.trim().parse().ok())
        .unwrap_or(peer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failures_stop_counting_once_the_window_has_passed() {
        let mut failures = Failures::default();
        let email = Email::from("someone@example.com");
        let address = IpAddr::from([203, 0, 113, 5]);
        let start = Instant::now();
        for _ in 0..EMAIL_FAILURES {
            assert_eq!(failures.begin(&email, address, start), Ok(()));
        }
        assert!(failures.begin(&email, address, start).is_err());
        assert_eq!(failures.begin(&email, address, start + WINDOW), Ok(()));
    }

    #[test]
    fn guesses_from_one_ipv6_network_do_not_refuse_every_new_sign_in() {
        let mut failures = Failures::default();
        let start = Instant::now();
        // Each guess has a new email and a new address inside 2001:db8:0:1::/64.
        for n in 0..(MAX_KEYS / 2) as u64 {
            let mut octets = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];
            octets[8..].copy_from_slice(&n.to_be_bytes());
            let email = Email::from(format!("guess{n}@example.com").as_str());
            let _ = failures.begin(&email, IpAddr::from(octets), start);
        }
        let someone = Email::from("someone@example.com");
        let later = start + Duration::from_secs(60);
        let answer = failures.begin(&someone, IpAddr::from([203, 0, 113, 5]), later);
        assert_eq!(
            answer,
            Ok(()),
            "one /64 of guesses made every new person wait"
        );
    }

    #[test]
    fn the_counts_never_hold_more_than_their_cap() {
        let mut failures = Failures::default();
        let start = Instant::now();
        let mut refused = 0;
        for n in 0..=(MAX_KEYS / 2 + 1) as u32 {
            let email = Email::from(format!("guess{n}@example.com").as_str());
            if failures
                .begin(&email, IpAddr::from(n.to_be_bytes()), start)
                .is_err()
            {
                refused += 1;
            }
        }
        assert!(failures.counts.len() <= MAX_KEYS);
        assert!(refused > 0);
        let later = start + WINDOW;
        let email = Email::from("someone@example.com");
        assert_eq!(
            failures.begin(&email, IpAddr::from([203, 0, 113, 5]), later),
            Ok(())
        );
    }
}
