//! Encrypted SQLite storage and forward-only migrations.

use crate::error::{MisalError, Result};
use crate::secrets::{self, KeychainFailure};
use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Migrations, applied in order. Forward-only; there is no down path.
///
/// Embedded with `include_str!` so a shipped binary can never disagree with the migration files
/// it was built from.
const MIGRATIONS: &[(i64, &str, &str)] = &[
    (1, "initial", include_str!("../migrations/0001-initial.sql")),
    (
        2,
        "sync-state",
        include_str!("../migrations/0002-sync-state.sql"),
    ),
    (
        3,
        "alias-uniqueness",
        include_str!("../migrations/0003-alias-uniqueness.sql"),
    ),
    (
        4,
        "exchange-sync",
        include_str!("../migrations/0004-exchange-sync.sql"),
    ),
    (
        5,
        "amc-identity",
        include_str!("../migrations/0005-amc-identity.sql"),
    ),
    (
        6,
        "unresolved-lifecycle",
        include_str!("../migrations/0006-unresolved-lifecycle.sql"),
    ),
    (
        7,
        "import-run-outstanding",
        include_str!("../migrations/0007-import-run-outstanding.sql"),
    ),
];

/// Location of the database file for this platform.
pub fn database_path() -> Result<PathBuf> {
    let dirs =
        directories::ProjectDirs::from("dev", "misal", "Misal").ok_or(MisalError::NoDataDir)?;
    let dir = dirs.data_dir();
    std::fs::create_dir_all(dir)?;
    Ok(dir.join("misal.db"))
}

/// What SQLCipher is keyed with.
pub enum Key<'a> {
    /// 64 hex characters — the 32-byte random key held in the OS keychain. The normal path.
    Hex(&'a str),
    /// A passphrase the user typed, for the case where no keychain will answer (the Linux
    /// caveat in the core-schema spec).
    ///
    /// Handed to SQLCipher verbatim, which runs it through its own PBKDF2-HMAC-SHA512 key
    /// derivation against the salt stored in the file's first page. Deliberately not derived
    /// here: a key-derivation function written for this one call site would be the least
    /// reviewed cryptography in the product. Never logged, never stored, never echoed back.
    Passphrase(&'a str),
}

/// Open the encrypted database, applying any outstanding migrations.
///
/// Reads the key from the keychain, which can block on a system prompt — so this must not be
/// called before a window exists. `open_for_startup` is the entry point the application uses.
pub fn open() -> Result<Connection> {
    let path = database_path()?;
    let key = secrets::database_key()?;
    let conn = open_at(&path, &key)?;
    migrate(&conn, &path)?;
    Ok(conn)
}

/// Open an encrypted database at an explicit path. Separated from `open` so tests can drive it
/// with a temporary file and a fixed key.
pub fn open_at(path: &Path, key_hex: &str) -> Result<Connection> {
    open_keyed(path, &Key::Hex(key_hex))
}

/// Open an encrypted database with either form of key material.
pub fn open_keyed(path: &Path, key: &Key<'_>) -> Result<Connection> {
    let conn = Connection::open(path)?;

    // Must be the first statement executed. SQLCipher derives the page key from it, and any
    // prior statement would be attempted against an undecrypted file.
    //
    // The value is bound through rusqlite's pragma escaping rather than concatenated, so a
    // passphrase containing a quote is a passphrase and not a syntax error.
    match key {
        Key::Hex(key_hex) => conn.pragma_update(None, "key", format!("x'{key_hex}'"))?,
        Key::Passphrase(passphrase) => conn.pragma_update(None, "key", *passphrase)?,
    }

    // Fails immediately with "file is not a database" if the key is wrong, rather than
    // surfacing as corruption later.
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))?;

    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;",
    )?;

    Ok(conn)
}

