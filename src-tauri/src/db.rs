//! Encrypted SQLite storage and forward-only migrations.

use crate::error::{MisalError, Result};
use crate::secrets;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// Migrations, applied in order. Forward-only; there is no down path.
///
/// Embedded with `include_str!` so a shipped binary can never disagree with the migration files
/// it was built from.
const MIGRATIONS: &[(i64, &str, &str)] =
    &[(1, "initial", include_str!("../migrations/0001-initial.sql"))];

/// Location of the database file for this platform.
pub fn database_path() -> Result<PathBuf> {
    let dirs =
        directories::ProjectDirs::from("dev", "misal", "Misal").ok_or(MisalError::NoDataDir)?;
    let dir = dirs.data_dir();
    std::fs::create_dir_all(dir)?;
    Ok(dir.join("misal.db"))
}

/// Open the encrypted database, applying any outstanding migrations.
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
    let conn = Connection::open(path)?;

    // Must be the first statement executed. SQLCipher derives the page key from it, and any
    // prior statement would be attempted against an undecrypted file.
    conn.pragma_update(None, "key", format!("x'{key_hex}'"))?;

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
fn backup(conn: &Connection, db_path: &Path, from_version: i64) -> Result<()> {
    let stamp: String =
        conn.query_row("SELECT strftime('%Y%m%dT%H%M%SZ', 'now')", [], |r| r.get(0))?;
    let target = db_path.with_file_name(format!("misal.v{from_version}.{stamp}.backup.db",));
    // Uses SQLite's own backup API rather than a file copy, so an active WAL is included.
    conn.backup(rusqlite::DatabaseName::Main, &target, None)?;
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

    #[test]
    fn migrates_a_fresh_database_to_the_latest_version() {
        let (_dir, path) = temp_db();
        let conn = open_at(&path, TEST_KEY).unwrap();
        migrate(&conn, &path).unwrap();
        assert_eq!(current_version(&conn).unwrap(), 1);
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
        assert_eq!(count, 1);
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
