//! The ingestion write path: a SQLite-backed `IngestionStore`.
//!
//! The pipeline lives in TypeScript (`src/ingestion/`) and decides *what* to write; this module
//! owns the SQLite transaction that decides *whether* any of it lands. The seam is the interface
//! in `src/ingestion/store.ts`, and the mapping below is deliberately mechanical so that the two
//! can be read side by side.
//!
//! **The whole import arrives as one batch.** `IngestionStore.transaction` could have been
//! implemented as BEGIN and COMMIT commands bracketing a series of per-row IPC calls, and that
//! would have held a write transaction open across an unbounded number of round trips — a webview
//! that reloads mid-import would leave the database locked in a transaction nobody will ever
//! close. Buffering the writes on the frontend and shipping them in one call makes a partially
//! applied import unrepresentable rather than merely unlikely: if anything throws before the
//! commit, nothing was ever sent.
//!
//! **Every INTEGER money column crosses the boundary as a string**, in both directions, for the
//! reason `queries.rs` gives on the way out: a JSON number is an IEEE-754 double and a paise value
//! beyond 2^53 would be silently rounded. Inbound, the string is parsed to `i64` here — an exact
//! integer parse, never a float.
//!
//! A "partial" import in the product's vocabulary means some rows failed to *parse*: the run still
//! reaches `completed` with a non-zero `rows_failed`, and that batch commits in full. It never
//! means some rows failed to *write*.

use crate::error::{MisalError, Result};
use crate::AppState;
use chrono::SecondsFormat;
use rusqlite::{Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri_plugin_dialog::DialogExt;

// ---------------------------------------------------------------------------
// Row shapes — one per interface in src/ingestion/store.ts
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
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
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentRow {
    pub id: String,
    pub asset_class: String,
    pub display_name: String,
    pub isin: Option<String>,
    pub currency: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasRow {
    pub instrument_id: String,
    pub scheme: String,
    pub value: String,
    pub provider_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDocumentRow {
    pub id: String,
    pub account_id: Option<String>,
    pub provider_id: String,
    pub kind: String,
    pub content_hash: String,
    pub original_name: Option<String>,
    pub period_start: Option<String>,
    pub period_end: Option<String>,
    pub imported_at: String,
    pub page_ref: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
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
    /// Minor units as a string. Parsed to i64 below; never through a float.
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionRow {
    pub id: String,
    pub account_id: String,
    pub instrument_id: String,
    pub quantity: String,
    pub as_of: String,
    pub source_document_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedInstrumentRow {
    pub id: String,
    pub source_document_id: String,
    pub account_id: String,
    pub raw_identifier: String,
    pub raw_name: Option<String>,
    pub asset_class_hint: Option<String>,
    pub observed_quantity: Option<String>,
    /// The exact value withheld from every total, so the UI can state it rather than estimate it.
    pub observed_value_minor: Option<String>,
    pub currency: Option<String>,
    pub first_seen_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRunRow {
    pub id: String,
    pub source_document_id: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub status: String,
    pub parser_version: String,
    pub rows_read: i64,
    pub rows_committed: i64,
    pub rows_duplicate: i64,
    pub rows_skipped: i64,
    pub rows_failed: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportIssueRow {
    pub id: String,
    pub import_run_id: String,
    pub row_ref: Option<String>,
    pub severity: String,
    pub code: String,
    pub message: String,
    pub raw_payload: Option<String>,
    pub resolution: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityUpdate {
    pub account_id: String,
    pub capability: String,
}

/// Everything one import writes, in the order the commit applies it.
///
/// `document` is absent for a re-import: a file whose rows were withheld because their instrument
/// was not identified is imported again once it has been, and that second pass writes its rows into
/// the `source_document` the first pass already recorded. Writing a second document row would
/// violate `content_hash` uniqueness, and inventing a second document for the same bytes would be
/// a lie about provenance. The run's foreign key is what proves the document exists.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBatch {
    pub document: Option<SourceDocumentRow>,
    pub accounts: Vec<AccountRow>,
    pub capability_updates: Vec<CapabilityUpdate>,
    pub aliases: Vec<AliasRow>,
    pub txns: Vec<TxnRow>,
    pub positions: Vec<PositionRow>,
    pub unresolved: Vec<UnresolvedInstrumentRow>,
    pub run: ImportRunRow,
    pub issues: Vec<ImportIssueRow>,
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/// Parse a minor-unit string to the integer SQLite stores.
///
/// An exact integer parse. A malformed value fails the whole batch rather than being coerced,
/// because a silently zeroed amount is indistinguishable from a real one once it is in the ledger.
fn minor(value: &str) -> Result<i64> {
    value
        .parse::<i64>()
        .map_err(|_| MisalError::Other(format!("not a minor-unit integer: {value}")))
}

fn minor_opt(value: Option<&String>) -> Result<Option<i64>> {
    match value {
        None => Ok(None),
        Some(raw) => Ok(Some(minor(raw)?)),
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

// ---------------------------------------------------------------------------
// Reads — the IngestionReader half. These must not write.
// ---------------------------------------------------------------------------

fn document_of(row: &Row<'_>) -> rusqlite::Result<SourceDocumentRow> {
    Ok(SourceDocumentRow {
        id: row.get(0)?,
        account_id: row.get(1)?,
        provider_id: row.get(2)?,
        kind: row.get(3)?,
        content_hash: row.get(4)?,
        original_name: row.get(5)?,
        period_start: row.get(6)?,
        period_end: row.get(7)?,
        imported_at: row.get(8)?,
        page_ref: row.get(9)?,
    })
}

const DOCUMENT_COLUMNS: &str = "id, account_id, provider_id, kind, content_hash, original_name,
                                period_start, period_end, imported_at, page_ref";

pub fn find_document_by_hash(
    conn: &Connection,
    content_hash: &str,
) -> Result<Option<SourceDocumentRow>> {
    let sql = format!("SELECT {DOCUMENT_COLUMNS} FROM source_document WHERE content_hash = ?1");
    Ok(conn
        .query_row(&sql, [content_hash], document_of)
        .optional()?)
}

pub fn find_account_by_identity_key(
    conn: &Connection,
    identity_key: &str,
) -> Result<Option<AccountRow>> {
    Ok(conn
        .query_row(
            "SELECT id, provider_id, label, external_ref, identity_key, capability, base_currency,
                    created_at
               FROM account
              WHERE identity_key = ?1",
            [identity_key],
            |row| {
                Ok(AccountRow {
                    id: row.get(0)?,
                    provider_id: row.get(1)?,
                    label: row.get(2)?,
                    external_ref: row.get(3)?,
                    identity_key: row.get(4)?,
                    capability: row.get(5)?,
                    base_currency: row.get(6)?,
                    created_at: row.get(7)?,
                })
            },
        )
        .optional()?)
}

pub fn find_instrument_by_isin(conn: &Connection, isin: &str) -> Result<Option<InstrumentRow>> {
    Ok(conn
        .query_row(
            "SELECT id, asset_class, display_name, isin, currency FROM instrument WHERE isin = ?1",
            [isin],
            |row| {
                Ok(InstrumentRow {
                    id: row.get(0)?,
                    asset_class: row.get(1)?,
                    display_name: row.get(2)?,
                    isin: row.get(3)?,
                    currency: row.get(4)?,
                })
            },
        )
        .optional()?)
}

/// Alias lookup, including the provider-scoped case.
///
/// `provider_id IS ?3` rather than `=`, because a scheme-wide alias carries NULL there and `= NULL`
/// matches nothing. Getting this wrong would make every ISIN alias invisible to resolution.
pub fn find_alias_target(
    conn: &Connection,
    scheme: &str,
    value: &str,
    provider_id: Option<&str>,
) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT instrument_id FROM instrument_alias
              WHERE scheme = ?1 AND value = ?2 AND provider_id IS ?3",
            rusqlite::params![scheme, value, provider_id],
            |row| row.get(0),
        )
        .optional()?)
}

pub fn count_txn_by_natural_key(conn: &Connection, natural_key: &str) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT count(*) FROM txn WHERE natural_key = ?1",
        [natural_key],
        |row| row.get(0),
    )?)
}

pub fn has_txn(conn: &Connection, natural_key: &str, occurrence: i64) -> Result<bool> {
    let found: i64 = conn.query_row(
        "SELECT count(*) FROM txn WHERE natural_key = ?1 AND occurrence = ?2",
        rusqlite::params![natural_key, occurrence],
        |row| row.get(0),
    )?;
    Ok(found > 0)
}

pub fn find_position(
    conn: &Connection,
    account_id: &str,
    instrument_id: &str,
    as_of: &str,
) -> Result<Option<PositionRow>> {
    Ok(conn
        .query_row(
            "SELECT id, account_id, instrument_id, quantity, as_of, source_document_id
               FROM position
              WHERE account_id = ?1 AND instrument_id = ?2 AND as_of = ?3",
            rusqlite::params![account_id, instrument_id, as_of],
            |row| {
                Ok(PositionRow {
                    id: row.get(0)?,
                    account_id: row.get(1)?,
                    instrument_id: row.get(2)?,
                    quantity: row.get(3)?,
                    as_of: row.get(4)?,
                    source_document_id: row.get(5)?,
                })
            },
        )
        .optional()?)
}

/// The review queue for one document.
///
/// `list_unresolved` in `queries.rs` answers for the whole database, which is what the settings
/// screen wants; an import report has to be able to say what *this* file could not identify.
///
/// Matched on `last_seen_document_id` as well as the document that first raised the entry, because
/// only one open entry exists per identifier per account: the second statement carrying the same
/// unmapped ISIN would otherwise be handed an empty review queue while still withholding its rows.
///
/// Dismissed and mapped entries are excluded — this list is the set of questions still being asked.
/// They remain in `list_unresolved`, and their value remains withheld and disclosed, because
/// neither answer has put the money into a total.
pub fn unresolved_for_document(
    conn: &Connection,
    document_id: &str,
) -> Result<Vec<UnresolvedInstrumentRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, source_document_id, account_id, raw_identifier, raw_name, asset_class_hint,
                observed_quantity, CAST(observed_value_minor AS TEXT), currency, first_seen_at
           FROM unresolved_instrument
          WHERE (source_document_id = ?1 OR last_seen_document_id = ?1)
            AND resolved_at IS NULL AND ignored_at IS NULL AND mapped_at IS NULL
          ORDER BY first_seen_at, raw_identifier",
    )?;
    let rows = stmt.query_map([document_id], |row| {
        Ok(UnresolvedInstrumentRow {
            id: row.get(0)?,
            source_document_id: row.get(1)?,
            account_id: row.get(2)?,
            raw_identifier: row.get(3)?,
            raw_name: row.get(4)?,
            asset_class_hint: row.get(5)?,
            observed_quantity: row.get(6)?,
            observed_value_minor: row.get(7)?,
            currency: row.get(8)?,
            first_seen_at: row.get(9)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// How many rows a document is still withholding from every total.
///
/// The predicate that decides whether re-importing the same file is a no-op. A document whose rows
/// were withheld for want of an identifier is not finished with: once the identifier is mapped,
/// importing the file again is the only path that puts those rows in the ledger, and the content
/// hash would otherwise refuse it forever. A dismissed entry does not count — the user has said
/// they do not want to be asked, so the file goes back to being idempotent.
pub fn withheld_for_document(conn: &Connection, document_id: &str) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT count(*) FROM unresolved_instrument
          WHERE (source_document_id = ?1 OR last_seen_document_id = ?1)
            AND resolved_at IS NULL AND ignored_at IS NULL",
        [document_id],
        |row| row.get(0),
    )?)
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

/// Apply one import in a single SQLite transaction.
///
/// `rusqlite::Transaction` rolls back on drop, so every early return below leaves the database
/// exactly as it was found.
///
/// **Accounts are written before the document, which is not the order the ingestion spec states.**
/// The spec puts `source_document` first, but a document declaring exactly one account carries that
/// account's id in `source_document.account_id`, and with `PRAGMA foreign_keys = ON` that reference
/// has to resolve at statement time. The spec's order is unsatisfiable for the single-account case;
/// everything after this swap is as written there.
pub fn commit_batch(conn: &mut Connection, batch: &ImportBatch) -> Result<()> {
    let tx = conn.transaction()?;

    for account in &batch.accounts {
        tx.execute(
            "INSERT INTO account (id, provider_id, label, external_ref, identity_key, capability,
                base_currency, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                account.id,
                account.provider_id,
                account.label,
                account.external_ref,
                account.identity_key,
                account.capability,
                account.base_currency,
                account.created_at,
            ],
        )?;
    }

    for update in &batch.capability_updates {
        tx.execute(
            "UPDATE account SET capability = ?2 WHERE id = ?1",
            rusqlite::params![update.account_id, update.capability],
        )?;
    }

    if let Some(doc) = &batch.document {
        tx.execute(
            "INSERT INTO source_document (id, account_id, provider_id, kind, content_hash,
                original_name, period_start, period_end, imported_at, page_ref)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                doc.id,
                doc.account_id,
                doc.provider_id,
                doc.kind,
                doc.content_hash,
                doc.original_name,
                doc.period_start,
                doc.period_end,
                doc.imported_at,
                doc.page_ref,
            ],
        )?;
    }
    let document_id = batch.run.source_document_id.clone();

    for alias in &batch.aliases {
        insert_alias(&tx, alias)?;
    }

    for txn in &batch.txns {
        tx.execute(
            "INSERT INTO txn (id, account_id, instrument_id, type, occurred_at, occurred_tz,
                quantity, price, amount_minor, brokerage_minor, stt_minor, gst_minor,
                stamp_duty_minor, other_fees_minor, tds_minor, currency, fx_rate,
                source_document_id, natural_key, occurrence, authority, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                ?18, ?19, ?20, ?21, ?22)",
            rusqlite::params![
                txn.id,
                txn.account_id,
                txn.instrument_id,
                txn.txn_type,
                txn.occurred_at,
                txn.occurred_tz,
                txn.quantity,
                txn.price,
                minor_opt(txn.amount_minor.as_ref())?,
                minor(&txn.brokerage_minor)?,
                minor(&txn.stt_minor)?,
                minor(&txn.gst_minor)?,
                minor(&txn.stamp_duty_minor)?,
                minor(&txn.other_fees_minor)?,
                minor(&txn.tds_minor)?,
                txn.currency,
                txn.fx_rate,
                txn.source_document_id,
                txn.natural_key,
                txn.occurrence,
                txn.authority,
                txn.created_at,
            ],
        )?;
    }

    for position in &batch.positions {
        // A position is a restatement of a fact rather than an event, so the same holding for the
        // same date is updated in place. The pipeline has already decided whether that restatement
        // deserves a W_POSITION_RESTATED warning; storage only carries it out.
        tx.execute(
            "INSERT INTO position (id, account_id, instrument_id, quantity, as_of,
                source_document_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (account_id, instrument_id, as_of)
             DO UPDATE SET quantity = excluded.quantity,
                           source_document_id = excluded.source_document_id",
            rusqlite::params![
                position.id,
                position.account_id,
                position.instrument_id,
                position.quantity,
                position.as_of,
                position.source_document_id,
            ],
        )?;
    }

    for entry in &batch.unresolved {
        record_unresolved(&tx, entry)?;
    }

    let run = &batch.run;
    tx.execute(
        "INSERT INTO import_run (id, source_document_id, started_at, finished_at, status,
            parser_version, rows_read, rows_committed, rows_duplicate, rows_skipped, rows_failed)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        rusqlite::params![
            run.id,
            run.source_document_id,
            run.started_at,
            run.finished_at,
            run.status,
            run.parser_version,
            run.rows_read,
            run.rows_committed,
            run.rows_duplicate,
            run.rows_skipped,
            run.rows_failed,
        ],
    )?;

    for issue in &batch.issues {
        tx.execute(
            "INSERT INTO import_issue (id, import_run_id, row_ref, severity, code, message,
                raw_payload, resolution)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                issue.id,
                issue.import_run_id,
                issue.row_ref,
                issue.severity,
                issue.code,
                issue.message,
                issue.raw_payload,
                issue.resolution,
            ],
        )?;
    }

    release_landed_rows(&tx, &document_id)?;

    tx.commit()?;
    Ok(())
}