/// How opening the store turned out, in terms the startup screen can say out loud.
///
/// Every variant here is a *rendered* outcome rather than an error string: the frontend branches
/// on `status` and chooses the words, because "keychain unavailable: Platform secure storage
/// failure" is the message that left a user staring at an empty window with no idea what to do.
///
/// `detail` carries the platform's own sentence, for the user to quote in a bug report. A
/// keychain error describes a read that produced nothing, so there is no secret in it to leak.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum StartupOutcome {
    /// Open and migrated. Every other command can now be served.
    Ready,
    /// The keychain was reached and refused. The key is still there; the answer was no.
    KeychainDenied { detail: String },
    /// Nothing answered — typically no keyring daemon. The passphrase fallback applies here and
    /// only here: with no keychain there is no key to disagree with.
    KeychainUnavailable { detail: String },
    /// A database exists and the key we hold does not open it. Nothing is deleted, nothing is
    /// re-keyed, and no fresh key is generated: the file is intact and the wrong key is the
    /// problem.
    WrongKey,
    /// The stored key is not a key. Refusing to replace it, because a replacement would make an
    /// existing database permanently unreadable.
    MalformedKey,
    /// Anything else — a filesystem failure, a migration that would not apply.
    Failed { detail: String },
}

/// Open the store for startup, turning every failure into something the UI can explain.
///
/// Called from a command once the window is up, never from Tauri's `setup`. Reading the key can
/// raise a system authorization prompt on macOS and can block indefinitely on Linux, and doing
/// that before any UI exists is exactly the defect this function exists to remove: the user saw
/// an empty window and a password box with nothing to say what was asking or why.
///
/// `passphrase` is the fallback path. It is `Some` only when the user has been told the keychain
/// could not answer and has chosen to type one.
pub fn open_for_startup(
    passphrase: Option<&str>,
) -> std::result::Result<Connection, StartupOutcome> {
    let path = match database_path() {
        Ok(path) => path,
        Err(err) => {
            return Err(StartupOutcome::Failed {
                detail: err.to_string(),
            })
        }
    };
    open_startup_at(&path, passphrase, secrets::database_key)
}

/// The startup sequence with its key source injected, so a refusing keychain can be tested
/// without one — the failure that shipped precisely because no test could reach it.
fn open_startup_at<K>(
    path: &Path,
    passphrase: Option<&str>,
    key_from_keychain: K,
) -> std::result::Result<Connection, StartupOutcome>
where
    K: FnOnce() -> Result<String>,
{
    // The key is obtained before the file is touched. `Connection::open` creates the database on
    // the spot, and a half-created file left behind by a denied prompt would be the next launch's
    // corruption report.
    let opened = match passphrase {
        Some(passphrase) => open_keyed(path, &Key::Passphrase(passphrase)),
        None => match key_from_keychain() {
            Ok(key_hex) => open_keyed(path, &Key::Hex(&key_hex)),
            Err(err) => return Err(from_key_error(&err)),
        },
    };

    let conn = match opened {
        Ok(conn) => conn,
        Err(err) => return Err(from_open_error(&err)),
    };

    match migrate(&conn, path) {
        Ok(()) => Ok(conn),
        Err(err) => Err(StartupOutcome::Failed {
            detail: err.to_string(),
        }),
    }
}

/// A key that could not be fetched, in the user's terms.
fn from_key_error(error: &MisalError) -> StartupOutcome {
    match error {
        MisalError::MalformedKey => StartupOutcome::MalformedKey,
        MisalError::Keychain(keychain) => match secrets::classify(keychain) {
            KeychainFailure::Denied => StartupOutcome::KeychainDenied {
                detail: keychain.to_string(),
            },
            KeychainFailure::Unavailable => StartupOutcome::KeychainUnavailable {
                detail: keychain.to_string(),
            },
            KeychainFailure::Malformed => StartupOutcome::MalformedKey,
            KeychainFailure::Other => StartupOutcome::Failed {
                detail: keychain.to_string(),
            },
        },
        other => StartupOutcome::Failed {
            detail: other.to_string(),
        },
    }
}

/// A database that would not open, in the user's terms.
fn from_open_error(error: &MisalError) -> StartupOutcome {
    // SQLCipher reports a key that does not decrypt the file as NotADatabase, which is the same
    // code a genuinely corrupt file gives. Naming it "wrong key" is the honest reading here:
    // the file was written by this application, and the only thing that changed is the key.
    if let MisalError::Db(rusqlite::Error::SqliteFailure(failure, _)) = error {
        if failure.code == rusqlite::ErrorCode::NotADatabase {
            return StartupOutcome::WrongKey;
        }
    }
    StartupOutcome::Failed {
        detail: error.to_string(),
    }
}

