//! Disconnecting an exchange account.
//!
//! Removing the row without removing the keychain entry would leave a live, full-access API key on
//! the user's machine that nothing in Misal will ever use again and nothing in Misal will ever
//! show them — a credential they believe they revoked. For CoinDCX, where every key can trade and
//! withdraw, that is the difference between disconnecting and appearing to.
//!
//! Holdings are deliberately left alone. Disconnecting is about the credential, not the history:
//! transactions already imported are the user's own record and are not the exchange's to take back.

use crate::error::Result;
use crate::secrets;
use crate::AppState;

/// Remove an exchange credential: the database reference and the keychain entry both.
///
/// The keychain deletion happens first. If it fails the command fails and the row stays, so the
/// user sees the account still connected — which is true. Deleting the row first and failing after
/// would present a disconnected account whose key is still stored, which is the one outcome that
/// must not be reachable.
#[tauri::command]
pub fn exchange_disconnect_account(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<()> {
    secrets::delete_secret(&secrets::account_secret_key(&account_id))?;

    let conn = state.conn.lock().expect("storage mutex poisoned");
    conn.execute(
        "DELETE FROM credential_ref WHERE account_id = ?1",
        [&account_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::db;
    use tempfile::TempDir;

    const TEST_KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    /// Holdings survive a disconnect.
    ///
    /// Transactions already imported are the user's own record. Removing them with the credential
    /// would silently delete history their statements still assert, and there is no undo.
    #[test]
    fn removing_a_credential_leaves_the_holdings_alone() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("t.db");
        let conn = db::open_at(&path, TEST_KEY).unwrap();
        db::migrate(&conn, &path).unwrap();

        conn.execute_batch(
            "INSERT INTO account (id, provider_id, label, capability, base_currency, created_at)
               VALUES ('a1', 'coindcx', 'CoinDCX', 'snapshot', 'INR', 'now');
             INSERT INTO instrument (id, asset_class, display_name, currency, created_at)
               VALUES ('i1', 'crypto', 'Bitcoin', 'INR', 'now');
             INSERT INTO source_document (id, provider_id, kind, content_hash, imported_at)
               VALUES ('d1', 'coindcx', 'api-response', 'h1', 'now');
             INSERT INTO txn (id, account_id, instrument_id, type, occurred_at, quantity,
               currency, source_document_id, natural_key, created_at)
               VALUES ('t1','a1','i1','buy','2026-01-01T00:00:00Z','0.5','INR','d1','k1','now');
             INSERT INTO credential_ref (account_id, keychain_key, kind, created_at)
               VALUES ('a1', 'secret/a1', 'api-key-secret', 'now');",
        )
        .unwrap();

        conn.execute("DELETE FROM credential_ref WHERE account_id = 'a1'", [])
            .unwrap();

        let txns: i64 = conn
            .query_row("SELECT count(*) FROM txn", [], |r| r.get(0))
            .unwrap();
        let accounts: i64 = conn
            .query_row("SELECT count(*) FROM account", [], |r| r.get(0))
            .unwrap();
        let creds: i64 = conn
            .query_row("SELECT count(*) FROM credential_ref", [], |r| r.get(0))
            .unwrap();

        assert_eq!(txns, 1, "disconnecting destroyed imported history");
        assert_eq!(accounts, 1, "disconnecting removed the account itself");
        assert_eq!(creds, 0, "the credential reference survived");
    }
}
