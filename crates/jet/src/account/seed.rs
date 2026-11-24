//! The demo organisation: five accounts, one team and one manager. These are not real
//! mailboxes, and Jet never sends mail to them.

use super::{AccountError, password};
use crate::store::{Email, NewUser, Store, UserId};

const PASSWORD: &str = "000111";
const TEAM: &str = "Commercial";

const OWNER: &str = "shaunsurfing@gmail.com";
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
    let mut added = 0;
    for (email, display_name, is_admin) in ACCOUNTS {
        let email = Email::from(email);
        if store.user_id(&email)?.is_none() {
            store.add_user(&NewUser {
                email: &email,
                display_name,
                password_hash: &password::hash(PASSWORD)?,
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
