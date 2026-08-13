//! Deleting an account, and the standing review queue behind the settings screen.
//!
//! Two things live here because they are the same absence seen twice: Misal could write an account
//! and could withhold an instrument's value, and had no way to undo either. A valuation failure
//! caused by one bad account could only be recovered from by deleting the encrypted database — and
//! every statement ever imported with it — because there was no `account_delete`. A dismissed
//! unresolved entry stayed withheld from net worth with nothing on any screen that could show it
//! again.
//!
//! **Deletion order mirrors `disconnect.rs`, deliberately.** The keychain entry goes first. If it
//! fails, the command fails and every row stays, so the user sees an account that is still there —
//! which is true. Removing the rows first and failing on the keychain would leave a live,
//! full-access API key on the machine belonging to an account the user can no longer see, which is
//! the one outcome that must not be reachable. `disconnect.rs` states the same rule for the
//! narrower case of dropping only the credential.
//!
//! **The database half is one transaction.** `rusqlite::Transaction` rolls back on drop, so every
//! early return below leaves the store exactly as it was found. A half-deleted account — positions
//! gone, transactions kept — would be a portfolio silently missing a slice of its history with no
//! error anywhere to explain it.
//!
//! **Source documents are not the account's to destroy.** A CAMS consolidated statement carries
//! several folios, and `source_document.account_id` is NULL when the pipeline saw more than one
//! account in the file. Every fact table references the document with `ON DELETE CASCADE`, so
//! removing a document another account's rows still cite would delete *that* account's
//! transactions as a side effect of deleting this one. Shared documents are therefore detached
//! from the account being removed rather than deleted, and only documents nothing else references
//! go.

use crate::error::{MisalError, Result};
use crate::secrets;
use crate::AppState;
use chrono::SecondsFormat;
use rusqlite::Connection;
use serde::Serialize;

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

// ---------------------------------------------------------------------------
// What deleting an account would cost
// ---------------------------------------------------------------------------

/// Everything the confirmation must state before it is allowed to be irreversible.
///
/// Counts rather than a summary sentence: "this deletes your data" is not something a user can
/// weigh, and "412 transactions, 9 holdings, imported from 6 statements" is. The value the account
/// contributes to net worth is deliberately **not** here — valuation lives in TypeScript
/// (`src/valuation/`), and a second implementation in SQL would be a second thing to disagree with
/// the dashboard. The screen pairs this with the figure the valuation engine already computed.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletionPreview {
    pub account_id: String,
    pub label: String,
    pub provider_id: String,
    pub capability: String,
    pub transactions: i64,
    /// Distinct instruments held, not position rows: a holding restated on four dates is one
    /// holding. Counting rows would overstate what is being destroyed.
    pub holdings: i64,
    pub position_rows: i64,
    /// Entries in the review queue this account raised. They disappear with it, and their withheld
    /// value stops being withheld because the holding itself is gone.
    pub queue_entries: i64,
    /// Documents nothing else references, which go with the account.
    pub documents_removed: i64,
    /// Documents other accounts' rows still cite. Kept, and detached from this account.
    pub documents_shared: i64,
    /// Whether a keychain entry will be deleted. Never the key, never its name.
    pub has_credential: bool,
    pub sync_cursors: i64,
}

/// The predicate for "this document belongs to no one else".
///
/// Used identically by the preview and by the delete, so the count the user confirmed is the count
/// that happens. Written once as a const rather than twice as prose.
const DOCUMENT_IS_TOUCHED: &str = "(d.account_id = ?1
      OR EXISTS (SELECT 1 FROM txn t WHERE t.source_document_id = d.id AND t.account_id = ?1)
      OR EXISTS (SELECT 1 FROM position p WHERE p.source_document_id = d.id AND p.account_id = ?1)
      OR EXISTS (SELECT 1 FROM unresolved_instrument u
                  WHERE (u.source_document_id = d.id OR u.last_seen_document_id = d.id)
                    AND u.account_id = ?1))";

