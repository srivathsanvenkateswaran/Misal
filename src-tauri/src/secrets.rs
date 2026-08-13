//! Secret storage, backed entirely by the operating system keychain.
//!
//! Nothing in this module ever writes a secret to disk, to the database, or to a log line.
//! The database stores only a reference (`credential_ref.keychain_key`); the secret itself
//! lives here.
//!
//! Platform backends: Keychain on macOS, Credential Manager on Windows, Secret Service on Linux.
//!
//! ## Reading the database key can block, and can be refused
//!
//! Asking the keychain for the database key is not a cheap local read. On macOS it can raise a
//! system authorization prompt and wait for a human; on Linux it talks to a keyring daemon over
//! D-Bus and waits for one to answer, which on a headless or minimal desktop is never. That is
//! why nothing calls `database_key` before a window exists: see `db::open_for_startup`.
//!
//! ## The Linux passphrase fallback
//!
//! Secret Service requires a running keyring daemon, which headless installs and minimal window
//! managers may lack (core-schema spec, "Linux caveat"). When no keychain answers there is a
//! second way in: the user supplies a passphrase, which SQLCipher itself turns into the page key.
//! `classify` is what makes that path reachable — it separates "no keychain answered", where a
//! passphrase is the only remaining door, from "the keychain answered and refused", where it is
//! not, because a passphrase there would key a *second*, divergent database.

use crate::error::{MisalError, Result};
use keyring::Entry;
use rand::RngCore;

const SERVICE: &str = "dev.misal.app";
const DB_KEY_ACCOUNT: &str = "db-key";

/// Why the keychain did not hand over a key.
///
/// Denial and absence are different situations and need different words. A user who clicked
/// "Deny" has a working keychain and a decision to revisit; a user whose keyring daemon is not
/// running has nothing to approve and needs another way in entirely. Collapsing both into
/// "keychain error" is what made the original failure unexplainable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeychainFailure {
    /// The request reached the keychain and was refused — the prompt was denied or dismissed, or
    /// the platform reported an authorisation failure.
    Denied,
    /// Nothing answered: no keyring daemon on Linux, a missing or unusable keychain elsewhere.
    Unavailable,
    /// An entry exists but is not a usable key. Never regenerate on this; see `database_key`.
    Malformed,
    /// Something else. The platform's own words are passed through for the user to report.
    Other,
}

/// macOS `OSStatus` values that mean the request was refused rather than unanswerable.
///
/// `keyring` maps neither of these to a dedicated variant — both arrive as `PlatformFailure` —
/// so the code is recovered from the platform error's own `Debug` output.
const DENIAL_CODES: [i32; 2] = [
    -128,   // errSecUserCanceled — the user dismissed or denied the prompt
    -25293, // errSecAuthFailed — authorisation refused
];

/// macOS `OSStatus` values that mean no keychain could serve the request.
const UNAVAILABLE_CODES: [i32; 5] = [
    -25291, // errSecNotAvailable
    -25292, // errSecReadOnly
    -25294, // errSecNoSuchKeychain
    -25295, // errSecInvalidKeychain
    -25308, // errSecInteractionNotAllowed — locked, and no UI may be shown
];

/// Phrases that mean a human, or a policy standing in for one, said no. Lowercased before use.
///
/// Secret Service reports a dismissed prompt as an error rather than a status code, so text is
/// the only signal available there.
const DENIAL_PHRASES: [&str; 6] = [
    "cancel",
    "denied",
    "dismiss",
    "not correct",
    "prompt",
    "refused by",
];

/// Phrases that mean nothing was there to answer.
const UNAVAILABLE_PHRASES: [&str; 8] = [
    "dbus",
    "d-bus",
    "session bus",
    "org.freedesktop.secrets",
    "service unavailable",
    "no such interface",
    "not available",
    "locked",
];

/// Classify a keychain error into the four situations the startup screen has words for.
pub fn classify(error: &keyring::Error) -> KeychainFailure {
    match error {
        // The stored blob is not even UTF-8, so it cannot be the hex key we wrote. Malformed,
        // never "missing" — the difference is what stops a replacement key being generated over
        // the top of a database that the old key still opens.
        keyring::Error::BadEncoding(_) => KeychainFailure::Malformed,
        keyring::Error::NoStorageAccess(inner) => {
            from_platform(&describe(inner.as_ref()), KeychainFailure::Unavailable)
        }
        keyring::Error::PlatformFailure(inner) => {
            from_platform(&describe(inner.as_ref()), KeychainFailure::Other)
        }
        _ => KeychainFailure::Other,
    }
}

