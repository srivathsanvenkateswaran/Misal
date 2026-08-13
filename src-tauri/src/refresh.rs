//! The price and exchange-rate write path.
//!
//! `queries.rs` reads rows out; this module puts fetched prices and rates in. It decides nothing:
//! which instruments were stale, which provider covered each, and what came back is settled in
//! `src/data/refresh.ts` before anything reaches here. What this module owns is the one rule that
//! must not be expressible anywhere else — **a fetched value never displaces a manual one**.
//!
//! That rule needs two mechanisms, not one, because the schema only half enforces it:
//!
//!   * `price`'s primary key is `(instrument_id, as_of, source)`, so a manual row and a fetched
//!     row for the same day coexist by construction and an `INSERT` of one can never clobber the
//!     other. The same holds for `fx_rate` on `(base, quote, as_of, source)`.
//!   * But coexistence is not precedence. A user who has hand-entered a price for an illiquid bond
//!     on a given day has overridden the provider for that day, and writing a fetched row beside it
//!     leaves the reader to pick. So the fetched row is not written at all when a manual row holds
//!     that key, and the instrument comes back in `held_by_manual` so the refresh report can say
//!     so rather than silently reporting "unchanged".
//!
//! `source = 'manual'` is refused outright on this path. Entering a manual override is a user
//! action with its own confirmation, not something a background refresh can do by passing a
//! different string, and a command that could write either kind is one bug away from a refresh
//! that promotes itself to an override.
//!
//! **Money and rates cross the boundary as strings and are stored as TEXT**, unparsed and
//! unrounded. `close` and `rate` are TEXT columns precisely so an eighteen-decimal crypto price
//! survives; the validation below checks the *shape* of the decimal and never its value, because
//! parsing it to compare it would be the very float this project bans.

use crate::error::{MisalError, Result};
use crate::AppState;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Sources this command will write. `manual` is deliberately absent; see the module comment.
const FETCHED_SOURCES: &[&str] = &["amfi", "twelvedata", "yahoo", "coingecko"];

/// The key under which the last completed refresh is stamped, for the TTL gate in the frontend.
pub const LAST_REFRESH_KEY: &str = "last_price_refresh_at";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceWriteRow {
    pub instrument_id: String,
    pub as_of: String,
    /// Decimal text. Stored verbatim.
    pub close: String,
    pub currency: String,
    pub source: String,
    pub fetched_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FxWriteRow {
    pub base: String,
    pub quote: String,
    pub as_of: String,
    /// Units of `quote` per one unit of `base`. Direction is fixed by `src/valuation/fx.ts`.
    pub rate: String,
    pub source: String,
}

/// What a save actually did, per row rather than in aggregate.
///
/// `held_by_manual` and `unknown` are lists rather than counts because both are things the user
/// may want named: the first is their own override winning, which is reassuring, and the second is
/// a defect worth surfacing rather than swallowing.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutcome {
    pub written: u32,
    /// Keys skipped because a manual override already holds them.
    pub held_by_manual: Vec<String>,
    /// Keys skipped because the instrument no longer exists.
    pub unknown: Vec<String>,
}

/// 'YYYY-MM-DD', checked by shape. A malformed date would sort wrongly against every other row and
/// silently become either the newest price or an unreachable one.
fn is_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
}

/// A canonical decimal: optional sign, digits, optional single fractional part.
///
/// Mirrors `DEC_PATTERN` in `src/domain/numeric.ts`. Exponent notation is rejected rather than
/// expanded: `1e-8` compares as a string against `0.00000001` and loses, and these columns are
/// compared as strings by nothing at all today but will be by something eventually.
fn is_decimal(value: &str) -> bool {
    let body = value.strip_prefix('-').unwrap_or(value);
    let mut parts = body.splitn(2, '.');
    let int = parts.next().unwrap_or_default();
    let frac = parts.next();
    if int.is_empty() || !int.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    if int.len() > 1 && int.starts_with('0') {
        return false;
    }
    match frac {
        None => true,
        Some(f) => !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()),
    }
}

fn check_source(source: &str) -> Result<()> {
    if source == "manual" {
        return Err(MisalError::Other(
            "refused: a manual override cannot be written by a price refresh".to_string(),
        ));
    }
    if !FETCHED_SOURCES.contains(&source) {
        return Err(MisalError::Other(format!(
            "refused: unknown price source {source}"
        )));
    }
    Ok(())
}

