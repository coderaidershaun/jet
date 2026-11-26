//! The demo organisation: five accounts, one team and one manager, and the password they sign in
//! with. These are not real mailboxes, and Jet never sends mail to them.

use super::{AccountError, password};
use crate::store::{Email, NewUser, Store, UserId};
use std::net::IpAddr;

/// The variable that holds the demo accounts' password on a public host, set by its operator.
const OPERATOR_VARIABLE: &str = "JET_SEED_PASSWORD";

const PASSWORD: &str = "000111";
const TEAM: &str = "Commercial";

/// The deployment's owner: the admin who gets what an older Jet kept in files.
pub(crate) const OWNER: &str = "shaunsurfing@gmail.com";
const MANAGER: &str = "admin123@gmail.com";
const TEAM_MEMBERS: [&str; 2] = ["admin1@gmail.com", "admin2@gmail.com"];

/// Email, display name, and whether the account is an admin.
const ACCOUNTS: [(&str, &str, bool); 5] = [
    (OWNER, "Shaun", true),
    (MANAGER, "Admin 123", false),
    ("admin1@gmail.com", "Admin 1", false),
    ("admin2@gmail.com", "Admin 2", false),
    ("admin3@gmail.com", "Admin 3", false),
];

/// Adds whatever part of the demo organisation is missing, so running it twice changes nothing.
/// Returns how many accounts it added.
pub(crate) fn seed(store: &Store) -> Result<usize, AccountError> {
    seed_with(store, PASSWORD)
}

fn seed_with(store: &Store, password: &str) -> Result<usize, AccountError> {
    let mut added = 0;
    for (email, display_name, is_admin) in ACCOUNTS {
        let email = Email::from(email);
        if store.user_id(&email)?.is_none() {
            store.add_user(&NewUser {
                email: &email,
                display_name,
                password_hash: &password::hash(password)?,
                is_admin,
            })?;
            added += 1;
        }
    }
    for member in TEAM_MEMBERS {
        store.add_team_member(TEAM, id(store, member)?)?;
    }
    store.set_manager(id(store, OWNER)?, id(store, MANAGER)?)?;
    Ok(added)
}

fn id(store: &Store, email: &str) -> Result<UserId, AccountError> {
    Ok(store
        .user_id(&Email::from(email))?
        .expect("the seed added every demo account before linking them"))
}

/// How a host treats the demo password that the source and the README publish.
#[derive(Clone)]
pub(super) enum DemoPassword {
    /// A host reached only from this machine: the demo accounts use the published password.
    Published,
    /// A host on a public https origin refuses the published password. The operator's password
    /// takes its place, also for a demo account seeded with the published one before this rule.
    Refused { operator: Option<String> },
}

impl DemoPassword {
    /// The rule for a host at `public_origin`, with the operator's password read from the
    /// environment.
    pub(super) fn for_host(public_origin: Option<&str>) -> Result<Self, AccountError> {
        let operator = std::env::var(OPERATOR_VARIABLE).ok();
        if operator
            .as_deref()
            .is_some_and(|operator| operator.is_empty() || operator == PASSWORD)
        {
            return Err(AccountError::PublishedSeedPassword {
                variable: OPERATOR_VARIABLE,
            });
        }
        if public_origin.is_some_and(is_public) {
            Ok(Self::Refused { operator })
        } else {
            Ok(Self::Published)
        }
    }

    /// Seeds the demo organisation into an empty database, unless a public host has no
    /// operator's password.
    pub(super) fn seed_empty(&self, store: &Store) -> Result<(), AccountError> {
        let password = match self {
            Self::Published => Some(PASSWORD),
            Self::Refused { operator } => operator.as_deref(),
        };
        if let Some(password) = password
            && store.user_count()? == 0
        {
            seed_with(store, password)?;
        }
        Ok(())
    }

    /// Whether `offered` signs in the account of `email`, whose stored hash is `stored`.
    pub(super) fn matches(&self, email: &Email, offered: &str, stored: Option<&str>) -> bool {
        let matched = password::matches(offered, stored);
        let Self::Refused { operator } = self else {
            return matched;
        };
        if offered == PASSWORD {
            return false;
        }
        let seeded_before = operator.as_deref() == Some(offered)
            && ACCOUNTS
                .iter()
                .any(|(demo, ..)| Email::from(*demo) == *email)
            && password::matches(PASSWORD, stored);
        matched || seeded_before
    }
}

/// Whether an origin is reached over https at a name other than this machine's own.
fn is_public(origin: &str) -> bool {
    let Ok(origin) = url::Url::parse(origin) else {
        return false;
    };
    let is_loopback = match origin.host() {
        Some(url::Host::Domain(name)) => name == "localhost",
        Some(url::Host::Ipv4(address)) => IpAddr::V4(address).is_loopback(),
        Some(url::Host::Ipv6(address)) => IpAddr::V6(address).is_loopback(),
        None => true,
    };
    origin.scheme() == "https" && !is_loopback
}