const DOCUMENT_IS_SHARED: &str = "((d.account_id IS NOT NULL AND d.account_id <> ?1)
      OR EXISTS (SELECT 1 FROM txn t WHERE t.source_document_id = d.id AND t.account_id <> ?1)
      OR EXISTS (SELECT 1 FROM position p WHERE p.source_document_id = d.id AND p.account_id <> ?1)
      OR EXISTS (SELECT 1 FROM unresolved_instrument u
                  WHERE (u.source_document_id = d.id OR u.last_seen_document_id = d.id)
                    AND u.account_id <> ?1))";

fn count(conn: &Connection, sql: &str, account_id: &str) -> Result<i64> {
    Ok(conn.query_row(sql, [account_id], |r| r.get(0))?)
}

/// What `account_delete` would destroy, read without changing anything.
pub fn deletion_preview(conn: &Connection, account_id: &str) -> Result<DeletionPreview> {
    let (label, provider_id, capability) = conn
        .query_row(
            "SELECT label, provider_id, capability FROM account WHERE id = ?1",
            [account_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => {
                MisalError::Other(format!("no account {account_id}"))
            }
            other => MisalError::Db(other),
        })?;

    let documents_removed = count(
        conn,
        &format!(
            "SELECT count(*) FROM source_document d
              WHERE {DOCUMENT_IS_TOUCHED} AND NOT {DOCUMENT_IS_SHARED}"
        ),
        account_id,
    )?;
    let documents_shared = count(
        conn,
        &format!(
            "SELECT count(*) FROM source_document d
              WHERE {DOCUMENT_IS_TOUCHED} AND {DOCUMENT_IS_SHARED}"
        ),
        account_id,
    )?;

    Ok(DeletionPreview {
        account_id: account_id.to_string(),
        label,
        provider_id,
        capability,
        transactions: count(
            conn,
            "SELECT count(*) FROM txn WHERE account_id = ?1",
            account_id,
        )?,
        holdings: count(
            conn,
            "SELECT count(DISTINCT instrument_id) FROM position WHERE account_id = ?1",
            account_id,
        )?,
        position_rows: count(
            conn,
            "SELECT count(*) FROM position WHERE account_id = ?1",
            account_id,
        )?,
        queue_entries: count(
            conn,
            "SELECT count(*) FROM unresolved_instrument
              WHERE account_id = ?1 AND resolved_at IS NULL",
            account_id,
        )?,
        documents_removed,
        documents_shared,
        has_credential: count(
            conn,
            "SELECT count(*) FROM credential_ref WHERE account_id = ?1",
            account_id,
        )? > 0,
        sync_cursors: count(
            conn,
            "SELECT count(*) FROM sync_state WHERE account_id = ?1",
            account_id,
        )?,
    })
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

/// What was actually removed, so the screen reports the outcome rather than restating the warning.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeletionOutcome {
    pub label: String,
    pub transactions: i64,
    pub positions: i64,
    pub queue_entries: i64,
    pub documents_removed: i64,
    pub documents_kept_shared: i64,
    pub credential_forgotten: bool,
}

/// Forget a stored secret. Injected so a test can prove the ordering and the rollback without
/// touching the machine's real keychain — which would prompt on macOS and block on Linux, and is
/// exactly why the ordering rule went untested until now.
pub trait SecretStore {
    fn forget(&mut self, keychain_key: &str) -> Result<()>;
}

/// The real one.
pub struct OsKeychain;

impl SecretStore for OsKeychain {
    fn forget(&mut self, keychain_key: &str) -> Result<()> {
        secrets::delete_secret(keychain_key)
    }
}