/// Queue an identifier this document could not resolve, at most once per account.
///
/// Guarded exactly like `sync.rs::record_unresolved`, which has always got this right: an import
/// inserting a fresh row per statement made a monthly eCAS report twelve instruments and twelve
/// times the rupees for one holding, and the withheld tile is the one figure in the product that
/// exists to be believed literally. The question is the same question until the user answers it.
///
/// The touch is an update rather than a replacement. `coalesce` keeps a value a previous sighting
/// stated where this one states none — a tradebook has no valuation column, and letting it blank
/// the figure a holdings statement printed would destroy the disclosure just as thoroughly as
/// counting it twice would inflate it.
fn record_unresolved(conn: &Connection, entry: &UnresolvedInstrumentRow) -> Result<()> {
    let observed = minor_opt(entry.observed_value_minor.as_ref())?;

    conn.execute(
        "UPDATE unresolved_instrument
            SET observed_value_minor = coalesce(?1, observed_value_minor),
                observed_quantity    = coalesce(?2, observed_quantity),
                currency             = coalesce(?3, currency),
                last_seen_at         = ?4,
                last_seen_document_id = ?5
          WHERE account_id = ?6 AND raw_identifier = ?7 AND resolved_at IS NULL",
        rusqlite::params![
            observed,
            entry.observed_quantity,
            entry.currency,
            entry.first_seen_at,
            entry.source_document_id,
            entry.account_id,
            entry.raw_identifier,
        ],
    )?;

    conn.execute(
        "INSERT INTO unresolved_instrument (id, source_document_id, account_id, raw_identifier,
            raw_name, asset_class_hint, observed_quantity, observed_value_minor, currency,
            first_seen_at, last_seen_at, last_seen_document_id)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?2
          WHERE NOT EXISTS (SELECT 1 FROM unresolved_instrument
                             WHERE account_id = ?3 AND raw_identifier = ?4
                               AND resolved_at IS NULL)",
        rusqlite::params![
            entry.id,
            entry.source_document_id,
            entry.account_id,
            entry.raw_identifier,
            entry.raw_name,
            entry.asset_class_hint,
            entry.observed_quantity,
            observed,
            entry.currency,
            entry.first_seen_at,
        ],
    )?;
    Ok(())
}