fn current_version(conn: &Connection) -> Result<i64> {
    let table_exists: bool = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='schema_migration'",
        [],
        |row| row.get::<_, i64>(0),
    )? > 0;

    if !table_exists {
        return Ok(0);
    }

    Ok(conn
        .query_row(
            "SELECT coalesce(max(version), 0) FROM schema_migration",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0))
}

/// Apply outstanding migrations, each in its own transaction.
///
/// Any migration beyond the first backs the database up first. This database holds data the user
/// cannot re-derive - hand-entered corrections and resolved instrument mappings - so a failed
/// schema change must never be the reason they lose it.
pub fn migrate(conn: &Connection, db_path: &Path) -> Result<()> {
    let from = current_version(conn)?;
    let outstanding: Vec<_> = MIGRATIONS.iter().filter(|(v, _, _)| *v > from).collect();

    if outstanding.is_empty() {
        return Ok(());
    }

    if from > 0 {
        backup(conn, db_path, from)?;
    }

    for (version, name, sql) in outstanding {
        conn.execute_batch("BEGIN")?;
        let applied = conn.execute_batch(sql).and_then(|()| {
            conn.execute(
                "INSERT INTO schema_migration (version, name, applied_at)
                     VALUES (?1, ?2, datetime('now'))",
                rusqlite::params![version, name],
            )
            .map(|_| ())
        });

        match applied {
            Ok(()) => conn.execute_batch("COMMIT")?,
            Err(source) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(MisalError::Migration {
                    version: *version,
                    name: (*name).to_string(),
                    source,
                });
            }
        }
    }

    Ok(())
}