/// Remove an account and everything that is only its own.
///
/// The keychain entry goes before the transaction opens; see the module header for why that
/// ordering is the safe one rather than the convenient one.
pub fn delete_account(
    conn: &mut Connection,
    account_id: &str,
    secrets: &mut dyn SecretStore,
) -> Result<DeletionOutcome> {
    let preview = deletion_preview(conn, account_id)?;

    // Both the reference the database holds and the key `disconnect.rs` derives. They are the same
    // string for every account Misal has ever written; deleting both means a row written by some
    // future path that named its entry differently still cannot leave a live key behind.
    let stored: Option<String> = conn
        .query_row(
            "SELECT keychain_key FROM credential_ref WHERE account_id = ?1",
            [account_id],
            |r| r.get(0),
        )
        .ok();
    let derived = secrets::account_secret_key(account_id);
    let mut keys = vec![derived.clone()];
    if let Some(key) = stored {
        if key != derived {
            keys.push(key);
        }
    }
    for key in &keys {
        secrets.forget(key)?;
    }

    let tx = conn.transaction()?;

    // Detach before deleting, not after. `source_document.account_id` cascades, so a shared
    // document still carrying this account's id would be taken by the delete below and would take
    // another account's transactions with it.
    let documents_kept_shared = tx.execute(
        &format!(
            "UPDATE source_document SET account_id = NULL
              WHERE account_id = ?1
                AND EXISTS (SELECT 1 FROM source_document d
                             WHERE d.id = source_document.id AND {DOCUMENT_IS_SHARED})"
        ),
        [account_id],
    )?;

    // The documents nothing else will reference once this account is gone, resolved before any row
    // is removed so the set is computed against the store the user was shown.
    let doomed: Vec<String> = {
        let mut stmt = tx.prepare(&format!(
            "SELECT d.id FROM source_document d
              WHERE {DOCUMENT_IS_TOUCHED} AND NOT {DOCUMENT_IS_SHARED}"
        ))?;
        let rows = stmt.query_map([account_id], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    // Explicit rather than left to the cascades. Every one of these has ON DELETE CASCADE from
    // `account`, but a delete that says what it removes can be read against the schema, and it
    // does not silently become a no-op if `PRAGMA foreign_keys` is ever off on some connection.
    let queue_entries = tx.execute(
        "DELETE FROM unresolved_instrument WHERE account_id = ?1",
        [account_id],
    )?;
    let positions = tx.execute("DELETE FROM position WHERE account_id = ?1", [account_id])?;
    let transactions = tx.execute("DELETE FROM txn WHERE account_id = ?1", [account_id])?;
    tx.execute("DELETE FROM sync_state WHERE account_id = ?1", [account_id])?;
    tx.execute(
        "DELETE FROM exchange_account_state WHERE account_id = ?1",
        [account_id],
    )?;
    tx.execute(
        "DELETE FROM credential_ref WHERE account_id = ?1",
        [account_id],
    )?;

    let mut documents_removed = 0usize;
    for id in &doomed {
        documents_removed += tx.execute("DELETE FROM source_document WHERE id = ?1", [id])?;
    }

    let gone = tx.execute("DELETE FROM account WHERE id = ?1", [account_id])?;
    if gone == 0 {
        return Err(MisalError::Other(format!(
            "no account {account_id} to delete"
        )));
    }

    tx.commit()?;

    Ok(DeletionOutcome {
        label: preview.label,
        transactions: transactions as i64,
        positions: positions as i64,
        queue_entries: queue_entries as i64,
        documents_removed: documents_removed as i64,
        documents_kept_shared: documents_kept_shared as i64,
        credential_forgotten: preview.has_credential,
    })
}

// ---------------------------------------------------------------------------
// The standing review queue
// ---------------------------------------------------------------------------

/// One entry, with the state migration 0006 split apart made explicit.
///
/// `observedValueMinor` crosses as TEXT for the reason the whole boundary does: a JSON number is an
/// IEEE-754 double and this figure is the one number in the product that exists to be believed
/// literally.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEntryRow {
    pub id: String,
    pub account_id: String,
    pub account_label: String,
    pub provider_short_code: String,
    pub raw_identifier: String,
    pub raw_name: Option<String>,
    pub asset_class_hint: Option<String>,
    pub observed_quantity: Option<String>,
    pub observed_value_minor: Option<String>,
    pub currency: Option<String>,
    pub first_seen_at: String,
    pub last_seen_at: Option<String>,
    pub ignored_at: Option<String>,
    pub mapped_at: Option<String>,
    pub mapped_instrument_id: Option<String>,
    pub mapped_instrument_name: Option<String>,
    /// `open`, `dismissed` or `mapped`. Derived here rather than in the screen so both cannot
    /// disagree about what a row with both columns set means.
    pub state: String,
}

/// Every entry still withholding value from net worth, whatever the user has done about it.
///
/// `resolved_at IS NULL` is the only filter, and it is the same predicate the withheld total in
/// `valuation/portfolio.ts` uses — so this list is exactly the set of entries the dashboard is
/// reporting as missing money, and nothing else. A dismissed entry is here because dismissing
/// stopped the asking, not the withholding.
pub fn review_queue(conn: &Connection) -> Result<Vec<ReviewEntryRow>> {
    let mut stmt = conn.prepare(
        "SELECT u.id, u.account_id, a.label, p.short_code, u.raw_identifier, u.raw_name,
                u.asset_class_hint, u.observed_quantity,
                CAST(u.observed_value_minor AS TEXT), u.currency, u.first_seen_at, u.last_seen_at,
                u.ignored_at, u.mapped_at, u.resolved_instrument_id, i.display_name
           FROM unresolved_instrument u
           JOIN account a ON a.id = u.account_id
           JOIN provider p ON p.id = a.provider_id
           LEFT JOIN instrument i ON i.id = u.resolved_instrument_id
          WHERE u.resolved_at IS NULL
          ORDER BY u.first_seen_at, u.id",
    )?;
    let rows = stmt.query_map([], |row| {
        let ignored_at: Option<String> = row.get(12)?;
        let mapped_at: Option<String> = row.get(13)?;
        // Mapping clears `ignored_at` (see `ingest.rs::map_unresolved`), so the two are exclusive
        // in anything written since migration 0006. Mapped wins if an older row carries both:
        // "named, waiting to land" is the more informative of the two.
        let state = if mapped_at.is_some() {
            "mapped"
        } else if ignored_at.is_some() {
            "dismissed"
        } else {
            "open"
        };
        Ok(ReviewEntryRow {
            id: row.get(0)?,
            account_id: row.get(1)?,
            account_label: row.get(2)?,
            provider_short_code: row.get(3)?,
            raw_identifier: row.get(4)?,
            raw_name: row.get(5)?,
            asset_class_hint: row.get(6)?,
            observed_quantity: row.get(7)?,
            observed_value_minor: row.get(8)?,
            currency: row.get(9)?,
            first_seen_at: row.get(10)?,
            last_seen_at: row.get(11)?,
            ignored_at,
            mapped_at,
            mapped_instrument_id: row.get(14)?,
            mapped_instrument_name: row.get(15)?,
            state: state.to_string(),
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Undo a dismissal.
///
/// Clears `ignored_at` alone. `resolved_at` is untouched because it never meant "dealt with" — it
/// means the rows landed — and `first_seen_at` is untouched because the queue orders by it and a
/// re-opened entry is not a new sighting.
pub fn restore_entry(conn: &Connection, entry_id: &str) -> Result<()> {
    let changed = conn.execute(
        "UPDATE unresolved_instrument SET ignored_at = NULL
          WHERE id = ?1 AND resolved_at IS NULL AND ignored_at IS NOT NULL",
        [entry_id],
    )?;
    if changed == 0 {
        return Err(MisalError::Other(format!(
            "no dismissed queue entry {entry_id}"
        )));
    }
    Ok(())
}

/// Dismiss an entry from the settings queue.
///
/// The same write `ingest.rs::ignore_unresolved` performs, reachable from the standing queue as
/// well as from the import report — otherwise an entry re-opened here could only be dismissed
/// again by re-importing the statement that raised it.
pub fn dismiss_entry(conn: &Connection, entry_id: &str) -> Result<()> {
    let changed = conn.execute(
        "UPDATE unresolved_instrument SET ignored_at = ?1
          WHERE id = ?2 AND resolved_at IS NULL AND ignored_at IS NULL AND mapped_at IS NULL",
        rusqlite::params![now_iso(), entry_id],
    )?;
    if changed == 0 {
        return Err(MisalError::Other(format!("no open queue entry {entry_id}")));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn account_deletion_preview(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<DeletionPreview> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    deletion_preview(&conn, &account_id)
}

#[tauri::command]
pub fn account_delete(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<DeletionOutcome> {
    let mut conn = state.conn.lock().expect("storage mutex poisoned");
    delete_account(&mut conn, &account_id, &mut OsKeychain)
}

#[tauri::command]
pub fn review_queue_list(state: tauri::State<'_, AppState>) -> Result<Vec<ReviewEntryRow>> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    review_queue(&conn)
}

#[tauri::command]
pub fn review_queue_restore(state: tauri::State<'_, AppState>, entry_id: String) -> Result<()> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    restore_entry(&conn, &entry_id)
}

#[tauri::command]
pub fn review_queue_dismiss(state: tauri::State<'_, AppState>, entry_id: String) -> Result<()> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    dismiss_entry(&conn, &entry_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use tempfile::TempDir;

    const TEST_KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    /// A keychain that records rather than talks to the operating system, and can be told to fail.
    struct RecordingKeychain {
        forgotten: Vec<String>,
        fail: bool,
    }

    impl RecordingKeychain {
        fn working() -> Self {
            Self {
                forgotten: Vec::new(),
                fail: false,
            }
        }
        fn failing() -> Self {
            Self {
                forgotten: Vec::new(),
                fail: true,
            }
        }
    }

    impl SecretStore for RecordingKeychain {
        fn forget(&mut self, keychain_key: &str) -> Result<()> {
            if self.fail {
                return Err(MisalError::Other("keychain is locked".to_string()));
            }
            self.forgotten.push(keychain_key.to_string());
            Ok(())
        }
    }

    fn seeded() -> (TempDir, Connection) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("t.db");
        let conn = db::open_at(&path, TEST_KEY).unwrap();
        db::migrate(&conn, &path).unwrap();

        // Two exchange accounts, each with a credential, plus one document each. Then a third
        // document carrying rows for both — the multi-folio statement case.
        conn.execute_batch(
            "INSERT INTO account (id, provider_id, label, capability, base_currency, created_at)
               VALUES ('a1', 'coindcx', 'CoinDCX main', 'snapshot', 'INR', 'now'),
                      ('a2', 'binance', 'Binance', 'snapshot', 'INR', 'now');
             INSERT INTO instrument (id, asset_class, display_name, currency, created_at)
               VALUES ('i1', 'crypto', 'Bitcoin', 'INR', 'now'),
                      ('i2', 'crypto', 'Ether', 'INR', 'now');
             INSERT INTO source_document (id, account_id, provider_id, kind, content_hash,
                 imported_at)
               VALUES ('d1', 'a1', 'coindcx', 'api-response', 'h1', 'now'),
                      ('d2', 'a2', 'binance', 'api-response', 'h2', 'now');
             INSERT INTO source_document (id, account_id, provider_id, kind, content_hash,
                 imported_at)
               VALUES ('dshared', NULL, 'coindcx', 'csv', 'h3', 'now');
             INSERT INTO txn (id, account_id, instrument_id, type, occurred_at, quantity,
                 currency, source_document_id, natural_key, created_at)
               VALUES ('t1','a1','i1','buy','2026-01-01T00:00:00Z','0.5','INR','d1','k1','now'),
                      ('t2','a1','i1','buy','2026-01-02T00:00:00Z','0.5','INR','dshared','k2','now'),
                      ('t3','a2','i2','buy','2026-01-03T00:00:00Z','2','INR','dshared','k3','now'),
                      ('t4','a2','i2','buy','2026-01-04T00:00:00Z','1','INR','d2','k4','now');
             INSERT INTO position (id, account_id, instrument_id, quantity, as_of,
                 source_document_id)
               VALUES ('p1','a1','i1','1.0','2026-01-05','d1'),
                      ('p2','a2','i2','3.0','2026-01-05','d2');
             INSERT INTO credential_ref (account_id, keychain_key, kind, created_at)
               VALUES ('a1', 'secret/a1', 'api-key-secret', 'now'),
                      ('a2', 'secret/a2', 'api-key-secret', 'now');
             INSERT INTO sync_state (account_id, stream, scope, cursor)
               VALUES ('a1', 'trades', 'BTCINR', '99');
             INSERT INTO unresolved_instrument (id, source_document_id, account_id, raw_identifier,
                 observed_value_minor, currency, first_seen_at)
               VALUES ('u1', 'd1', 'a1', 'provider-local:XYZ', 118640000, 'INR', '2026-01-06'),
                      ('u2', 'd2', 'a2', 'provider-local:ABC', 500000, 'INR', '2026-01-07');",
        )
        .unwrap();
        (dir, conn)
    }

    fn count_of(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(&format!("SELECT count(*) {sql}"), [], |r| r.get(0))
            .unwrap()
    }

    /// The security half and the blast-radius half of the same delete.
    ///
    /// A row removed without its keychain entry leaves a live, full-access API key on the machine
    /// for an account the user can no longer see — a credential they believe they destroyed. And a
    /// delete that reached beyond the account would be the very failure this command exists to
    /// stop being catastrophic.
    #[test]
    fn deleting_an_account_forgets_its_key_and_leaves_the_other_account_whole() {
        let (_dir, mut conn) = seeded();
        let mut keychain = RecordingKeychain::working();

        let outcome = delete_account(&mut conn, "a1", &mut keychain).unwrap();

        assert!(
            keychain.forgotten.contains(&"secret/a1".to_string()),
            "the keychain entry survived the account: {:?}",
            keychain.forgotten
        );
        assert!(
            !keychain.forgotten.iter().any(|k| k.contains("a2")),
            "another account's credential was forgotten"
        );
        assert!(outcome.credential_forgotten);
        assert_eq!(outcome.label, "CoinDCX main");
        assert_eq!(outcome.transactions, 2);
        assert_eq!(outcome.positions, 1);
        assert_eq!(outcome.queue_entries, 1);

        assert_eq!(count_of(&conn, "FROM account WHERE id = 'a1'"), 0);
        assert_eq!(count_of(&conn, "FROM txn WHERE account_id = 'a1'"), 0);
        assert_eq!(count_of(&conn, "FROM position WHERE account_id = 'a1'"), 0);
        assert_eq!(
            count_of(&conn, "FROM credential_ref WHERE account_id = 'a1'"),
            0
        );
        assert_eq!(
            count_of(&conn, "FROM sync_state WHERE account_id = 'a1'"),
            0
        );
        assert_eq!(
            count_of(&conn, "FROM unresolved_instrument WHERE account_id = 'a1'"),
            0
        );

        // The other account is untouched, down to the row.
        assert_eq!(count_of(&conn, "FROM account WHERE id = 'a2'"), 1);
        assert_eq!(count_of(&conn, "FROM txn WHERE account_id = 'a2'"), 2);
        assert_eq!(count_of(&conn, "FROM position WHERE account_id = 'a2'"), 1);
        assert_eq!(
            count_of(&conn, "FROM credential_ref WHERE account_id = 'a2'"),
            1
        );
        assert_eq!(
            count_of(&conn, "FROM unresolved_instrument WHERE account_id = 'a2'"),
            1
        );

        // The instruments are shared and stay: they are not the account's property, and removing
        // them would take another account's holdings with them.
        assert_eq!(count_of(&conn, "FROM instrument"), 2);
    }

    /// The document another folio was also imported from is not this account's to destroy.
    ///
    /// Every fact table cascades from `source_document`, so deleting a shared statement would take
    /// the *other* account's transactions with it — a delete of one account silently corrupting
    /// another.
    #[test]
    fn a_document_another_account_still_cites_survives_and_keeps_its_rows() {
        let (_dir, mut conn) = seeded();
        let outcome = delete_account(&mut conn, "a1", &mut RecordingKeychain::working()).unwrap();

        assert_eq!(outcome.documents_removed, 1, "d1 should have gone");
        assert_eq!(outcome.documents_kept_shared, 0, "dshared was never a1's");

        assert_eq!(count_of(&conn, "FROM source_document WHERE id = 'd1'"), 0);
        assert_eq!(
            count_of(&conn, "FROM source_document WHERE id = 'dshared'"),
            1,
            "a shared statement was destroyed with one of its accounts"
        );
        assert_eq!(
            count_of(&conn, "FROM txn WHERE id = 't3'"),
            1,
            "another account's transaction went with the shared document"
        );
        assert_eq!(count_of(&conn, "FROM source_document WHERE id = 'd2'"), 1);
    }

    /// A shared document filed under the account being deleted is detached, not deleted.
    #[test]
    fn a_shared_document_owned_by_the_account_is_detached_rather_than_removed() {
        let (_dir, mut conn) = seeded();
        conn.execute(
            "UPDATE source_document SET account_id = 'a1' WHERE id = 'dshared'",
            [],
        )
        .unwrap();

        let outcome = delete_account(&mut conn, "a1", &mut RecordingKeychain::working()).unwrap();
        assert_eq!(outcome.documents_kept_shared, 1);

        let owner: Option<String> = conn
            .query_row(
                "SELECT account_id FROM source_document WHERE id = 'dshared'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(owner, None, "the shared document kept a dangling owner");
        assert_eq!(
            count_of(&conn, "FROM txn WHERE id = 't3'"),
            1,
            "the cascade from source_document took another account's transaction"
        );
    }

    /// A failure anywhere leaves the account exactly as it was.
    ///
    /// Two failure points, because they are different failures. The keychain refusing must stop the
    /// command before a single row moves — an account that is gone but whose key is not is the one
    /// state that cannot be recovered from. A database failure part-way through must roll back the
    /// deletes already issued, or the user is left with an account holding positions and no
    /// transactions, and nothing on screen to say so.
    #[test]
    fn a_failed_delete_changes_nothing_at_all() {
        let (_dir, mut conn) = seeded();

        let refused = delete_account(&mut conn, "a1", &mut RecordingKeychain::failing());
        assert!(
            refused.is_err(),
            "a locked keychain did not stop the delete"
        );
        assert_eq!(
            count_of(&conn, "FROM account WHERE id = 'a1'"),
            1,
            "the account was removed after the keychain refused"
        );
        assert_eq!(count_of(&conn, "FROM txn WHERE account_id = 'a1'"), 2);
        assert_eq!(
            count_of(&conn, "FROM credential_ref WHERE account_id = 'a1'"),
            1
        );

        // Now fail at the last statement instead, with every earlier delete already issued inside
        // the transaction. A trigger stands in for the disk filling up.
        conn.execute_batch(
            "CREATE TRIGGER refuse_account_delete BEFORE DELETE ON account
             BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;",
        )
        .unwrap();

        let failed = delete_account(&mut conn, "a1", &mut RecordingKeychain::working());
        assert!(
            failed.is_err(),
            "the delete reported success after aborting"
        );

        conn.execute_batch("DROP TRIGGER refuse_account_delete")
            .unwrap();

        assert_eq!(count_of(&conn, "FROM account WHERE id = 'a1'"), 1);
        assert_eq!(
            count_of(&conn, "FROM txn WHERE account_id = 'a1'"),
            2,
            "transactions deleted before the failure were not rolled back"
        );
        assert_eq!(count_of(&conn, "FROM position WHERE account_id = 'a1'"), 1);
        assert_eq!(
            count_of(&conn, "FROM credential_ref WHERE account_id = 'a1'"),
            1
        );
        assert_eq!(
            count_of(&conn, "FROM sync_state WHERE account_id = 'a1'"),
            1
        );
        assert_eq!(
            count_of(&conn, "FROM unresolved_instrument WHERE account_id = 'a1'"),
            1
        );
        assert_eq!(
            count_of(&conn, "FROM source_document WHERE id = 'd1'"),
            1,
            "a source document deleted before the failure was not rolled back"
        );
    }

    #[test]
    fn the_preview_counts_what_the_delete_removes() {
        let (_dir, mut conn) = seeded();
        let preview = deletion_preview(&conn, "a1").unwrap();
        assert_eq!(preview.label, "CoinDCX main");
        assert_eq!(preview.transactions, 2);
        assert_eq!(preview.holdings, 1);
        assert_eq!(preview.queue_entries, 1);
        assert_eq!(preview.documents_removed, 1);
        assert!(preview.has_credential);
        assert_eq!(preview.sync_cursors, 1);

        let outcome = delete_account(&mut conn, "a1", &mut RecordingKeychain::working()).unwrap();
        assert_eq!(outcome.transactions, preview.transactions);
        assert_eq!(outcome.queue_entries, preview.queue_entries);
        assert_eq!(outcome.documents_removed, preview.documents_removed);
    }

    #[test]
    fn deleting_an_account_that_is_not_there_says_so() {
        let (_dir, mut conn) = seeded();
        let error = delete_account(&mut conn, "nope", &mut RecordingKeychain::working())
            .expect_err("a missing account was reported as deleted");
        assert!(error.to_string().contains("nope"));
    }

    /// The whole reason migration 0006 split the columns.
    ///
    /// A dismissed entry has to stay visible and stay counted, because the money it withholds is
    /// still absent from every total. Before the split, dismissing set `resolved_at` and the
    /// withheld figure fell to zero.
    #[test]
    fn the_queue_shows_open_dismissed_and_mapped_entries_separately() {
        let (_dir, conn) = seeded();
        conn.execute(
            "UPDATE unresolved_instrument SET ignored_at = '2026-01-08' WHERE id = 'u1'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE unresolved_instrument
                SET mapped_at = '2026-01-09', resolved_instrument_id = 'i2' WHERE id = 'u2'",
            [],
        )
        .unwrap();

        let queue = review_queue(&conn).unwrap();
        assert_eq!(queue.len(), 2);

        let dismissed = queue.iter().find(|e| e.id == "u1").unwrap();
        assert_eq!(dismissed.state, "dismissed");
        assert_eq!(dismissed.account_label, "CoinDCX main");
        assert_eq!(dismissed.provider_short_code, "DCX");
        assert_eq!(
            dismissed.observed_value_minor.as_deref(),
            Some("118640000"),
            "the withheld figure must cross as text, digit for digit"
        );

        let mapped = queue.iter().find(|e| e.id == "u2").unwrap();
        assert_eq!(mapped.state, "mapped");
        assert_eq!(mapped.mapped_instrument_name.as_deref(), Some("Ether"));

        // A landed entry leaves the queue, because its value is in the totals now.
        conn.execute(
            "UPDATE unresolved_instrument SET resolved_at = '2026-01-10' WHERE id = 'u2'",
            [],
        )
        .unwrap();
        assert_eq!(review_queue(&conn).unwrap().len(), 1);
    }

    #[test]
    fn a_dismissed_entry_can_be_re_opened_and_dismissed_again() {
        let (_dir, conn) = seeded();
        conn.execute(
            "UPDATE unresolved_instrument SET ignored_at = '2026-01-08' WHERE id = 'u1'",
            [],
        )
        .unwrap();

        restore_entry(&conn, "u1").unwrap();
        let entry = review_queue(&conn)
            .unwrap()
            .into_iter()
            .find(|e| e.id == "u1")
            .unwrap();
        assert_eq!(entry.state, "open");
        assert_eq!(entry.ignored_at, None);
        assert_eq!(
            entry.first_seen_at, "2026-01-06",
            "re-opening rewrote the sighting date the queue orders by"
        );

        // Not idempotent by accident: restoring an open entry is a no-op the caller should hear
        // about rather than a silent success that hides a stale screen.
        assert!(restore_entry(&conn, "u1").is_err());

        dismiss_entry(&conn, "u1").unwrap();
        let again = review_queue(&conn)
            .unwrap()
            .into_iter()
            .find(|e| e.id == "u1")
            .unwrap();
        assert_eq!(again.state, "dismissed");
    }

    #[test]
    fn a_landed_entry_cannot_be_re_opened() {
        let (_dir, conn) = seeded();
        conn.execute(
            "UPDATE unresolved_instrument
                SET ignored_at = '2026-01-08', resolved_at = '2026-01-09' WHERE id = 'u1'",
            [],
        )
        .unwrap();
        assert!(
            restore_entry(&conn, "u1").is_err(),
            "an entry whose rows have landed was put back in the queue"
        );
    }
}
