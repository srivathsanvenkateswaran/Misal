//! Secret storage, backed entirely by the operating system keychain.
//!
//! Nothing in this module ever writes a secret to disk, to the database, or to a log line.
//! The database stores only a reference (`credential_ref.keychain_key`); the secret itself
//! lives here.
//!
//! Platform backends: Keychain on macOS, Credential Manager on Windows, Secret Service on Linux.

use crate::error::{MisalError, Result};
use keyring::Entry;
use rand::RngCore;

const SERVICE: &str = "dev.misal.app";
const DB_KEY_ACCOUNT: &str = "db-key";

/// Fetch the database encryption key, generating and storing one on first run.
///
/// Returns 64 hex characters representing 32 random bytes, in the form SQLCipher's
/// `PRAGMA key = "x'...'"` expects.
pub fn database_key() -> Result<String> {
    let entry = Entry::new(SERVICE, DB_KEY_ACCOUNT)?;

    match entry.get_password() {
        Ok(existing) => {
            if existing.len() != 64 || !existing.chars().all(|c| c.is_ascii_hexdigit()) {
                // Never silently regenerate. A fresh key would make the user's existing
                // database permanently unreadable, which is worse than refusing to start.
                return Err(MisalError::MalformedKey);
            }
            Ok(existing)
        }
        Err(keyring::Error::NoEntry) => {
            let mut bytes = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut bytes);
            let key = hex::encode(bytes);
            entry.set_password(&key)?;
            Ok(key)
        }
        Err(e) => Err(MisalError::Keychain(e)),
    }
}

/// Store a provider secret, keyed by account. Overwrites any existing value.
pub fn store_secret(keychain_key: &str, secret: &str) -> Result<()> {
    Entry::new(SERVICE, keychain_key)?.set_password(secret)?;
    Ok(())
}

pub fn read_secret(keychain_key: &str) -> Result<Option<String>> {
    match Entry::new(SERVICE, keychain_key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(MisalError::Keychain(e)),
    }
}

/// Remove a secret.
///
/// Deleting an account must call this. Removing only the database row would orphan a live
/// credential in the user's keychain, which is a quiet security failure rather than a visible
/// bug, so it is covered by an explicit test.
pub fn delete_secret(keychain_key: &str) -> Result<()> {
    match Entry::new(SERVICE, keychain_key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(MisalError::Keychain(e)),
    }
}

/// Deterministic keychain key for an account's provider secret.
pub fn account_secret_key(account_id: &str) -> String {
    format!("secret/{account_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_secret_keys_are_namespaced_and_stable() {
        assert_eq!(account_secret_key("abc-123"), "secret/abc-123");
        // Must not collide with the database key entry.
        assert_ne!(account_secret_key(DB_KEY_ACCOUNT), DB_KEY_ACCOUNT);
    }
}