/// Write a timestamped copy of the database beside the original.
///
/// SQLite's online backup API is unavailable here - SQLCipher rejects it with "backup is not
/// supported with encrypted databases" - so this checkpoints the write-ahead log into the main
/// file and then copies the bytes.
///
/// Copying ciphertext is the right approach rather than a compromise: the backup is byte-identical
/// to the original and opens with the same key, so recovery is just renaming the file. It is also
/// impossible for the backup to be less encrypted than the source.
///
/// Safe to do with the connection open because migrations run single-threaded at startup, before
/// any other writer exists. The TRUNCATE checkpoint leaves the WAL empty, so the main file alone
/// is a complete copy.
fn backup(conn: &Connection, db_path: &Path, from_version: i64) -> Result<()> {
    let stamp: String =
        conn.query_row("SELECT strftime('%Y%m%dT%H%M%SZ', 'now')", [], |r| r.get(0))?;

    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;

    let target = db_path.with_file_name(format!("misal.v{from_version}.{stamp}.backup.db"));
    std::fs::copy(db_path, &target)?;

    // A backup that did not actually capture anything is worse than no backup, because it
    // invites false confidence. An empty file means the copy raced a checkpoint.
    let copied = std::fs::metadata(&target)?.len();
    if copied == 0 {
        let _ = std::fs::remove_file(&target);
        return Err(MisalError::Other(
            "pre-migration backup was empty; refusing to migrate".to_string(),
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const TEST_KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    fn temp_db() -> (TempDir, PathBuf) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.db");
        (dir, path)
    }

    /// Highest version defined in MIGRATIONS, so these tests do not need editing every time a
    /// migration is added.
    fn latest_version() -> i64 {
        MIGRATIONS.iter().map(|(v, _, _)| *v).max().unwrap_or(0)
    }

    /// A keychain that refuses, without a keychain.
    fn refusing_keychain(message: &'static str) -> impl FnOnce() -> Result<String> {
        #[derive(Debug)]
        struct Refusal(&'static str);
        impl std::fmt::Display for Refusal {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{}", self.0)
            }
        }
        impl std::error::Error for Refusal {}
        move || {
            Err(MisalError::Keychain(keyring::Error::PlatformFailure(
                Box::new(Refusal(message)),
            )))
        }
    }

    #[test]
    fn a_denied_keychain_produces_an_explainable_outcome_and_creates_nothing() {
        // The defect this replaces: the key was read from Tauri's `setup`, before any window
        // existed, so a denial produced no database, no error and no screen - just an empty
        // window behind a system password box. Startup must now always end somewhere sayable.
        let (_dir, path) = temp_db();
        let outcome = open_startup_at(
            &path,
            None,
            refusing_keychain("User canceled the operation"),
        )
        .expect_err("a denied keychain opened the database");

        match outcome {
            StartupOutcome::KeychainDenied { detail } => assert!(!detail.is_empty()),
            other => panic!("a denial was reported as {other:?}"),
        }
        assert!(
            !path.exists(),
            "a denied keychain still created a database file"
        );
    }

    #[test]
    fn an_absent_keyring_daemon_is_told_apart_from_a_denial() {
        // Different situations, different words, and only one of them has a passphrase fallback:
        // there is nothing for the user to approve when no keychain is running at all.
        let (_dir, path) = temp_db();
        let outcome = open_startup_at(
            &path,
            None,
            refusing_keychain("failed to connect to the D-Bus session bus"),
        )
        .expect_err("an unreachable keychain opened the database");

        assert!(
            matches!(outcome, StartupOutcome::KeychainUnavailable { .. }),
            "an absent keyring daemon was reported as {outcome:?}"
        );
        assert!(!path.exists());
    }

    #[test]
    fn a_malformed_stored_key_reaches_the_screen_rather_than_a_new_key() {
        let (_dir, path) = temp_db();
        let outcome = open_startup_at(&path, None, || Err(MisalError::MalformedKey))
            .expect_err("a malformed key opened the database");
        assert_eq!(outcome, StartupOutcome::MalformedKey);
        assert!(
            !path.exists(),
            "a malformed key led to a database being created"
        );
    }

    #[test]
    fn the_passphrase_fallback_opens_and_reopens_a_database() {
        // The Linux caveat made reachable: with no keychain to answer, a passphrase is the only
        // remaining door, and it has to still work on the second launch.
        let (_dir, path) = temp_db();
        {
            let conn = open_startup_at(&path, Some("correct horse battery staple"), || {
                panic!("the keychain was consulted despite a passphrase being supplied")
            })
            .expect("the passphrase did not open a fresh database");
            assert_eq!(current_version(&conn).unwrap(), latest_version());
            conn.execute(
                "INSERT INTO setting (key, value, updated_at) VALUES ('probe', 'kept', 'now')",
                [],
            )
            .unwrap();
        }

        let reopened = open_startup_at(&path, Some("correct horse battery staple"), || {
            panic!("the keychain was consulted despite a passphrase being supplied")
        })
        .expect("the passphrase did not reopen its own database");
        let kept: String = reopened
            .query_row("SELECT value FROM setting WHERE key = 'probe'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(kept, "kept");
    }

    #[test]
    fn a_key_that_does_not_open_the_file_is_named_as_such_and_destroys_nothing() {
        let (_dir, path) = temp_db();
        {
            let conn = open_at(&path, TEST_KEY).unwrap();
            migrate(&conn, &path).unwrap();
            conn.execute(
                "INSERT INTO setting (key, value, updated_at) VALUES ('probe', 'kept', 'now')",
                [],
            )
            .unwrap();
        }

        let outcome = open_startup_at(
            &path,
            Some("not the key this file was written with"),
            || panic!("unreachable"),
        )
        .expect_err("the wrong key opened the database");
        assert_eq!(outcome, StartupOutcome::WrongKey);

        // The file has to survive being opened with the wrong key, or the error screen would be
        // reporting damage it caused itself.
        let intact = open_at(&path, TEST_KEY).expect("the database no longer opens with its key");
        let kept: String = intact
            .query_row("SELECT value FROM setting WHERE key = 'probe'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(kept, "kept");
    }

    #[test]
    fn a_working_keychain_opens_and_migrates() {
        let (_dir, path) = temp_db();
        let conn = open_startup_at(&path, None, || Ok(TEST_KEY.to_string()))
            .expect("a working keychain failed to open the database");
        assert_eq!(current_version(&conn).unwrap(), latest_version());
    }

    #[test]
    fn every_outcome_serialises_to_the_shape_the_frontend_branches_on() {
        // The TypeScript union in src/data/startup.ts is written against these exact strings.
        let json = |outcome: &StartupOutcome| serde_json::to_string(outcome).unwrap();
        assert_eq!(json(&StartupOutcome::Ready), r#"{"status":"ready"}"#);
        assert_eq!(json(&StartupOutcome::WrongKey), r#"{"status":"wrong-key"}"#);
        assert_eq!(
            json(&StartupOutcome::MalformedKey),
            r#"{"status":"malformed-key"}"#
        );
        assert_eq!(
            json(&StartupOutcome::KeychainDenied {
                detail: "no".to_string()
            }),
            r#"{"status":"keychain-denied","detail":"no"}"#
        );
        assert_eq!(
            json(&StartupOutcome::KeychainUnavailable {
                detail: "no daemon".to_string()
            }),
            r#"{"status":"keychain-unavailable","detail":"no daemon"}"#
        );
        assert_eq!(
            json(&StartupOutcome::Failed {
                detail: "disk".to_string()
            }),
            r#"{"status":"failed","detail":"disk"}"#
        );
    }

    #[test]
    fn migrates_a_fresh_database_to_the_latest_version() {
        let (_dir, path) = temp_db();
        let conn = open_at(&path, TEST_KEY).unwrap();
        migrate(&conn, &path).unwrap();
        assert_eq!(current_version(&conn).unwrap(), latest_version());
    }

    #[test]
    fn migration_is_idempotent() {
        let (_dir, path) = temp_db();
        let conn = open_at(&path, TEST_KEY).unwrap();
        migrate(&conn, &path).unwrap();
        migrate(&conn, &path).unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM schema_migration", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, latest_version());
    }

    #[test]
    fn migrating_an_existing_database_backs_it_up_first() {
        // This store holds hand-entered corrections and resolved instrument mappings that the
        // user cannot re-derive, so a schema change must never be the reason they lose it.
        let (dir, path) = temp_db();
        let conn = open_at(&path, TEST_KEY).unwrap();

        // Apply only migration 1, leaving 2 outstanding.
        conn.execute_batch(MIGRATIONS[0].2).unwrap();
        conn.execute(
            "INSERT INTO schema_migration (version, name, applied_at) VALUES (1, 'initial', 'now')",
            [],
        )
        .unwrap();

        migrate(&conn, &path).unwrap();

        let backups: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".backup.db"))
            .collect();
        assert_eq!(backups.len(), 1, "no backup was written before migrating");
        assert_eq!(current_version(&conn).unwrap(), latest_version());

        // Existence is not the point - restorability is. Open the backup with the same key and
        // confirm it holds real pre-migration data, and that it stopped at version 1.
        let restored = open_at(&backups[0].path(), TEST_KEY).expect("backup will not open");
        let providers: i64 = restored
            .query_row("SELECT count(*) FROM provider", [], |r| r.get(0))
            .expect("backup has no provider table");
        assert!(providers > 0, "backup opened but contains no data");
        assert_eq!(
            current_version(&restored).unwrap(),
            1,
            "backup was taken after the migration rather than before it"
        );
    }

    #[test]
    fn sync_state_survives_account_deletion_by_cascading() {
        let (_dir, path) = temp_db();
        let conn = open_at(&path, TEST_KEY).unwrap();
        migrate(&conn, &path).unwrap();

        conn.execute(
            "INSERT INTO account (id, provider_id, label, capability, base_currency, created_at)
             VALUES ('a1', 'binance', 'Binance', 'snapshot', 'INR', 'now')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_state (account_id, stream, scope, cursor)
             VALUES ('a1', 'trades', 'BTCUSDT', '12345')",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM account WHERE id = 'a1'", [])
            .unwrap();

        let left: i64 = conn
            .query_row("SELECT count(*) FROM sync_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "sync cursors outlived their account");
    }

    #[test]
    fn a_global_alias_cannot_be_claimed_by_two_instruments() {
        // instrument_alias's PRIMARY KEY does not constrain these rows: provider_id is NULL for
        // every global scheme, and SQLite treats NULLs in a unique index as distinct. One ISIN
        // resolving to two instruments would double a holding in net worth, and pick a different
        // one between runs.
        let (_dir, path) = temp_db();
        let conn = open_at(&path, TEST_KEY).unwrap();
        migrate(&conn, &path).unwrap();

        conn.execute_batch(
            "INSERT INTO instrument (id, asset_class, display_name, currency, created_at)
               VALUES ('i1', 'indian_equity', 'Infosys', 'INR', 'now'),
                      ('i2', 'indian_equity', 'Infosys duplicate', 'INR', 'now');",
        )
        .unwrap();

        let insert = "INSERT INTO instrument_alias (instrument_id, scheme, value, provider_id)
                      VALUES (?1, 'isin', 'INE009A01021', NULL)";
        conn.execute(insert, ["i1"]).unwrap();
        assert!(
            conn.execute(insert, ["i2"]).is_err(),
            "the same ISIN was claimed by two instruments"
        );

        // A provider-local code is genuinely per-provider and must still be allowed twice.
        let local = "INSERT INTO instrument_alias (instrument_id, scheme, value, provider_id)
                     VALUES (?1, 'provider-local', 'INFY', ?2)";
        conn.execute(local, ["i1", "zerodha-kite"]).unwrap();
        conn.execute(local, ["i2", "groww"]).unwrap();
    }

    #[test]
    fn the_alias_migration_deduplicates_an_existing_database() {
        // A database written before migration 3 can already hold duplicates, so the migration has
        // to clean up before it can constrain - otherwise it fails and the user is stuck.
        let (_dir, path) = temp_db();
        let conn = open_at(&path, TEST_KEY).unwrap();
        conn.execute_batch(MIGRATIONS[0].2).unwrap();
        conn.execute_batch(MIGRATIONS[1].2).unwrap();
        conn.execute(
            "INSERT INTO schema_migration (version, name, applied_at)
             VALUES (1, 'initial', 'now'), (2, 'sync-state', 'now')",
            [],
        )
        .unwrap();

        conn.execute_batch(
            "INSERT INTO instrument (id, asset_class, display_name, currency, created_at)
               VALUES ('i1', 'indian_equity', 'A', 'INR', 'now'),
                      ('i2', 'indian_equity', 'B', 'INR', 'now');
             INSERT INTO instrument_alias (instrument_id, scheme, value, provider_id)
               VALUES ('i1', 'isin', 'INE009A01021', NULL),
                      ('i2', 'isin', 'INE009A01021', NULL);",
        )
        .unwrap();

        migrate(&conn, &path).unwrap();

        let left: i64 = conn
            .query_row(
                "SELECT count(*) FROM instrument_alias WHERE scheme = 'isin'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 1, "duplicates survived the migration");
    }

    #[test]
    fn binance_is_not_tagged_as_an_indian_provider() {
        // Indian users trade on the same global api.binance.com as everyone else; there is no
        // separate India entity or endpoint.
        let (_dir, path) = temp_db();
        let conn = open_at(&path, TEST_KEY).unwrap();
        migrate(&conn, &path).unwrap();
        let country: String = conn
            .query_row(
                "SELECT country FROM provider WHERE id = 'binance'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(country, "GLOBAL");
    }

    #[test]
    fn database_is_actually_encrypted_on_disk() {
        let (_dir, path) = temp_db();
        {
            let conn = open_at(&path, TEST_KEY).unwrap();
            migrate(&conn, &path).unwrap();
            conn.execute(
                "INSERT INTO setting (key, value, updated_at) VALUES ('probe', 'SENTINEL', 'now')",
                [],
            )
            .unwrap();
        }
        let bytes = std::fs::read(&path).unwrap();
        // A plaintext SQLite file starts with this header and would contain our sentinel.
        assert!(
            !bytes.starts_with(b"SQLite format 3"),
            "file is not encrypted"
        );
        assert!(
            !bytes.windows(8).any(|w| w == b"SENTINEL"),
            "plaintext value found in the database file"
        );
    }

    #[test]
    fn wrong_key_fails_to_open_rather_than_appearing_empty() {
        let (_dir, path) = temp_db();
        {
            let conn = open_at(&path, TEST_KEY).unwrap();
            migrate(&conn, &path).unwrap();
        }
        let wrong = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        assert!(open_at(&path, wrong).is_err());
    }

    #[test]
    fn seeded_providers_carry_stamp_codes() {
        let (_dir, path) = temp_db();
        let conn = open_at(&path, TEST_KEY).unwrap();
        migrate(&conn, &path).unwrap();
        let code: String = conn
            .query_row(
                "SELECT short_code FROM provider WHERE id = 'cams-cas'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(code, "CAS");
    }

    #[test]
    fn identical_same_day_transactions_both_survive() {
        // Two SIP instalments on the same day at the same NAV for the same amount are real.
        // Deduplicating one away is silent data loss, so `occurrence` distinguishes them.
        let (_dir, path) = temp_db();
        let conn = open_at(&path, TEST_KEY).unwrap();
        migrate(&conn, &path).unwrap();

        conn.execute_batch(
            "INSERT INTO account (id, provider_id, label, capability, base_currency, created_at)
               VALUES ('a1', 'cams-cas', 'Test', 'ledger', 'INR', 'now');
             INSERT INTO instrument (id, asset_class, display_name, currency, created_at)
               VALUES ('i1', 'mutual_fund', 'Test Fund', 'INR', 'now');
             INSERT INTO source_document (id, provider_id, kind, content_hash, imported_at)
               VALUES ('d1', 'cams-cas', 'cas-pdf', 'hash1', 'now');",
        )
        .unwrap();

        let insert = "INSERT INTO txn (id, account_id, instrument_id, type, occurred_at, quantity,
                        currency, source_document_id, natural_key, occurrence, created_at)
                      VALUES (?1, 'a1', 'i1', 'buy', '2026-01-05T00:00:00Z', '10.5000',
                        'INR', 'd1', 'samekey', ?2, 'now')";
        conn.execute(insert, rusqlite::params!["t1", 0]).unwrap();
        conn.execute(insert, rusqlite::params!["t2", 1]).unwrap();

        // The same occurrence is a true duplicate and must be rejected.
        assert!(conn.execute(insert, rusqlite::params!["t3", 1]).is_err());

        let count: i64 = conn
            .query_row("SELECT count(*) FROM txn", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn the_same_folio_from_two_providers_is_one_account() {
        // A folio arriving in both a CAMS CAS and an NSDL eCAS must not become two accounts,
        // or its units would be counted twice in net worth.
        let (_dir, path) = temp_db();
        let conn = open_at(&path, TEST_KEY).unwrap();
        migrate(&conn, &path).unwrap();

        conn.execute(
            "INSERT INTO account (id, provider_id, label, identity_key, capability, base_currency, created_at)
             VALUES ('a1', 'cams-cas', 'HDFC folio', 'mf-folio:HDFC:12345678/91', 'ledger', 'INR', 'now')",
            [],
        )
        .unwrap();

        let duplicate = conn.execute(
            "INSERT INTO account (id, provider_id, label, identity_key, capability, base_currency, created_at)
             VALUES ('a2', 'nsdl-cas', 'HDFC folio', 'mf-folio:HDFC:12345678/91', 'snapshot', 'INR', 'now')",
            [],
        );
        assert!(duplicate.is_err(), "the same folio was admitted twice");
    }

    #[test]
    fn a_manual_price_coexists_with_a_fetched_one() {
        let (_dir, path) = temp_db();
        let conn = open_at(&path, TEST_KEY).unwrap();
        migrate(&conn, &path).unwrap();

        conn.execute(
            "INSERT INTO instrument (id, asset_class, display_name, currency, created_at)
             VALUES ('i1', 'indian_equity', 'Infosys', 'INR', 'now')",
            [],
        )
        .unwrap();

        let insert = "INSERT INTO price (instrument_id, as_of, close, currency, source, fetched_at)
                      VALUES ('i1', '2026-08-12', ?1, 'INR', ?2, 'now')";
        conn.execute(insert, rusqlite::params!["1500.00", "yahoo"])
            .unwrap();
        conn.execute(insert, rusqlite::params!["1512.50", "manual"])
            .unwrap();

        let count: i64 = conn
            .query_row("SELECT count(*) FROM price", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2, "the manual override destroyed the fetched value");
    }
}