/// The platform error, flattened to lowercase text.
///
/// Both `Display` and `Debug` are included: `Display` carries the human sentence a Secret Service
/// failure comes with, `Debug` carries the numeric `OSStatus` a macOS failure comes with. Neither
/// form of a keychain *failure* contains the secret — a failed read has no value to leak.
fn describe(inner: &(dyn std::error::Error + Send + Sync)) -> String {
    format!("{inner} {inner:?}").to_lowercase()
}

fn from_platform(text: &str, fallback: KeychainFailure) -> KeychainFailure {
    // Denial is tested first. "Prompt was dismissed" on a locked collection matches both lists,
    // and the refusal is the more specific — and more actionable — fact of the two.
    if has_code(text, &DENIAL_CODES) || DENIAL_PHRASES.iter().any(|p| text.contains(p)) {
        return KeychainFailure::Denied;
    }
    if has_code(text, &UNAVAILABLE_CODES) || UNAVAILABLE_PHRASES.iter().any(|p| text.contains(p)) {
        return KeychainFailure::Unavailable;
    }
    fallback
}

fn has_code(text: &str, codes: &[i32]) -> bool {
    codes
        .iter()
        .any(|code| text.contains(&format!("code: {code}")))
}

/// Fetch the database encryption key, generating and storing one on first run.
///
/// Returns 64 hex characters representing 32 random bytes, in the form SQLCipher's
/// `PRAGMA key = "x'...'"` expects.
///
/// May block: see the module header. Call it from a command, never from Tauri's `setup`.
pub fn database_key() -> Result<String> {
    let entry = Entry::new(SERVICE, DB_KEY_ACCOUNT)?;
    database_key_with(|| entry.get_password(), |key| entry.set_password(key))
}

/// The decision `database_key` makes, separated from the keychain so it can be tested without
/// one — including the case no test could otherwise reach, where the keychain refuses.
///
/// `set` is called on exactly one path: when the platform reports that no entry exists at all.
/// Every other outcome — a malformed entry, a refusal, an unreachable store — returns an error
/// with `set` untouched. That is not a stylistic choice. A fresh key would render an existing
/// database permanently unreadable, so "recovering" from a read failure by writing a new key
/// destroys exactly the data it was called to protect.
fn database_key_with<G, S>(get: G, set: S) -> Result<String>
where
    G: FnOnce() -> std::result::Result<String, keyring::Error>,
    S: FnOnce(&str) -> std::result::Result<(), keyring::Error>,
{
    match get() {
        Ok(existing) => {
            if !is_well_formed_key(&existing) {
                return Err(MisalError::MalformedKey);
            }
            Ok(existing)
        }
        Err(keyring::Error::NoEntry) => {
            let mut bytes = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut bytes);
            let key = hex::encode(bytes);
            set(&key)?;
            Ok(key)
        }
        Err(e) => Err(MisalError::Keychain(e)),
    }
}

