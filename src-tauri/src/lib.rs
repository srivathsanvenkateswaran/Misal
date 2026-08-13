pub mod db;
pub mod error;
pub mod exchange_guard;
pub mod http;
pub mod ingest;
pub mod queries;
pub mod refresh;
pub mod secrets;

use error::Result;
use serde::Serialize;
use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub conn: Mutex<rusqlite::Connection>,
}

#[derive(Serialize)]
pub struct StorageStatus {
    pub database_path: String,
    pub schema_version: i64,
    pub encrypted: bool,
    pub account_count: i64,
}

#[tauri::command]
fn storage_status(state: tauri::State<'_, AppState>) -> Result<StorageStatus> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    let schema_version: i64 = conn.query_row(
        "SELECT coalesce(max(version), 0) FROM schema_migration",
        [],
        |r| r.get(0),
    )?;
    let account_count: i64 = conn.query_row("SELECT count(*) FROM account", [], |r| r.get(0))?;

    Ok(StorageStatus {
        database_path: db::database_path()?.display().to_string(),
        schema_version,
        encrypted: true,
        account_count,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Opening the database is the first thing that must succeed. Failing here with a
            // clear error beats starting a window that cannot show anything.
            let conn = db::open()?;
            app.manage(AppState {
                conn: Mutex::new(conn),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            storage_status,
            queries::list_accounts,
            queries::list_instruments,
            queries::list_aliases,
            queries::list_transactions,
            queries::list_positions,
            queries::list_prices,
            queries::list_fx_rates,
            queries::list_unresolved,
            queries::get_settings,
            http::fetch_market_data,
            refresh::save_prices,
            refresh::save_fx_rates,
            refresh::record_price_refresh,
            ingest::ingest_find_document_by_hash,
            ingest::ingest_find_account_by_identity_key,
            ingest::ingest_find_instrument_by_isin,
            ingest::ingest_find_alias_target,
            ingest::ingest_count_txn_by_natural_key,
            ingest::ingest_has_txn,
            ingest::ingest_find_position,
            ingest::ingest_commit,
            ingest::ingest_unresolved_for_document,
            ingest::ingest_map_unresolved,
            ingest::ingest_ignore_unresolved,
            ingest::pick_statement_file,
            ingest::read_statement_bytes
        ])
        .run(tauri::generate_context!())
        .expect("error while running Misal");
}