/// Close every mapped entry whose rows this document just put into the ledger.
///
/// The only event that may set `resolved_at`, because `resolved_at` is the whole system's "no
/// longer missing from any total" predicate. Mapping an identifier learns the alias but moves no
/// money: until a document carrying those rows is imported, the value is still absent from net
/// worth and must still be disclosed. This is the moment it stops being absent, so it is the moment
/// the disclosure stops — and it is keyed on rows that actually exist rather than on the user
/// having clicked something.
fn release_landed_rows(conn: &Connection, document_id: &str) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE unresolved_instrument
            SET resolved_at = ?1
          WHERE resolved_at IS NULL
            AND mapped_at IS NOT NULL
            AND resolved_instrument_id IS NOT NULL
            AND (EXISTS (SELECT 1 FROM txn t
                          WHERE t.source_document_id = ?2
                            AND t.account_id = unresolved_instrument.account_id
                            AND t.instrument_id = unresolved_instrument.resolved_instrument_id)
              OR EXISTS (SELECT 1 FROM position p
                          WHERE p.source_document_id = ?2
                            AND p.account_id = unresolved_instrument.account_id
                            AND p.instrument_id = unresolved_instrument.resolved_instrument_id))",
        rusqlite::params![now_iso(), document_id],
    )?)
}

/// Insert an alias only where none exists for that identifier.
///
/// Two reasons this is a guarded insert rather than a plain one. An alias already pointing at a
/// different instrument is never repointed — the uniqueness constraint exists so a wrong mapping
/// cannot be written twice, and quietly overwriting it would defeat that. And the schema's
/// `PRIMARY KEY (scheme, value, provider_id)` does not stop a duplicate when `provider_id` is NULL,
/// because SQLite treats NULLs in a unique index as distinct: an ISIN alias could otherwise be
/// inserted any number of times.
fn insert_alias(conn: &Connection, alias: &AliasRow) -> Result<()> {
    conn.execute(
        "INSERT INTO instrument_alias (instrument_id, scheme, value, provider_id)
         SELECT ?1, ?2, ?3, ?4
          WHERE NOT EXISTS (SELECT 1 FROM instrument_alias
                             WHERE scheme = ?2 AND value = ?3 AND provider_id IS ?4)",
        rusqlite::params![
            alias.instrument_id,
            alias.scheme,
            alias.value,
            alias.provider_id
        ],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// The review queue
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingOutcome {
    /// The alias written, if the identifier was one that can be aliased at all.
    pub alias_scheme: Option<String>,
    /// Queue entries this mapping answered, across every account that named the identifier.
    ///
    /// Deliberately not called `released`. Nothing is released by a mapping: the withheld rows are
    /// not in the ledger until a document carrying them is imported, and until then these entries
    /// keep withholding — and keep disclosing — exactly what they did before.
    pub matched: i64,
}

/// Split a queue entry's `raw_identifier` into the alias it implies.
///
/// The identifiers are minted by `rawIdentifierOf` in `src/ingestion/resolve.ts` and this is the
/// inverse. `name:` is the one form that yields no alias: a display name is not an identifier, and
/// writing one as an alias would make the next statement resolve on a string the registrar is free
/// to re-spell.
fn alias_for_identifier(raw_identifier: &str, provider_id: &str) -> Option<(String, String, bool)> {
    let (prefix, value) = raw_identifier.split_once(':')?;
    if value.is_empty() {
        return None;
    }
    match prefix {
        "isin" => Some(("isin".to_string(), value.to_string(), false)),
        "amfi" => Some(("amfi".to_string(), value.to_string(), false)),
        "nse" => Some(("nse".to_string(), value.to_string(), false)),
        "bse" => Some(("bse".to_string(), value.to_string(), false)),
        // The schema has no per-US-exchange scheme; `ticker` is its catch-all.
        "nasdaq" | "nyse" => Some(("ticker".to_string(), value.to_string(), false)),
        "provider-local" => {
            let _ = provider_id;
            Some(("provider-local".to_string(), value.to_string(), true))
        }
        _ => None,
    }
}

/// Map an unresolved identifier onto an instrument the user chose.
///
/// One transaction doing two things: learning the alias, so the next statement resolves without
/// asking again, and recording the answer against every queue entry that named the same identifier,
/// because resolving `INF179K01YV8` once answers it in every folio that held it.
///
/// **What it deliberately does not do is set `resolved_at`.** The rows this import withheld were
/// never written — an import whose rows all failed to resolve commits zero `txn` rows — and naming
/// the instrument does not conjure them. Closing the entry here would stop the withheld figure and
/// the unresolved count disclosing money that is still absent from net worth, which is the same
/// silent loss that dismissing an entry used to cause. `commit_batch` closes the entry when the
/// rows actually land; `withheld_for_document` is what lets the user get them there.
pub fn map_unresolved(
    conn: &mut Connection,
    unresolved_id: &str,
    instrument_id: &str,
) -> Result<MappingOutcome> {
    let tx = conn.transaction()?;

    let (raw_identifier, provider_id): (String, String) = tx
        .query_row(
            "SELECT u.raw_identifier, d.provider_id
               FROM unresolved_instrument u
               JOIN source_document d ON d.id = u.source_document_id
              WHERE u.id = ?1",
            [unresolved_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| MisalError::Other(format!("no queue entry {unresolved_id}")))?;

    let exists: i64 = tx.query_row(
        "SELECT count(*) FROM instrument WHERE id = ?1",
        [instrument_id],
        |row| row.get(0),
    )?;
    if exists == 0 {
        return Err(MisalError::Other(format!(
            "no instrument {instrument_id} to map onto"
        )));
    }

    let mut alias_scheme = None;
    if let Some((scheme, value, provider_scoped)) =
        alias_for_identifier(&raw_identifier, &provider_id)
    {
        let scoped = if provider_scoped {
            Some(provider_id.as_str())
        } else {
            None
        };
        // Refuse rather than repoint. An identifier already naming another instrument is a
        // contradiction the user has to see, not one storage should resolve by overwriting.
        if let Some(existing) = find_alias_target(&tx, &scheme, &value, scoped)? {
            if existing != instrument_id {
                return Err(MisalError::Other(format!(
                    "{raw_identifier} already maps to a different instrument"
                )));
            }
        }
        insert_alias(
            &tx,
            &AliasRow {
                instrument_id: instrument_id.to_string(),
                scheme: scheme.clone(),
                value,
                provider_id: scoped.map(str::to_string),
            },
        )?;
        alias_scheme = Some(scheme);
    }

    // `ignored_at` is cleared: an entry the user dismissed and has now come back to name is an
    // active mapping, not a dismissal that happens to carry an instrument.
    let matched = tx.execute(
        "UPDATE unresolved_instrument
            SET mapped_at = ?1, resolved_instrument_id = ?2, ignored_at = NULL
          WHERE raw_identifier = ?3 AND resolved_at IS NULL",
        rusqlite::params![now_iso(), instrument_id, raw_identifier],
    )?;

    tx.commit()?;
    Ok(MappingOutcome {
        alias_scheme,
        matched: i64::try_from(matched).unwrap_or(i64::MAX),
    })
}

/// Dismiss a queue entry without mapping it.
///
/// The value stays withheld from every total and the entry stays readable in settings; what changes
/// is only that the import report stops asking.
///
/// This sets `ignored_at` and leaves `resolved_at` NULL, which is the whole point of migration
/// 0006. Setting `resolved_at` — the only "still open" predicate in the system — made a dismissal
/// erase the disclosure along with the question: the withheld rupee figure fell to zero, the count
/// fell to zero, and the dashboard began asserting that every identifier in every document is
/// mapped. The holding was every bit as absent from net worth as before, and now nothing said so.
pub fn ignore_unresolved(conn: &Connection, unresolved_id: &str) -> Result<()> {
    let changed = conn.execute(
        "UPDATE unresolved_instrument SET ignored_at = ?1
          WHERE id = ?2 AND resolved_at IS NULL AND ignored_at IS NULL",
        rusqlite::params![now_iso(), unresolved_id],
    )?;
    if changed == 0 {
        return Err(MisalError::Other(format!(
            "no open queue entry {unresolved_id}"
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn ingest_find_document_by_hash(
    state: tauri::State<'_, AppState>,
    content_hash: String,
) -> Result<Option<SourceDocumentRow>> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    find_document_by_hash(&conn, &content_hash)
}

#[tauri::command]
pub fn ingest_find_account_by_identity_key(
    state: tauri::State<'_, AppState>,
    identity_key: String,
) -> Result<Option<AccountRow>> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    find_account_by_identity_key(&conn, &identity_key)
}

#[tauri::command]
pub fn ingest_find_instrument_by_isin(
    state: tauri::State<'_, AppState>,
    isin: String,
) -> Result<Option<InstrumentRow>> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    find_instrument_by_isin(&conn, &isin)
}

#[tauri::command]
pub fn ingest_find_alias_target(
    state: tauri::State<'_, AppState>,
    scheme: String,
    value: String,
    provider_id: Option<String>,
) -> Result<Option<String>> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    find_alias_target(&conn, &scheme, &value, provider_id.as_deref())
}

#[tauri::command]
pub fn ingest_count_txn_by_natural_key(
    state: tauri::State<'_, AppState>,
    natural_key: String,
) -> Result<i64> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    count_txn_by_natural_key(&conn, &natural_key)
}

#[tauri::command]
pub fn ingest_has_txn(
    state: tauri::State<'_, AppState>,
    natural_key: String,
    occurrence: i64,
) -> Result<bool> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    has_txn(&conn, &natural_key, occurrence)
}

#[tauri::command]
pub fn ingest_find_position(
    state: tauri::State<'_, AppState>,
    account_id: String,
    instrument_id: String,
    as_of: String,
) -> Result<Option<PositionRow>> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    find_position(&conn, &account_id, &instrument_id, &as_of)
}

#[tauri::command]
pub fn ingest_commit(state: tauri::State<'_, AppState>, batch: ImportBatch) -> Result<()> {
    let mut conn = state.conn.lock().expect("storage mutex poisoned");
    commit_batch(&mut conn, &batch)
}

#[tauri::command]
pub fn ingest_unresolved_for_document(
    state: tauri::State<'_, AppState>,
    document_id: String,
) -> Result<Vec<UnresolvedInstrumentRow>> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    unresolved_for_document(&conn, &document_id)
}

