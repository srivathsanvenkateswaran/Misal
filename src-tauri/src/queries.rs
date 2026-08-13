//! Read-only queries exposed to the frontend.
//!
//! The Rust core owns storage; it does not compute portfolio metrics. Valuation lives in
//! TypeScript (see `src/valuation/`), so these commands hand over rows and nothing more.
//!
//! **Every numeric column crosses the boundary as a string.** SQLite stores `amount_minor` and the
//! fee columns as INTEGER, but a JSON number is an IEEE-754 double: a paise value beyond 2^53
//! would be silently rounded on the way out, and quantities carrying eighteen decimals would lose
//! their tail. The `CAST(... AS TEXT)` in each statement below is load-bearing, not cosmetic.

use crate::error::Result;
use crate::AppState;
use rusqlite::Row;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRow {
    pub id: String,
    pub provider_id: String,
    pub label: String,
    pub external_ref: Option<String>,
    pub identity_key: Option<String>,
    pub capability: String,
    pub base_currency: String,
    pub created_at: String,
    /// Denormalised for the UI source stamp, which would otherwise need a second query per row.
    pub provider_short_code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentRow {
    pub id: String,
    pub asset_class: String,
    pub tax_regime: Option<String>,
    pub display_name: String,
    pub isin: Option<String>,
    pub currency: String,
    pub precision: i64,
    pub fmv31_jan2018: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxnRow {
    pub id: String,
    pub account_id: String,
    pub instrument_id: String,
    #[serde(rename = "type")]
    pub txn_type: String,
    pub occurred_at: String,
    pub occurred_tz: Option<String>,
    pub quantity: String,
    pub price: Option<String>,
    pub amount_minor: Option<String>,
    pub brokerage_minor: String,
    pub stt_minor: String,
    pub gst_minor: String,
    pub stamp_duty_minor: String,
    pub other_fees_minor: String,
    pub tds_minor: String,
    pub currency: String,
    pub fx_rate: Option<String>,
    pub source_document_id: String,
    pub natural_key: String,
    pub occurrence: i64,
    pub authority: String,
    pub created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasRow {
    pub instrument_id: String,
    pub scheme: String,
    pub value: String,
    pub provider_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionRow {
    pub id: String,
    pub account_id: String,
    pub instrument_id: String,
    pub quantity: String,
    pub as_of: String,
    pub source_document_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceRow {
    pub instrument_id: String,
    pub as_of: String,
    pub close: String,
    pub currency: String,
    pub source: String,
    pub fetched_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FxRateRow {
    pub base: String,
    pub quote: String,
    pub as_of: String,
    pub rate: String,
    pub source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedRow {
    pub id: String,
    pub account_id: String,
    pub raw_identifier: String,
    pub raw_name: Option<String>,
    pub asset_class_hint: Option<String>,
    pub observed_quantity: Option<String>,
    pub observed_value_minor: Option<String>,
    pub currency: Option<String>,
    pub first_seen_at: String,
}

fn account_of(row: &Row<'_>) -> rusqlite::Result<AccountRow> {
    Ok(AccountRow {
        id: row.get(0)?,
        provider_id: row.get(1)?,
        label: row.get(2)?,
        external_ref: row.get(3)?,
        identity_key: row.get(4)?,
        capability: row.get(5)?,
        base_currency: row.get(6)?,
        created_at: row.get(7)?,
        provider_short_code: row.get(8)?,
    })
}

#[tauri::command]
pub fn list_accounts(state: tauri::State<'_, AppState>) -> Result<Vec<AccountRow>> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    let mut stmt = conn.prepare(
        "SELECT a.id, a.provider_id, a.label, a.external_ref, a.identity_key, a.capability,
                a.base_currency, a.created_at, p.short_code
           FROM account a
           JOIN provider p ON p.id = a.provider_id
          WHERE a.archived_at IS NULL
          ORDER BY a.created_at",
    )?;
    let rows = stmt.query_map([], account_of)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[tauri::command]
pub fn list_instruments(state: tauri::State<'_, AppState>) -> Result<Vec<InstrumentRow>> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    let mut stmt = conn.prepare(
        "SELECT id, asset_class, tax_regime, display_name, isin, currency, precision,
                fmv_31jan2018
           FROM instrument
          ORDER BY display_name",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(InstrumentRow {
            id: row.get(0)?,
            asset_class: row.get(1)?,
            tax_regime: row.get(2)?,
            display_name: row.get(3)?,
            isin: row.get(4)?,
            currency: row.get(5)?,
            precision: row.get(6)?,
            fmv31_jan2018: row.get(7)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Instrument aliases.
///
/// Needed by the price layer, not merely by resolution: an AMFI scheme code is how the keyless
/// NAV provider recognises a fund, so an instrument that reaches valuation without its aliases is
/// simply unpriceable.
#[tauri::command]
pub fn list_aliases(state: tauri::State<'_, AppState>) -> Result<Vec<AliasRow>> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    let mut stmt = conn.prepare(
        "SELECT instrument_id, scheme, value, provider_id FROM instrument_alias
          ORDER BY instrument_id, scheme",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(AliasRow {
            instrument_id: row.get(0)?,
            scheme: row.get(1)?,
            value: row.get(2)?,
            provider_id: row.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[tauri::command]
pub fn list_transactions(state: tauri::State<'_, AppState>) -> Result<Vec<TxnRow>> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    // Every INTEGER money column is cast to TEXT here. See the module comment.
    let mut stmt = conn.prepare(
        "SELECT id, account_id, instrument_id, type, occurred_at, occurred_tz, quantity, price,
                CAST(amount_minor AS TEXT), CAST(brokerage_minor AS TEXT), CAST(stt_minor AS TEXT),
                CAST(gst_minor AS TEXT), CAST(stamp_duty_minor AS TEXT),
                CAST(other_fees_minor AS TEXT), CAST(tds_minor AS TEXT),
                currency, fx_rate, source_document_id, natural_key, occurrence, authority,
                created_at
           FROM txn
          ORDER BY occurred_at, created_at",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(TxnRow {
            id: row.get(0)?,
            account_id: row.get(1)?,
            instrument_id: row.get(2)?,
            txn_type: row.get(3)?,
            occurred_at: row.get(4)?,
            occurred_tz: row.get(5)?,
            quantity: row.get(6)?,
            price: row.get(7)?,
            amount_minor: row.get(8)?,
            brokerage_minor: row.get(9)?,
            stt_minor: row.get(10)?,
            gst_minor: row.get(11)?,
            stamp_duty_minor: row.get(12)?,
            other_fees_minor: row.get(13)?,
            tds_minor: row.get(14)?,
            currency: row.get(15)?,
            fx_rate: row.get(16)?,
            source_document_id: row.get(17)?,
            natural_key: row.get(18)?,
            occurrence: row.get(19)?,
            authority: row.get(20)?,
            created_at: row.get(21)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[tauri::command]
pub fn list_positions(state: tauri::State<'_, AppState>) -> Result<Vec<PositionRow>> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    let mut stmt = conn.prepare(
        "SELECT id, account_id, instrument_id, quantity, as_of, source_document_id
           FROM position
          ORDER BY as_of DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(PositionRow {
            id: row.get(0)?,
            account_id: row.get(1)?,
            instrument_id: row.get(2)?,
            quantity: row.get(3)?,
            as_of: row.get(4)?,
            source_document_id: row.get(5)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[tauri::command]
pub fn list_prices(state: tauri::State<'_, AppState>) -> Result<Vec<PriceRow>> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    let mut stmt = conn.prepare(
        "SELECT instrument_id, as_of, close, currency, source, fetched_at
           FROM price
          ORDER BY instrument_id, as_of DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(PriceRow {
            instrument_id: row.get(0)?,
            as_of: row.get(1)?,
            close: row.get(2)?,
            currency: row.get(3)?,
            source: row.get(4)?,
            fetched_at: row.get(5)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Instruments an import could not identify.
///
/// Their value is held out of every total, and the UI states the exact amount withheld - which is
/// why `observed_value_minor` is carried rather than recomputed.
#[tauri::command]
pub fn list_unresolved(state: tauri::State<'_, AppState>) -> Result<Vec<UnresolvedRow>> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    let mut stmt = conn.prepare(
        "SELECT id, account_id, raw_identifier, raw_name, asset_class_hint, observed_quantity,
                CAST(observed_value_minor AS TEXT), currency, first_seen_at
           FROM unresolved_instrument
          WHERE resolved_at IS NULL
          ORDER BY first_seen_at",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(UnresolvedRow {
            id: row.get(0)?,
            account_id: row.get(1)?,
            raw_identifier: row.get(2)?,
            raw_name: row.get(3)?,
            asset_class_hint: row.get(4)?,
            observed_quantity: row.get(5)?,
            observed_value_minor: row.get(6)?,
            currency: row.get(7)?,
            first_seen_at: row.get(8)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Stored exchange rates.
///
/// Without these no foreign holding can enter net worth at all - the engine refuses to convert
/// rather than assume a rate, so a missing table silently makes every US holding invisible in
/// every total rather than merely unpriced.
#[tauri::command]
pub fn list_fx_rates(state: tauri::State<'_, AppState>) -> Result<Vec<FxRateRow>> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    let mut stmt = conn.prepare(
        "SELECT base, quote, as_of, rate, source FROM fx_rate ORDER BY base, quote, as_of",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(FxRateRow {
            base: row.get(0)?,
            quote: row.get(1)?,
            as_of: row.get(2)?,
            rate: row.get(3)?,
            source: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, AppState>) -> Result<Vec<(String, String)>> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    let mut stmt = conn.prepare("SELECT key, value FROM setting ORDER BY key")?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[cfg(test)]
mod tests {
    use crate::db;
    use tempfile::TempDir;

    const TEST_KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    /// The whole point of the CAST in these queries.
    ///
    /// A paise value beyond 2^53 must survive the round trip as text. Read back as a JSON number
    /// it would be silently rounded, and a portfolio would quietly report the wrong total.
    #[test]
    fn large_money_values_survive_as_text() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("t.db");
        let conn = db::open_at(&path, TEST_KEY).unwrap();
        db::migrate(&conn, &path).unwrap();

        conn.execute_batch(
            "INSERT INTO account (id, provider_id, label, capability, base_currency, created_at)
               VALUES ('a1', 'cams-cas', 'T', 'ledger', 'INR', 'now');
             INSERT INTO instrument (id, asset_class, display_name, currency, created_at)
               VALUES ('i1', 'mutual_fund', 'F', 'INR', 'now');
             INSERT INTO source_document (id, provider_id, kind, content_hash, imported_at)
               VALUES ('d1', 'cams-cas', 'cas-pdf', 'h1', 'now');",
        )
        .unwrap();

        let huge: i64 = 9_007_199_254_740_993; // 2^53 + 1
        conn.execute(
            "INSERT INTO txn (id, account_id, instrument_id, type, occurred_at, quantity,
               amount_minor, currency, source_document_id, natural_key, created_at)
             VALUES ('t1','a1','i1','buy','2026-01-01T00:00:00Z','1',?1,'INR','d1','k1','now')",
            [huge],
        )
        .unwrap();

        let as_text: String = conn
            .query_row("SELECT CAST(amount_minor AS TEXT) FROM txn", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(as_text, "9007199254740993");

        // Demonstrates the failure being prevented: through an f64 the last digit is lost.
        let as_float: f64 = as_text.parse().unwrap();
        assert_ne!(format!("{as_float:.0}"), as_text);
    }
}
