//! Passwords are kept only as salted Argon2id hashes.

use super::AccountError;
use argon2::{Argon2, PasswordHasher, PasswordVerifier};
use std::sync::LazyLock;

pub(super) fn hash(password: &str) -> Result<String, AccountError> {
    let hash = Argon2::default()
        .hash_password(password.as_bytes())
        .map_err(AccountError::Hash)?;
    Ok(hash.to_string())
}

/// Whether `password` matches `stored`. An unknown email still costs one full hash, so the time
/// taken does not tell a stranger which emails have accounts.
pub(super) fn matches(password: &str, stored: Option<&str>) -> bool {
    static NOBODY: LazyLock<String> = LazyLock::new(|| {
        hash("the hash compared when no account has the email")
            .expect("hashing a fixed password with a fresh salt cannot fail")
    });
    let compared = stored.unwrap_or(NOBODY.as_str());
    let matched = Argon2::default()
        .verify_password(password.as_bytes(), compared)
        .is_ok();
    matched && stored.is_some()
}