/// 32 bytes of hex, and nothing else, is a database key.
pub fn is_well_formed_key(key: &str) -> bool {
    key.len() == 64 && key.chars().all(|c| c.is_ascii_hexdigit())
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
    use std::cell::Cell;

    const GOOD_KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    /// A platform error carrying a macOS `OSStatus`, shaped the way `security-framework` prints
    /// one, so the code-recovery path is exercised without a Mac in the loop.
    ///
    /// `Debug` is where the status survives once `keyring` has boxed the error, and `Display` is
    /// the localised sentence — which says nothing useful about which failure this is, which is
    /// exactly why the code has to be read.
    fn mac_error(code: i32) -> keyring::Error {
        struct MacStatus(i32);
        impl std::fmt::Debug for MacStatus {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "Error {{ code: {} }}", self.0)
            }
        }
        impl std::fmt::Display for MacStatus {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "The operation could not be completed")
            }
        }
        impl std::error::Error for MacStatus {}
        keyring::Error::PlatformFailure(Box::new(MacStatus(code)))
    }

    fn text_error(message: &str, no_storage_access: bool) -> keyring::Error {
        #[derive(Debug)]
        struct Text(String);
        impl std::fmt::Display for Text {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{}", self.0)
            }
        }
        impl std::error::Error for Text {}
        let boxed = Box::new(Text(message.to_string()));
        if no_storage_access {
            keyring::Error::NoStorageAccess(boxed)
        } else {
            keyring::Error::PlatformFailure(boxed)
        }
    }

    #[test]
    fn account_secret_keys_are_namespaced_and_stable() {
        assert_eq!(account_secret_key("abc-123"), "secret/abc-123");
        // Must not collide with the database key entry.
        assert_ne!(account_secret_key(DB_KEY_ACCOUNT), DB_KEY_ACCOUNT);
    }

    #[test]
    fn an_existing_key_is_returned_without_being_rewritten() {
        let wrote = Cell::new(false);
        let key = database_key_with(
            || Ok(GOOD_KEY.to_string()),
            |_| {
                wrote.set(true);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(key, GOOD_KEY);
        assert!(!wrote.get(), "an existing key was overwritten");
    }

    #[test]
    fn a_malformed_stored_key_is_refused_rather_than_regenerated() {
        // The whole point of the refusal: the database on disk is still keyed by whatever that
        // entry once was, and writing a fresh key would make it permanently unreadable.
        for stored in ["", "not-hex", &GOOD_KEY[..63], &format!("{GOOD_KEY}00")] {
            let wrote = Cell::new(false);
            let result = database_key_with(
                || Ok(stored.to_string()),
                |_| {
                    wrote.set(true);
                    Ok(())
                },
            );
            assert!(
                matches!(result, Err(MisalError::MalformedKey)),
                "{stored:?} was accepted or misreported"
            );
            assert!(
                !wrote.get(),
                "a replacement key was generated for {stored:?}"
            );
        }
    }

    #[test]
    fn a_refused_keychain_never_writes_a_key() {
        let wrote = Cell::new(false);
        let result = database_key_with(
            || Err(mac_error(-25293)),
            |_| {
                wrote.set(true);
                Ok(())
            },
        );
        match result {
            Err(MisalError::Keychain(e)) => assert_eq!(classify(&e), KeychainFailure::Denied),
            other => panic!("expected a keychain error, got {other:?}"),
        }
        assert!(!wrote.get(), "a denied read generated a replacement key");
    }

    #[test]
    fn a_first_run_generates_one_key_of_the_right_shape() {
        let stored: Cell<Option<String>> = Cell::new(None);
        let key = database_key_with(
            || Err(keyring::Error::NoEntry),
            |k| {
                stored.set(Some(k.to_string()));
                Ok(())
            },
        )
        .unwrap();
        assert!(is_well_formed_key(&key));
        assert_eq!(stored.into_inner().as_deref(), Some(key.as_str()));
    }

    #[test]
    fn a_denial_is_not_reported_as_an_absent_keychain() {
        assert_eq!(classify(&mac_error(-128)), KeychainFailure::Denied);
        assert_eq!(classify(&mac_error(-25293)), KeychainFailure::Denied);
        assert_eq!(
            classify(&text_error("Prompt was dismissed", true)),
            KeychainFailure::Denied
        );
    }

    #[test]
    fn an_absent_keyring_daemon_is_not_reported_as_a_denial() {
        assert_eq!(
            classify(&text_error(
                "zbus error: failed to connect to the D-Bus session bus",
                false
            )),
            KeychainFailure::Unavailable
        );
        assert_eq!(
            classify(&text_error(
                "The name org.freedesktop.secrets was not provided",
                false
            )),
            KeychainFailure::Unavailable
        );
        assert_eq!(classify(&mac_error(-25308)), KeychainFailure::Unavailable);
    }

    #[test]
    fn an_unreadable_entry_is_malformed_rather_than_missing() {
        assert_eq!(
            classify(&keyring::Error::BadEncoding(vec![0xff, 0xfe])),
            KeychainFailure::Malformed
        );
    }

    #[test]
    fn an_unrecognised_failure_stays_unrecognised() {
        // Guessing "denied" here would tell the user to approve a prompt that will never appear.
        assert_eq!(
            classify(&text_error("something entirely new", false)),
            KeychainFailure::Other
        );
    }
}