/// Validate the whole batch before opening a transaction.
///
/// Up front rather than row by row, so a malformed row is reported as a defect and no partial
/// batch is ever considered. The alternative — skipping bad rows — would let a parser regression
/// ship as a quietly shrinking refresh.
fn check_prices(rows: &[PriceWriteRow]) -> Result<()> {
    for row in rows {
        check_source(&row.source)?;
        if !is_iso_date(&row.as_of) {
            return Err(MisalError::Other(format!(
                "refused: {} is not an ISO date",
                row.as_of
            )));
        }
        if !is_decimal(&row.close) {
            return Err(MisalError::Other(format!(
                "refused: close {:?} for {} is not a canonical decimal",
                row.close, row.instrument_id
            )));
        }
        if row.currency.len() != 3 {
            return Err(MisalError::Other(format!(
                "refused: {:?} is not a currency code",
                row.currency
            )));
        }
    }
    Ok(())
}

fn check_rates(rows: &[FxWriteRow]) -> Result<()> {
    for row in rows {
        check_source(&row.source)?;
        if !is_iso_date(&row.as_of) {
            return Err(MisalError::Other(format!(
                "refused: {} is not an ISO date",
                row.as_of
            )));
        }
        if !is_decimal(&row.rate) {
            return Err(MisalError::Other(format!(
                "refused: rate {:?} for {}/{} is not a canonical decimal",
                row.rate, row.base, row.quote
            )));
        }
        if row.base.len() != 3 || row.quote.len() != 3 {
            return Err(MisalError::Other(format!(
                "refused: {}/{} is not a currency pair",
                row.base, row.quote
            )));
        }
    }
    Ok(())
}

pub fn save_prices_in(conn: &mut Connection, rows: &[PriceWriteRow]) -> Result<SaveOutcome> {
    check_prices(rows)?;

    let mut outcome = SaveOutcome::default();
    let tx = conn.transaction()?;
    {
        let mut manual_holds = tx.prepare(
            "SELECT 1 FROM price
              WHERE instrument_id = ?1 AND as_of = ?2 AND source = 'manual'",
        )?;
        let mut instrument_exists = tx.prepare("SELECT 1 FROM instrument WHERE id = ?1")?;
        // The conflict target can only fire for the same source, since source is part of the key.
        // Re-fetching the same day therefore refreshes that provider's own row and nothing else.
        let mut upsert = tx.prepare(
            "INSERT INTO price (instrument_id, as_of, close, currency, source, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (instrument_id, as_of, source) DO UPDATE SET
               close = excluded.close,
               currency = excluded.currency,
               fetched_at = excluded.fetched_at
             WHERE price.source != 'manual'",
        )?;

        for row in rows {
            let key = format!("{} {}", row.instrument_id, row.as_of);
            if instrument_exists
                .query_row([&row.instrument_id], |_| Ok(()))
                .optional()?
                .is_none()
            {
                outcome.unknown.push(key);
                continue;
            }
            if manual_holds
                .query_row([&row.instrument_id, &row.as_of], |_| Ok(()))
                .optional()?
                .is_some()
            {
                outcome.held_by_manual.push(key);
                continue;
            }
            upsert.execute(rusqlite::params![
                row.instrument_id,
                row.as_of,
                row.close,
                row.currency,
                row.source,
                row.fetched_at,
            ])?;
            outcome.written += 1;
        }
    }
    tx.commit()?;
    Ok(outcome)
}

pub fn save_fx_rates_in(conn: &mut Connection, rows: &[FxWriteRow]) -> Result<SaveOutcome> {
    check_rates(rows)?;

    let mut outcome = SaveOutcome::default();
    let tx = conn.transaction()?;
    {
        let mut manual_holds = tx.prepare(
            "SELECT 1 FROM fx_rate
              WHERE base = ?1 AND quote = ?2 AND as_of = ?3 AND source = 'manual'",
        )?;
        let mut upsert = tx.prepare(
            "INSERT INTO fx_rate (base, quote, as_of, rate, source)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (base, quote, as_of, source) DO UPDATE SET rate = excluded.rate
             WHERE fx_rate.source != 'manual'",
        )?;

        for row in rows {
            let key = format!("{}/{} {}", row.base, row.quote, row.as_of);
            if manual_holds
                .query_row([&row.base, &row.quote, &row.as_of], |_| Ok(()))
                .optional()?
                .is_some()
            {
                outcome.held_by_manual.push(key);
                continue;
            }
            upsert.execute(rusqlite::params![
                row.base, row.quote, row.as_of, row.rate, row.source,
            ])?;
            outcome.written += 1;
        }
    }
    tx.commit()?;
    Ok(outcome)
}

