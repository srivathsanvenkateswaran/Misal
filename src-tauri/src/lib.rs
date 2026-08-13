pub mod db;
pub mod error;
pub mod exchange_guard;
pub mod queries;
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
            queries::list_unresolved,
            queries::get_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running Misal");
}