#[tauri::command]
pub fn ingest_withheld_for_document(
    state: tauri::State<'_, AppState>,
    document_id: String,
) -> Result<i64> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    withheld_for_document(&conn, &document_id)
}

#[tauri::command]
pub fn ingest_map_unresolved(
    state: tauri::State<'_, AppState>,
    unresolved_id: String,
    instrument_id: String,
) -> Result<MappingOutcome> {
    let mut conn = state.conn.lock().expect("storage mutex poisoned");
    map_unresolved(&mut conn, &unresolved_id, &instrument_id)
}

#[tauri::command]
pub fn ingest_ignore_unresolved(
    state: tauri::State<'_, AppState>,
    unresolved_id: String,
) -> Result<()> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    ignore_unresolved(&conn, &unresolved_id)
}

// ---------------------------------------------------------------------------
// File selection
// ---------------------------------------------------------------------------

/// A file the user chose, named by a handle rather than by its path.
///
/// The path is deliberately not returned. The webview has no use for it — it displays the file's
/// name and hands the handle back to be read — and a path the frontend never holds is a path a
/// compromised frontend cannot ask for.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub handle: String,
    pub name: String,
    pub byte_length: u64,
}

/// The largest statement Misal will read into memory.
///
/// A multi-year CAS runs to a few megabytes. This is well beyond any real one and exists so that a
/// mistaken or malicious handle cannot make the process read a file until it dies — the bytes are
/// held whole, hashed whole, and parsed whole.
pub const MAX_STATEMENT_BYTES: u64 = 64 * 1024 * 1024;

/// Extensions a statement may have. The picker filters on these; this is what enforces them.
const STATEMENT_EXTENSIONS: &[&str] = &["pdf", "csv"];

fn has_statement_extension(path: &Path) -> bool {
    path.extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|ext| STATEMENT_EXTENSIONS.contains(&ext.as_str()))
}

/// The set of files the user has chosen this session, and the only files that can be read.
///
/// The mirror of the invariant `export.rs` and `http.rs` each assert in their own header: there is
/// no command taking a caller-supplied destination, and no command taking a caller-supplied URL.
/// There must equally be no command taking a caller-supplied *source*. `read_statement_bytes` used
/// to be exactly that — `std::fs::read` on a path from the webview — so one call named
/// `~/.ssh/id_rsa` and got the bytes back. A handle can only be exchanged for a path the native
/// picker returned, which means only for a file the user chose in a dialog they saw.
#[derive(Default)]
pub struct PickedFiles {
    paths: Mutex<HashMap<String, PathBuf>>,
}

impl PickedFiles {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a picked path and return its handle.
    ///
    /// Refuses anything that is not a statement by extension. The dialog's filter is a convenience
    /// for the user, not a constraint — on most platforms a name can still be typed past it — so
    /// the check has to exist somewhere that is not the dialog.
    pub fn record(&self, path: PathBuf) -> Result<String> {
        if !has_statement_extension(&path) {
            return Err(MisalError::Other(
                "a statement must be a .pdf or a .csv".to_string(),
            ));
        }
        let handle = uuid::Uuid::new_v4().to_string();
        self.paths
            .lock()
            .expect("picked-file mutex poisoned")
            .insert(handle.clone(), path);
        Ok(handle)
    }

    fn resolve(&self, handle: &str) -> Option<PathBuf> {
        self.paths
            .lock()
            .expect("picked-file mutex poisoned")
            .get(handle)
            .cloned()
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.paths.lock().expect("picked-file mutex poisoned").len()
    }
}

/// The native file picker.
///
/// Async so Tauri runs it off the main thread; the blocking picker deadlocks the event loop if it
/// is called from there. Files arrive because the user chose one — Misal never reads a directory,
/// never watches one, and never logs into a registrar to fetch a statement itself.
#[tauri::command]
pub async fn pick_statement_file(
    app: tauri::AppHandle,
    picked_files: tauri::State<'_, PickedFiles>,
) -> Result<Option<PickedFile>> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Statements", &["pdf", "csv"])
        .set_title("Choose a statement")
        .blocking_pick_file();

    let Some(file) = picked else { return Ok(None) };
    let path = file
        .into_path()
        .map_err(|error| MisalError::Other(error.to_string()))?;
    let byte_length = std::fs::metadata(&path)?.len();
    if byte_length > MAX_STATEMENT_BYTES {
        return Err(MisalError::Other(format!(
            "{} is larger than the {} MB a statement may be",
            path.display(),
            MAX_STATEMENT_BYTES / (1024 * 1024)
        )));
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let handle = picked_files.record(path)?;

    Ok(Some(PickedFile {
        handle,
        name,
        byte_length,
    }))
}

/// Read a file the user picked, named by the handle the picker returned.
///
/// Nothing is copied into Misal's storage. The pipeline hashes these bytes and records the hash;
/// the file stays where the user put it.
fn read_picked(picked_files: &PickedFiles, handle: &str) -> Result<Vec<u8>> {
    let path = picked_files
        .resolve(handle)
        .ok_or_else(|| MisalError::Other("no file was picked under that handle".to_string()))?;

    // Re-checked at read time rather than trusted from the pick: the file could have been replaced
    // between the dialog closing and this call, and the cap exists to bound what is read now.
    if !has_statement_extension(&path) {
        return Err(MisalError::Other(
            "a statement must be a .pdf or a .csv".to_string(),
        ));
    }
    let length = std::fs::metadata(&path)?.len();
    if length > MAX_STATEMENT_BYTES {
        return Err(MisalError::Other(format!(
            "{} is larger than the {} MB a statement may be",
            path.display(),
            MAX_STATEMENT_BYTES / (1024 * 1024)
        )));
    }

    Ok(std::fs::read(&path)?)
}