#[tauri::command]
pub fn save_prices(
    state: tauri::State<'_, AppState>,
    rows: Vec<PriceWriteRow>,
) -> Result<SaveOutcome> {
    let mut conn = state.conn.lock().expect("storage mutex poisoned");
    save_prices_in(&mut conn, &rows)
}

#[tauri::command]
pub fn save_fx_rates(
    state: tauri::State<'_, AppState>,
    rows: Vec<FxWriteRow>,
) -> Result<SaveOutcome> {
    let mut conn = state.conn.lock().expect("storage mutex poisoned");
    save_fx_rates_in(&mut conn, &rows)
}

/// Stamp when a refresh last completed, for the TTL gate.
///
/// A narrow command rather than a general `set_setting`, so the frontend cannot reach the rest of
/// the settings table — `base_currency` and the staleness thresholds are configuration the user
/// owns, not something a refresh may touch on its way past.
#[tauri::command]
pub fn record_price_refresh(state: tauri::State<'_, AppState>, at: String) -> Result<()> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    conn.execute(
        "INSERT INTO setting (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![LAST_REFRESH_KEY, at],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use tempfile::TempDir;

    const TEST_KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    fn seeded() -> (TempDir, Connection) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("t.db");
        let conn = db::open_at(&path, TEST_KEY).unwrap();
        db::migrate(&conn, &path).unwrap();
        conn.execute_batch(
            "INSERT INTO instrument (id, asset_class, display_name, currency, created_at)
               VALUES ('i1', 'indian_equity', 'Infosys', 'INR', 'now'),
                      ('i2', 'crypto', 'Bitcoin', 'INR', 'now');",
        )
        .unwrap();
        (dir, conn)
    }

    fn price(instrument: &str, as_of: &str, close: &str, source: &str) -> PriceWriteRow {
        PriceWriteRow {
            instrument_id: instrument.to_string(),
            as_of: as_of.to_string(),
            close: close.to_string(),
            currency: "INR".to_string(),
            source: source.to_string(),
            fetched_at: "2026-08-13T09:00:00+05:30".to_string(),
        }
    }

    #[test]
    fn a_manual_override_is_never_replaced_by_a_fetched_price() {
        // The whole reason this module exists. A user who hand-entered a price for a day has
        // overridden the provider for that day, and a refresh must report that rather than argue.
        let (_dir, mut conn) = seeded();
        conn.execute(
            "INSERT INTO price (instrument_id, as_of, close, currency, source, fetched_at)
             VALUES ('i1', '2026-08-12', '1512.50', 'INR', 'manual', 'then')",
            [],
        )
        .unwrap();

        let outcome =
            save_prices_in(&mut conn, &[price("i1", "2026-08-12", "1163.60", "yahoo")]).unwrap();

        assert_eq!(outcome.written, 0);
        assert_eq!(outcome.held_by_manual, vec!["i1 2026-08-12".to_string()]);

        let rows: i64 = conn
            .query_row("SELECT count(*) FROM price", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "a row was written beside the manual override");
        let close: String = conn
            .query_row(
                "SELECT close FROM price WHERE instrument_id='i1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(close, "1512.50");
    }

    #[test]
    fn a_manual_override_on_another_day_does_not_block_today() {
        let (_dir, mut conn) = seeded();
        conn.execute(
            "INSERT INTO price (instrument_id, as_of, close, currency, source, fetched_at)
             VALUES ('i1', '2026-08-11', '1500.00', 'INR', 'manual', 'then')",
            [],
        )
        .unwrap();

        let outcome =
            save_prices_in(&mut conn, &[price("i1", "2026-08-12", "1163.60", "yahoo")]).unwrap();
        assert_eq!(outcome.written, 1);
        assert!(outcome.held_by_manual.is_empty());
    }

    #[test]
    fn re_fetching_the_same_day_updates_that_provider_row_in_place() {
        let (_dir, mut conn) = seeded();
        save_prices_in(&mut conn, &[price("i1", "2026-08-12", "1163.60", "yahoo")]).unwrap();
        let outcome =
            save_prices_in(&mut conn, &[price("i1", "2026-08-12", "1170.00", "yahoo")]).unwrap();

        assert_eq!(outcome.written, 1);
        let (rows, close): (i64, String) = conn
            .query_row("SELECT count(*), max(close) FROM price", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(rows, 1);
        assert_eq!(close, "1170.00");
    }

    #[test]
    fn two_providers_may_hold_the_same_day() {
        // source is part of the key, so this is not a conflict and neither value is lost.
        let (_dir, mut conn) = seeded();
        save_prices_in(
            &mut conn,
            &[
                price("i1", "2026-08-12", "1163.60", "yahoo"),
                price("i1", "2026-08-12", "1163.55", "twelvedata"),
            ],
        )
        .unwrap();
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM price", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 2);
    }

    #[test]
    fn a_refresh_cannot_promote_itself_to_a_manual_override() {
        let (_dir, mut conn) = seeded();
        let refused = save_prices_in(&mut conn, &[price("i1", "2026-08-12", "1.00", "manual")]);
        assert!(refused.is_err());
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM price", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn a_malformed_decimal_is_refused_and_nothing_in_the_batch_lands() {
        // Exponent notation and free text both reach a TEXT column happily; the reader would then
        // fail on a row it cannot parse, three layers away from the code that wrote it.
        let (_dir, mut conn) = seeded();
        for bad in ["1e-8", "1,163.60", "", "1.", "abc", "01.5"] {
            let batch = vec![
                price("i1", "2026-08-12", "1163.60", "yahoo"),
                price("i2", "2026-08-12", bad, "coingecko"),
            ];
            assert!(
                save_prices_in(&mut conn, &batch).is_err(),
                "{bad:?} was accepted as a price"
            );
        }
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM price", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "a rejected batch wrote part of itself");
    }

    #[test]
    fn an_eighteen_decimal_price_survives_verbatim() {
        let (_dir, mut conn) = seeded();
        let exact = "0.000000012345678901";
        save_prices_in(&mut conn, &[price("i2", "2026-08-12", exact, "coingecko")]).unwrap();
        let stored: String = conn
            .query_row(
                "SELECT close FROM price WHERE instrument_id='i2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, exact);
    }

    #[test]
    fn a_price_for_a_deleted_instrument_is_reported_rather_than_losing_the_batch() {
        // A foreign-key failure would roll back forty good prices for one stale id.
        let (_dir, mut conn) = seeded();
        let outcome = save_prices_in(
            &mut conn,
            &[
                price("i1", "2026-08-12", "1163.60", "yahoo"),
                price("gone", "2026-08-12", "1.00", "yahoo"),
            ],
        )
        .unwrap();
        assert_eq!(outcome.written, 1);
        assert_eq!(outcome.unknown, vec!["gone 2026-08-12".to_string()]);
    }

    #[test]
    fn a_manual_exchange_rate_is_never_replaced_either() {
        let (_dir, mut conn) = seeded();
        conn.execute(
            "INSERT INTO fx_rate (base, quote, as_of, rate, source)
             VALUES ('USD', 'INR', '2026-08-12', '90.0000', 'manual')",
            [],
        )
        .unwrap();

        let outcome = save_fx_rates_in(
            &mut conn,
            &[FxWriteRow {
                base: "USD".to_string(),
                quote: "INR".to_string(),
                as_of: "2026-08-12".to_string(),
                rate: "95.3575".to_string(),
                source: "yahoo".to_string(),
            }],
        )
        .unwrap();

        assert_eq!(outcome.written, 0);
        assert_eq!(
            outcome.held_by_manual,
            vec!["USD/INR 2026-08-12".to_string()]
        );
        let rate: String = conn
            .query_row("SELECT rate FROM fx_rate", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rate, "90.0000");
    }

    #[test]
    fn an_exchange_rate_is_written_and_then_updated_in_place() {
        let (_dir, mut conn) = seeded();
        let row = || FxWriteRow {
            base: "USD".to_string(),
            quote: "INR".to_string(),
            as_of: "2026-08-12".to_string(),
            rate: "95.3575".to_string(),
            source: "yahoo".to_string(),
        };
        assert_eq!(save_fx_rates_in(&mut conn, &[row()]).unwrap().written, 1);
        assert_eq!(save_fx_rates_in(&mut conn, &[row()]).unwrap().written, 1);
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM fx_rate", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn an_ill_formed_date_is_refused() {
        let (_dir, mut conn) = seeded();
        for bad in ["2026-8-12", "12-08-2026", "2026-08-12T00:00:00Z", "today"] {
            assert!(
                save_prices_in(&mut conn, &[price("i1", bad, "1.00", "yahoo")]).is_err(),
                "{bad:?} was accepted as a date"
            );
        }
    }
}
