pub mod db;
pub mod error;
pub mod exchange_guard;
pub mod export;
pub mod http;
pub mod ingest;
pub mod queries;
pub mod refresh;
pub mod secrets;
pub mod settings;
pub mod sync;

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
            // Staged exchange credentials live here and nowhere else until the scope check has
            // decided whether they may be written to the keychain at all.
            app.manage(sync::ExchangeState::new());
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
            export::save_export_file,
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
            ingest::read_statement_bytes,
            settings::settings_snapshot,
            settings::settings_write,
            settings::settings_set_provider_key,
            settings::settings_clear_provider_key,
            settings::settings_set_manual_price,
            settings::settings_delete_manual_price,
            sync::exchange_stage_credential,
            sync::exchange_discard_credential,
            sync::exchange_commit_credential,
            sync::exchange_has_credential,
            sync::exchange_record_scope,
            sync::exchange_send,
            sync::sync_read_cursor,
            sync::sync_write_cursor,
            sync::sync_upsert_document,
            sync::sync_start_run,
            sync::sync_finish_run,
            sync::sync_record_issue,
            sync::sync_commit_positions,
            sync::sync_commit_transactions,
            sync::sync_transaction_quantities,
            sync::sync_read_discovered_assets,
            sync::sync_add_discovered_assets,
            sync::sync_read_markets,
            sync::sync_write_markets,
            sync::sync_set_account_status,
            sync::sync_touch_credential,
            sync::sync_find_instrument_by_alias,
            sync::sync_create_instrument,
            sync::sync_add_alias,
            sync::sync_record_unresolved
        ])
        .run(tauri::generate_context!())
        .expect("error while running Misal");
}