/// Hand the chosen file's bytes to the pipeline.
///
/// Returned as a raw IPC response — an ArrayBuffer on the frontend — rather than a JSON array of
/// numbers, which for a multi-megabyte statement would be an order of magnitude larger and would
/// be parsed a byte at a time.
#[tauri::command]
pub fn read_statement_bytes(
    picked_files: tauri::State<'_, PickedFiles>,
    handle: String,
) -> Result<tauri::ipc::Response> {
    Ok(tauri::ipc::Response::new(read_picked(
        &picked_files,
        &handle,
    )?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use tempfile::TempDir;

    const TEST_KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    fn open_test_db() -> (TempDir, Connection) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("t.db");
        let conn = db::open_at(&path, TEST_KEY).unwrap();
        db::migrate(&conn, &path).unwrap();
        conn.execute_batch(
            "INSERT INTO instrument (id, asset_class, display_name, isin, currency, created_at)
               VALUES ('i-ppfc', 'mutual_fund', 'Parag Parikh Flexi Cap', 'INF879O01019', 'INR',
                       'now');",
        )
        .unwrap();
        (dir, conn)
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    fn account(id: &str) -> AccountRow {
        AccountRow {
            id: id.to_string(),
            provider_id: "cams-cas".to_string(),
            label: "HDFC folio".to_string(),
            external_ref: Some("12345678 / 0".to_string()),
            identity_key: Some(format!("mf-folio:hdfc:{id}")),
            capability: "ledger".to_string(),
            base_currency: "INR".to_string(),
            created_at: "2026-08-12T00:00:00Z".to_string(),
        }
    }

    fn txn(id: &str, instrument_id: &str, natural_key: &str, amount_minor: &str) -> TxnRow {
        TxnRow {
            id: id.to_string(),
            account_id: "a1".to_string(),
            instrument_id: instrument_id.to_string(),
            txn_type: "buy".to_string(),
            occurred_at: "2026-01-05T00:00:00+05:30".to_string(),
            occurred_tz: Some("Asia/Kolkata".to_string()),
            quantity: "10.5000".to_string(),
            price: Some("190.4762".to_string()),
            amount_minor: Some(amount_minor.to_string()),
            brokerage_minor: "0".to_string(),
            stt_minor: "0".to_string(),
            gst_minor: "0".to_string(),
            stamp_duty_minor: "10".to_string(),
            other_fees_minor: "0".to_string(),
            tds_minor: "0".to_string(),
            currency: "INR".to_string(),
            fx_rate: None,
            source_document_id: "d1".to_string(),
            natural_key: natural_key.to_string(),
            occurrence: 0,
            authority: "primary".to_string(),
            created_at: "2026-08-12T00:00:00Z".to_string(),
        }
    }

    fn batch(content_hash: &str, txns: Vec<TxnRow>) -> ImportBatch {
        ImportBatch {
            document: Some(SourceDocumentRow {
                id: "d1".to_string(),
                account_id: Some("a1".to_string()),
                provider_id: "cams-cas".to_string(),
                kind: "cas-pdf".to_string(),
                content_hash: content_hash.to_string(),
                original_name: Some("CAS_APR2023_JUL2026.pdf".to_string()),
                period_start: Some("2023-04-01T00:00:00+05:30".to_string()),
                period_end: Some("2026-07-31T00:00:00+05:30".to_string()),
                imported_at: "2026-08-12T10:44:00Z".to_string(),
                page_ref: Some("p.1-13".to_string()),
            }),
            accounts: vec![account("a1")],
            capability_updates: vec![],
            aliases: vec![AliasRow {
                instrument_id: "i-ppfc".to_string(),
                scheme: "isin".to_string(),
                value: "INF879O01019".to_string(),
                provider_id: None,
            }],
            txns,
            positions: vec![PositionRow {
                id: "p1".to_string(),
                account_id: "a1".to_string(),
                instrument_id: "i-ppfc".to_string(),
                quantity: "10.5000".to_string(),
                as_of: "2026-07-31T00:00:00+05:30".to_string(),
                source_document_id: "d1".to_string(),
            }],
            unresolved: vec![UnresolvedInstrumentRow {
                id: "u1".to_string(),
                source_document_id: "d1".to_string(),
                account_id: "a1".to_string(),
                raw_identifier: "isin:INF179K01YV8".to_string(),
                raw_name: Some("HDFC BALANCED ADVANTAGE FUND".to_string()),
                asset_class_hint: Some("mutual_fund".to_string()),
                observed_quantity: Some("412.882".to_string()),
                observed_value_minor: Some("11864000".to_string()),
                currency: Some("INR".to_string()),
                first_seen_at: "2026-08-12T10:44:00Z".to_string(),
            }],
            run: ImportRunRow {
                id: "r1".to_string(),
                source_document_id: "d1".to_string(),
                started_at: "2026-08-12T10:44:00Z".to_string(),
                finished_at: Some("2026-08-12T10:44:02Z".to_string()),
                // A partial import is a completed import.
                status: "completed".to_string(),
                parser_version: "cams-kfin-cas".to_string(),
                rows_read: 4,
                rows_committed: 2,
                rows_duplicate: 0,
                rows_skipped: 1,
                rows_failed: 1,
            },
            issues: vec![ImportIssueRow {
                id: "is1".to_string(),
                import_run_id: "r1".to_string(),
                row_ref: Some("p.11 r.3".to_string()),
                severity: "error".to_string(),
                code: "E_DATE_PARSE".to_string(),
                message: "31-02-2025 is not a valid date".to_string(),
                raw_payload: Some("{\"date\":\"31-02-2025\"}".to_string()),
                resolution: "open".to_string(),
            }],
        }
    }

    /// The one outcome storage must make impossible.
    ///
    /// The batch below is valid right up to its last transaction, which names an instrument that
    /// does not exist. If the commit were not atomic, the user would be left with a
    /// `source_document` burning the file's content hash — permanently blocking a re-import of the
    /// file that failed — plus an account, an alias and half a ledger.
    #[test]
    fn a_failed_import_leaves_the_database_exactly_as_it_was() {
        let (_dir, mut conn) = open_test_db();
        let before: Vec<i64> = [
            "source_document",
            "account",
            "instrument_alias",
            "txn",
            "position",
            "unresolved_instrument",
            "import_run",
            "import_issue",
        ]
        .iter()
        .map(|table| count(&conn, table))
        .collect();

        let doomed = batch(
            "hash-a",
            vec![
                txn("t1", "i-ppfc", "key-1", "200000"),
                txn("t2", "i-does-not-exist", "key-2", "300000"),
            ],
        );
        assert!(
            commit_batch(&mut conn, &doomed).is_err(),
            "a transaction against an unknown instrument was accepted"
        );

        let after: Vec<i64> = [
            "source_document",
            "account",
            "instrument_alias",
            "txn",
            "position",
            "unresolved_instrument",
            "import_run",
            "import_issue",
        ]
        .iter()
        .map(|table| count(&conn, table))
        .collect();
        assert_eq!(before, after, "a failed import left rows behind");

        // And the file is still importable, which is the point of writing no source_document.
        assert!(find_document_by_hash(&conn, "hash-a").unwrap().is_none());
    }

    /// A malformed amount fails the batch rather than being coerced to zero.
    #[test]
    fn an_unparseable_amount_rolls_the_whole_import_back() {
        let (_dir, mut conn) = open_test_db();
        let doomed = batch("hash-b", vec![txn("t1", "i-ppfc", "key-1", "2,000.00")]);
        assert!(commit_batch(&mut conn, &doomed).is_err());
        assert_eq!(count(&conn, "source_document"), 0);
        assert_eq!(count(&conn, "txn"), 0);
    }

    /// Re-importing the same file changes nothing.
    ///
    /// Two mechanisms, both asserted: the hash lookup the pipeline performs first, which is what
    /// makes the second import a no-op rather than an error the user has to read; and the
    /// uniqueness constraint underneath it, which holds even if that lookup were skipped.
    #[test]
    fn re_importing_the_same_file_is_a_no_op() {
        let (_dir, mut conn) = open_test_db();
        let first = batch("hash-c", vec![txn("t1", "i-ppfc", "key-1", "200000")]);
        commit_batch(&mut conn, &first).unwrap();

        let seen = find_document_by_hash(&conn, "hash-c").unwrap();
        assert!(seen.is_some(), "the pipeline would not recognise the file");
        assert_eq!(
            seen.unwrap().original_name.unwrap(),
            "CAS_APR2023_JUL2026.pdf"
        );

        let counts_after_first = (
            count(&conn, "source_document"),
            count(&conn, "txn"),
            count(&conn, "position"),
            count(&conn, "account"),
            count(&conn, "import_run"),
            count(&conn, "instrument_alias"),
        );

        // Belt and braces: force the commit through anyway. The content hash is unique, so the
        // second attempt fails whole rather than doubling the ledger.
        let again = batch("hash-c", vec![txn("t9", "i-ppfc", "key-9", "200000")]);
        assert!(commit_batch(&mut conn, &again).is_err());

        assert_eq!(
            counts_after_first,
            (
                count(&conn, "source_document"),
                count(&conn, "txn"),
                count(&conn, "position"),
                count(&conn, "account"),
                count(&conn, "import_run"),
                count(&conn, "instrument_alias"),
            ),
            "a re-import changed the database"
        );
    }

    #[test]
    fn a_paise_value_beyond_two_to_the_fifty_third_survives_the_write() {
        let (_dir, mut conn) = open_test_db();
        let huge = "9007199254740993"; // 2^53 + 1
        commit_batch(
            &mut conn,
            &batch("hash-d", vec![txn("t1", "i-ppfc", "key-1", huge)]),
        )
        .unwrap();

        let stored: String = conn
            .query_row("SELECT CAST(amount_minor AS TEXT) FROM txn", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(stored, huge);
    }

    #[test]
    fn a_restated_holding_updates_in_place_rather_than_duplicating() {
        let (_dir, mut conn) = open_test_db();
        commit_batch(&mut conn, &batch("hash-e", vec![])).unwrap();

        let mut second = batch("hash-f", vec![]);
        second.document.as_mut().unwrap().id = "d2".to_string();
        second.accounts = vec![];
        second.run.id = "r2".to_string();
        second.run.source_document_id = "d2".to_string();
        second.issues = vec![];
        second.unresolved = vec![];
        second.positions[0].source_document_id = "d2".to_string();
        second.positions[0].quantity = "11.0000".to_string();
        commit_batch(&mut conn, &second).unwrap();

        assert_eq!(count(&conn, "position"), 1);
        let quantity: String = conn
            .query_row("SELECT quantity FROM position", [], |r| r.get(0))
            .unwrap();
        assert_eq!(quantity, "11.0000");
    }

    /// Resolving an identifier once answers it everywhere it was seen.
    #[test]
    fn mapping_an_identifier_answers_every_queue_entry_that_named_it() {
        let (_dir, mut conn) = open_test_db();
        let mut first = batch("hash-g", vec![]);
        // The same ISIN in a second folio. Different account, so it is a second open entry rather
        // than a duplicate of the first.
        first.accounts.push(account("a2"));
        first.unresolved.push(UnresolvedInstrumentRow {
            id: "u2".to_string(),
            source_document_id: "d1".to_string(),
            account_id: "a2".to_string(),
            raw_identifier: "isin:INF179K01YV8".to_string(),
            raw_name: Some("HDFC BALANCED ADVANTAGE FUND".to_string()),
            asset_class_hint: Some("mutual_fund".to_string()),
            observed_quantity: None,
            observed_value_minor: None,
            currency: Some("INR".to_string()),
            first_seen_at: "2026-08-12T10:44:00Z".to_string(),
        });
        commit_batch(&mut conn, &first).unwrap();

        let outcome = map_unresolved(&mut conn, "u1", "i-ppfc").unwrap();
        assert_eq!(outcome.matched, 2, "the second folio's entry stayed open");
        assert_eq!(outcome.alias_scheme.unwrap(), "isin");

        // The alias is what makes the next statement resolve without asking again.
        assert_eq!(
            find_alias_target(&conn, "isin", "INF179K01YV8", None)
                .unwrap()
                .unwrap(),
            "i-ppfc"
        );
        // Both are answered, and neither is closed: the withheld rows are still not in the ledger.
        assert_eq!(
            count(&conn, "unresolved_instrument WHERE mapped_at IS NOT NULL"),
            2
        );
        assert_eq!(
            count(&conn, "unresolved_instrument WHERE resolved_at IS NULL"),
            2
        );
        // And the import report stops asking about them.
        assert!(unresolved_for_document(&conn, "d1").unwrap().is_empty());
    }

    /// Defect B. Mapping an identifier must not make the money it was withholding disappear.
    ///
    /// An import whose rows all failed to resolve writes zero `txn` rows but does write a
    /// `source_document` carrying the file's content hash, so a re-import used to be refused
    /// forever. Naming the instrument wrote the alias and closed the queue entry — and closing the
    /// entry is what stopped the rupee figure and the count disclosing rows that were still absent
    /// from every total, with no path left to get them in. Two things have to hold: the disclosure
    /// survives the mapping, and the document becomes importable again so the rows can land.
    #[test]
    fn mapping_keeps_disclosing_until_the_rows_actually_land() {
        let (_dir, mut conn) = open_test_db();
        // The instrument the queue entry turns out to name. Deliberately not `i-ppfc`, whose
        // holding this document already resolved: the release has to be caused by the withheld
        // rows landing, not by anything the first import happened to write.
        conn.execute(
            "INSERT INTO instrument (id, asset_class, display_name, isin, currency, created_at)
             VALUES ('i-hdfc', 'mutual_fund', 'HDFC Balanced Advantage', 'INF179K01YV8', 'INR',
                     'now')",
            [],
        )
        .unwrap();
        commit_batch(&mut conn, &batch("hash-withheld", vec![])).unwrap();
        assert_eq!(count(&conn, "txn"), 0);

        map_unresolved(&mut conn, "u1", "i-hdfc").unwrap();

        // Still open, so `list_unresolved`, the withheld total and the unresolved count all still
        // report it. The holding is exactly as absent from net worth as it was a moment ago.
        let (open, withheld): (i64, Option<String>) = conn
            .query_row(
                "SELECT count(*), CAST(max(observed_value_minor) AS TEXT)
                   FROM unresolved_instrument WHERE resolved_at IS NULL",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(open, 1, "the mapping erased the disclosure");
        assert_eq!(withheld.as_deref(), Some("11864000"));

        // And the file is importable again, which is the only way those rows reach the ledger.
        assert_eq!(withheld_for_document(&conn, "d1").unwrap(), 1);

        // The re-import: same document, no second source_document, and now the rows resolve.
        let mut again = batch(
            "hash-withheld",
            vec![txn("t1", "i-hdfc", "key-1", "11864000")],
        );
        again.document = None;
        again.accounts = vec![];
        again.aliases = vec![];
        again.run.id = "r2".to_string();
        again.issues = vec![];
        again.unresolved = vec![];
        again.positions = vec![];
        commit_batch(&mut conn, &again).unwrap();

        assert_eq!(count(&conn, "txn"), 1, "the withheld row never landed");
        assert_eq!(
            count(&conn, "unresolved_instrument WHERE resolved_at IS NULL"),
            0,
            "the entry kept withholding value that is now in the ledger"
        );
        // Counted once, not twice: the money is in `txn` and no longer in the withheld figure.
        assert_eq!(count(&conn, "source_document"), 1);
        assert_eq!(withheld_for_document(&conn, "d1").unwrap(), 0);
    }

    /// Defect C. One statement a month must not report twelve instruments and twelve times the
    /// rupees for one holding.
    #[test]
    fn a_second_statement_naming_the_same_unmapped_identifier_does_not_queue_it_again() {
        let (_dir, mut conn) = open_test_db();
        commit_batch(&mut conn, &batch("hash-jan", vec![])).unwrap();

        let mut february = batch("hash-feb", vec![]);
        february.document.as_mut().unwrap().id = "d2".to_string();
        february.accounts = vec![];
        february.run.id = "r2".to_string();
        february.run.source_document_id = "d2".to_string();
        february.issues = vec![];
        february.positions[0].source_document_id = "d2".to_string();
        february.unresolved[0].id = "u2".to_string();
        february.unresolved[0].source_document_id = "d2".to_string();
        // The holding grew, so the figure withheld is February's, not January's plus February's.
        february.unresolved[0].observed_value_minor = Some("12000000".to_string());
        february.unresolved[0].first_seen_at = "2026-09-12T10:44:00Z".to_string();
        commit_batch(&mut conn, &february).unwrap();

        let (open, withheld): (i64, Option<String>) = conn
            .query_row(
                "SELECT count(*), CAST(sum(observed_value_minor) AS TEXT)
                   FROM unresolved_instrument WHERE resolved_at IS NULL",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(open, 1, "one holding was queued twice");
        assert_eq!(
            withheld.as_deref(),
            Some("12000000"),
            "the withheld total doubled a single holding"
        );

        // February's report still names what February could not identify, even though the entry
        // it is showing was raised by January.
        let queue = unresolved_for_document(&conn, "d2").unwrap();
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].id, "u1", "a second row was invented for it");
        assert_eq!(unresolved_for_document(&conn, "d1").unwrap().len(), 1);
    }

    /// A sighting that states no value must not blank one that did.
    #[test]
    fn a_later_sighting_without_a_value_keeps_the_one_already_disclosed() {
        let (_dir, mut conn) = open_test_db();
        commit_batch(&mut conn, &batch("hash-valued", vec![])).unwrap();

        let mut tradebook = batch("hash-tradebook", vec![]);
        tradebook.document.as_mut().unwrap().id = "d2".to_string();
        tradebook.accounts = vec![];
        tradebook.run.id = "r2".to_string();
        tradebook.run.source_document_id = "d2".to_string();
        tradebook.issues = vec![];
        tradebook.positions[0].source_document_id = "d2".to_string();
        tradebook.unresolved[0].id = "u2".to_string();
        tradebook.unresolved[0].source_document_id = "d2".to_string();
        tradebook.unresolved[0].observed_value_minor = None;
        tradebook.unresolved[0].observed_quantity = None;
        commit_batch(&mut conn, &tradebook).unwrap();

        let withheld: Option<String> = conn
            .query_row(
                "SELECT CAST(observed_value_minor AS TEXT) FROM unresolved_instrument",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(withheld.as_deref(), Some("11864000"));
    }

    #[test]
    fn an_identifier_already_naming_another_instrument_is_refused_rather_than_repointed() {
        let (_dir, mut conn) = open_test_db();
        conn.execute(
            "INSERT INTO instrument (id, asset_class, display_name, currency, created_at)
             VALUES ('i-other', 'mutual_fund', 'Another fund', 'INR', 'now')",
            [],
        )
        .unwrap();
        commit_batch(&mut conn, &batch("hash-h", vec![])).unwrap();
        map_unresolved(&mut conn, "u1", "i-ppfc").unwrap();

        assert!(map_unresolved(&mut conn, "u1", "i-other").is_err());
        assert_eq!(
            find_alias_target(&conn, "isin", "INF179K01YV8", None)
                .unwrap()
                .unwrap(),
            "i-ppfc"
        );
    }

    /// A name is not an identifier, so it cannot become an alias.
    #[test]
    fn a_name_only_entry_resolves_without_learning_an_alias() {
        let (_dir, mut conn) = open_test_db();
        let mut only_name = batch("hash-i", vec![]);
        only_name.unresolved[0].raw_identifier = "name:HDFC BALANCED ADVANTAGE FUND".to_string();
        commit_batch(&mut conn, &only_name).unwrap();

        let outcome = map_unresolved(&mut conn, "u1", "i-ppfc").unwrap();
        assert!(outcome.alias_scheme.is_none());
        assert_eq!(outcome.matched, 1);
        assert_eq!(count(&conn, "instrument_alias"), 1); // only the ISIN the batch proved
    }

    #[test]
    fn dismissing_an_entry_keeps_it_unmapped() {
        let (_dir, mut conn) = open_test_db();
        commit_batch(&mut conn, &batch("hash-j", vec![])).unwrap();
        ignore_unresolved(&conn, "u1").unwrap();

        let mapped: Option<String> = conn
            .query_row(
                "SELECT resolved_instrument_id FROM unresolved_instrument WHERE id = 'u1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(mapped.is_none(), "a dismissal invented a mapping");
        assert!(ignore_unresolved(&conn, "u1").is_err(), "dismissed twice");
    }

    /// Defect A. Dismissing a queue entry must not erase the money it was withholding.
    ///
    /// `resolved_at` is the only "still open" predicate in the system — `list_unresolved`, the
    /// document queue and `valuation/portfolio.ts`'s withheld total all read it. Setting it on a
    /// dismissal made ₹1,18,640 that is genuinely absent from net worth stop being counted as
    /// absent: the figure fell to zero, the count fell to zero, and the dashboard replaced the
    /// disclosure with the affirmative claim that every identifier in every document is mapped.
    /// Permanently, because nothing reopens a closed entry.
    #[test]
    fn dismissing_an_entry_keeps_disclosing_the_value_it_withholds() {
        let (_dir, mut conn) = open_test_db();
        commit_batch(&mut conn, &batch("hash-dismissed", vec![])).unwrap();
        ignore_unresolved(&conn, "u1").unwrap();

        // What every consumer of `resolved_at IS NULL` sees: still one row, still ₹1,18,640.
        let (open, withheld): (i64, Option<String>) = conn
            .query_row(
                "SELECT count(*), CAST(sum(observed_value_minor) AS TEXT)
                   FROM unresolved_instrument WHERE resolved_at IS NULL",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(open, 1, "a dismissal erased the withheld disclosure");
        assert_eq!(withheld.as_deref(), Some("11864000"));

        // The one thing a dismissal does change: the import report stops asking.
        assert!(unresolved_for_document(&conn, "d1").unwrap().is_empty());
        // And the file goes back to being idempotent — the user asked not to be chased.
        assert_eq!(withheld_for_document(&conn, "d1").unwrap(), 0);
    }

    /// A dismissal is not a refusal. Coming back to name it must work, and must clear the dismissal.
    #[test]
    fn a_dismissed_entry_can_still_be_mapped_later() {
        let (_dir, mut conn) = open_test_db();
        commit_batch(&mut conn, &batch("hash-dismiss-then-map", vec![])).unwrap();
        ignore_unresolved(&conn, "u1").unwrap();

        let outcome = map_unresolved(&mut conn, "u1", "i-ppfc").unwrap();
        assert_eq!(outcome.matched, 1);
        let (ignored, mapped): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT ignored_at, mapped_at FROM unresolved_instrument WHERE id = 'u1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(ignored.is_none(), "the dismissal outlived the mapping");
        assert!(mapped.is_some());
        assert_eq!(withheld_for_document(&conn, "d1").unwrap(), 1);
    }

    #[test]
    fn an_alias_is_never_written_twice_for_the_same_identifier() {
        // SQLite treats NULLs in a unique index as distinct, so the schema's
        // PRIMARY KEY (scheme, value, provider_id) does not stop this on its own.
        let (_dir, conn) = open_test_db();
        let alias = AliasRow {
            instrument_id: "i-ppfc".to_string(),
            scheme: "isin".to_string(),
            value: "INF879O01019".to_string(),
            provider_id: None,
        };
        insert_alias(&conn, &alias).unwrap();
        insert_alias(&conn, &alias).unwrap();
        assert_eq!(count(&conn, "instrument_alias"), 1);
    }

    #[test]
    fn the_document_scoped_queue_only_answers_for_its_own_document() {
        let (_dir, mut conn) = open_test_db();
        commit_batch(&mut conn, &batch("hash-k", vec![])).unwrap();
        assert_eq!(unresolved_for_document(&conn, "d1").unwrap().len(), 1);
        assert!(unresolved_for_document(&conn, "d2").unwrap().is_empty());

        let entry = &unresolved_for_document(&conn, "d1").unwrap()[0];
        assert_eq!(
            entry.observed_value_minor.as_deref(),
            Some("11864000"),
            "the withheld value must reach the UI as text"
        );
    }

    // -----------------------------------------------------------------------
    // Reading a picked file
    // -----------------------------------------------------------------------

    /// Defect D. The webview cannot name a file to read.
    ///
    /// `read_statement_bytes` took a path and called `std::fs::read` on it, with no binding to the
    /// picker's result, no extension check and no size cap, so
    /// `invoke('read_statement_bytes', {path: '~/.ssh/id_rsa'})` returned the bytes. `export.rs`
    /// and `http.rs` both refuse the mirror of this primitive in their own headers — no
    /// caller-supplied destination, no caller-supplied URL — and this is the third one.
    #[test]
    fn a_path_the_user_never_picked_cannot_be_read() {
        let dir = TempDir::new().unwrap();
        let secret = dir.path().join("id_rsa");
        std::fs::write(&secret, b"-----BEGIN OPENSSH PRIVATE KEY-----").unwrap();

        let picked = PickedFiles::new();
        // The exploit exactly as it was: the caller names the file it wants. Under the old
        // signature this returned the key; a handle is not a path and resolves to nothing.
        let refused = read_picked(&picked, &secret.display().to_string());
        assert!(refused.is_err(), "an arbitrary path was read");
        assert!(read_picked(&picked, "../../etc/passwd").is_err());
        assert!(read_picked(&picked, "").is_err());
        assert_eq!(picked.len(), 0, "a read registered a file");
    }

    #[test]
    fn a_file_the_user_picked_reads_back_by_handle() {
        let dir = TempDir::new().unwrap();
        let statement = dir.path().join("CAS_APR2023.pdf");
        std::fs::write(&statement, b"%PDF-1.7 pretend").unwrap();

        let picked = PickedFiles::new();
        let handle = picked.record(statement).unwrap();
        assert_eq!(read_picked(&picked, &handle).unwrap(), b"%PDF-1.7 pretend");

        // The handle names one file, not a directory the caller can walk out of.
        assert!(read_picked(&picked, &format!("{handle}/../id_rsa")).is_err());
    }

    #[test]
    fn only_a_statement_can_be_picked_at_all() {
        // The dialog's filter is a convenience, not a constraint: a name can be typed past it on
        // most platforms, so the extension is checked where it is enforced rather than offered.
        let picked = PickedFiles::new();
        assert!(picked
            .record(PathBuf::from("/home/someone/.ssh/id_rsa"))
            .is_err());
        assert!(picked.record(PathBuf::from("/etc/passwd")).is_err());
        assert!(picked.record(PathBuf::from("/tmp/notes")).is_err());
        assert!(picked.record(PathBuf::from("/tmp/cas.PDF")).is_ok());
        assert!(picked.record(PathBuf::from("/tmp/tradebook.csv")).is_ok());
    }

    #[test]
    fn a_file_beyond_the_cap_is_refused_rather_than_read_whole() {
        let dir = TempDir::new().unwrap();
        let huge = dir.path().join("huge.csv");
        let file = std::fs::File::create(&huge).unwrap();
        // Sparse, so the test does not actually write 64 MB to disk.
        file.set_len(MAX_STATEMENT_BYTES + 1).unwrap();
        drop(file);

        let picked = PickedFiles::new();
        let handle = picked.record(huge).unwrap();
        let refused = read_picked(&picked, &handle);
        assert!(refused.is_err(), "an unbounded read was allowed");
    }

    // -----------------------------------------------------------------------
    // Migration 0006 — the unresolved lifecycle
    // -----------------------------------------------------------------------

    const MIGRATION_LIFECYCLE: &str = include_str!("../migrations/0006-unresolved-lifecycle.sql");

    /// A database written before 0006 can already hold the duplicates it now forbids, so it has to
    /// collapse them before it can constrain — otherwise the index fails and the user is stuck on
    /// the old schema with the doubled figures the migration exists to correct.
    #[test]
    fn migration_0006_collapses_a_holding_queued_once_per_statement() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("t.db");
        let conn = db::open_at(&path, TEST_KEY).unwrap();
        conn.execute_batch(include_str!("../migrations/0001-initial.sql"))
            .unwrap();
        conn.execute_batch(
            "INSERT INTO account (id, provider_id, label, capability, base_currency, created_at)
               VALUES ('a1', 'cams-cas', 'HDFC folio', 'ledger', 'INR', 'now');
             INSERT INTO source_document (id, provider_id, kind, content_hash, imported_at)
               VALUES ('d1', 'cams-cas', 'cas-pdf', 'h1', 'now'),
                      ('d2', 'cams-cas', 'cas-pdf', 'h2', 'now'),
                      ('d3', 'cams-cas', 'cas-pdf', 'h3', 'now');
             INSERT INTO unresolved_instrument (id, source_document_id, account_id, raw_identifier,
                 observed_value_minor, currency, first_seen_at)
               VALUES ('u1', 'd1', 'a1', 'isin:INF179K01YV8', 11864000, 'INR', '2026-01-01'),
                      ('u2', 'd2', 'a1', 'isin:INF179K01YV8', 11900000, 'INR', '2026-02-01'),
                      ('u3', 'd3', 'a1', 'isin:INF179K01YV8', 12000000, 'INR', '2026-03-01');
             -- A different holding, and a closed entry, both of which must survive untouched.
             INSERT INTO unresolved_instrument (id, source_document_id, account_id, raw_identifier,
                 observed_value_minor, currency, first_seen_at, resolved_at)
               VALUES ('u4', 'd1', 'a1', 'isin:INE009A01021', 500000, 'INR', '2026-01-01', NULL),
                      ('u5', 'd1', 'a1', 'isin:INF179K01YV8', 900000, 'INR', '2025-01-01', 'then');",
        )
        .unwrap();

        conn.execute_batch(MIGRATION_LIFECYCLE).unwrap();

        let (open, withheld): (i64, Option<String>) = conn
            .query_row(
                "SELECT count(*), CAST(sum(observed_value_minor) AS TEXT)
                   FROM unresolved_instrument
                  WHERE resolved_at IS NULL AND raw_identifier = 'isin:INF179K01YV8'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(open, 1, "three sightings of one holding survived as three");
        // The earliest sighting is kept, carrying the most recent value — which is what the
        // holding is actually worth, not the sum of every month it was seen.
        assert_eq!(withheld.as_deref(), Some("12000000"));

        let kept: (String, Option<String>) = conn
            .query_row(
                "SELECT id, last_seen_document_id FROM unresolved_instrument
                  WHERE resolved_at IS NULL AND raw_identifier = 'isin:INF179K01YV8'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(kept.0, "u1");
        assert_eq!(kept.1.as_deref(), Some("d3"));

        assert_eq!(count(&conn, "unresolved_instrument WHERE id = 'u4'"), 1);
        assert_eq!(count(&conn, "unresolved_instrument WHERE id = 'u5'"), 1);

        // And the rule is structural from here.
        let duplicate = conn.execute(
            "INSERT INTO unresolved_instrument (id, source_document_id, account_id, raw_identifier,
                 first_seen_at)
               VALUES ('u9', 'd1', 'a1', 'isin:INF179K01YV8', 'now')",
            [],
        );
        assert!(duplicate.is_err(), "a second open entry was admitted");
    }

    // -----------------------------------------------------------------------
    // Migration 0004 — re-keying MF folios off an AMC name slug
    // -----------------------------------------------------------------------

    const MIGRATION_AMC: &str = include_str!("../migrations/0005-amc-identity.sql");

    /// A database as it stood before migration 0004: schema at version 3, folio identity keys
    /// still built from a slug of whatever the document printed.
    fn pre_0004_db() -> (TempDir, Connection) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("t.db");
        let conn = db::open_at(&path, TEST_KEY).unwrap();
        conn.execute_batch(include_str!("../migrations/0001-initial.sql"))
            .unwrap();
        (dir, conn)
    }

    fn add_account(conn: &Connection, id: &str, identity_key: &str) {
        conn.execute(
            "INSERT INTO account (id, provider_id, label, external_ref, identity_key, capability,
                                  base_currency, created_at)
                  VALUES (?1, 'cams-cas', ?2, '12345678/0', ?3, 'ledger', 'INR', '2026-01-01')",
            rusqlite::params![id, format!("folio {id}"), identity_key],
        )
        .unwrap();
    }

    fn identity_of(conn: &Connection, id: &str) -> Option<String> {
        conn.query_row(
            "SELECT identity_key FROM account WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn migration_0004_converges_two_spellings_of_one_amc_on_one_key() {
        // The whole point. A folio keyed from a CAMS statement and the *same* folio keyed from an
        // NSDL eCAS printed the fund name and the legal entity respectively, so the two rows below
        // are what one folio looked like after two imports under the old code. They must end up on
        // the same identity, which is also why only one of them can keep it.
        let (_dir, conn) = pre_0004_db();
        add_account(&conn, "a1", "mf-folio:hdfc-mutual-fund:12345678/0");
        add_account(
            &conn,
            "a2",
            "mf-folio:hdfc-asset-management-company-limited:12345678/0",
        );

        conn.execute_batch(MIGRATION_AMC).unwrap();

        // Both rewrite onto 'mf-folio:hdfc:12345678/0', which the unique index permits exactly one
        // of. Neither is silently merged and neither is deleted, because the transactions hanging
        // off them cannot be deduplicated in SQL: natural_key is a hash over account_id.
        assert_eq!(
            identity_of(&conn, "a1").as_deref(),
            Some("mf-folio:hdfc-mutual-fund:12345678/0")
        );
        assert_eq!(
            identity_of(&conn, "a2").as_deref(),
            Some("mf-folio:hdfc-asset-management-company-limited:12345678/0")
        );
    }

    #[test]
    fn migration_0004_rewrites_a_folio_onto_its_canonical_amc_id() {
        let (_dir, conn) = pre_0004_db();
        add_account(&conn, "a1", "mf-folio:hdfc-mutual-fund:12345678/0");
        add_account(
            &conn,
            "a2",
            "mf-folio:icici-prudential-mutual-fund:91012424/0",
        );
        // A rename the folio outlived: units bought under Reliance are held under Nippon India.
        add_account(&conn, "a3", "mf-folio:reliance-mutual-fund:55555555/1");

        conn.execute_batch(MIGRATION_AMC).unwrap();

        assert_eq!(
            identity_of(&conn, "a1").as_deref(),
            Some("mf-folio:hdfc:12345678/0")
        );
        assert_eq!(
            identity_of(&conn, "a2").as_deref(),
            Some("mf-folio:icici-prudential:91012424/0")
        );
        assert_eq!(
            identity_of(&conn, "a3").as_deref(),
            Some("mf-folio:nippon-india:55555555/1")
        );
    }

    #[test]
    fn migration_0004_leaves_alone_what_it_cannot_name() {
        let (_dir, conn) = pre_0004_db();
        // A demat account, which has no AMC at all.
        add_account(&conn, "a1", "demat:IN300394-12345678");
        // A fund house the registry does not know. Rewriting it to anything would be a guess.
        add_account(&conn, "a2", "mf-folio:novus-capital-mutual-fund:12345678/0");
        // Not an identity key at all.
        conn.execute(
            "INSERT INTO account (id, provider_id, label, capability, base_currency, created_at)
                  VALUES ('a3', 'cams-cas', 'no identity', 'snapshot', 'INR', '2026-01-01')",
            [],
        )
        .unwrap();

        conn.execute_batch(MIGRATION_AMC).unwrap();

        assert_eq!(
            identity_of(&conn, "a1").as_deref(),
            Some("demat:IN300394-12345678")
        );
        assert_eq!(
            identity_of(&conn, "a2").as_deref(),
            Some("mf-folio:novus-capital-mutual-fund:12345678/0")
        );
        assert_eq!(identity_of(&conn, "a3"), None);
    }

    #[test]
    fn migration_0004_is_idempotent() {
        // A key already canonical must survive a second application unchanged, and the temp tables
        // must not linger to collide with it.
        let (_dir, conn) = pre_0004_db();
        add_account(&conn, "a1", "mf-folio:hdfc-mutual-fund:12345678/0");

        conn.execute_batch(MIGRATION_AMC).unwrap();
        conn.execute_batch(MIGRATION_AMC).unwrap();

        assert_eq!(
            identity_of(&conn, "a1").as_deref(),
            Some("mf-folio:hdfc:12345678/0")
        );
        assert_eq!(count(&conn, "account"), 1);
    }
}
