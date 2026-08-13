//! Settings, bring-your-own-key provider secrets, and manual price overrides.
//!
//! Three things live here, and they share a module because they share one screen and one rule.
//!
//! **The rule: a secret never crosses this boundary.** A provider key is written straight to the OS
//! keychain by `secrets.rs`; what the database holds is nothing at all, and what the frontend is
//! told is a three-state presence flag. There is no command here that reads a key back, so no
//! response type can carry one and no React state can serialise one. `no_settings_response_carries_
//! the_secret` asserts that against a real serialisation rather than against a code review.
//!
//! **Settings are validated here, not in the UI.** The frontend performs the same checks for an
//! instant message, but the definitions it uses to do so are shipped *from* this module, so there
//! is one set of bounds rather than two that drift. A rejected write names the problem: "must be a
//! whole number of minutes" is actionable and "invalid value" is not.
//!
//! **A manual price is a first-class valuation input, not a patch.** It is the only way to value an
//! instrument no provider covers — a physical gold holding, an unlisted share, a fund whose
//! registrar prints no code — so the write path treats it as authoritative. `price`'s primary key
//! includes `source`, which is what lets a manual row coexist with a fetched one for the same day
//! instead of destroying it; every statement below writes `source = 'manual'` and only ever
//! conflicts with another manual row, so a refresh has no expressible way to overwrite one.
//!
//! Numeric values cross as strings and are validated as strings. `close` is checked against the
//! same canonical-decimal grammar `dec()` enforces in TypeScript — never parsed to an f64, which
//! would round a price on its way into the database it is meant to correct.

use crate::error::{MisalError, Result};
use crate::http::MARKET_DATA_HOSTS;
use crate::secrets;
use crate::AppState;
use chrono::SecondsFormat;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// How a setting's value is constrained, and what to call it on screen.
///
/// `kind` drives the control the UI renders; `min`, `max` and `choices` drive both its validation
/// and this module's. Shipping them rather than duplicating them is what keeps the two in step.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingDefinition {
    pub key: &'static str,
    pub label: &'static str,
    pub help: &'static str,
    /// `"currency"` or `"integer"`.
    pub kind: &'static str,
    pub unit: Option<&'static str>,
    pub min: Option<i64>,
    pub max: Option<i64>,
    pub choices: Vec<&'static str>,
}

/// Base currencies this setting may be set to.
///
/// **INR alone, deliberately.** The numeric layer has a minor-unit exponent for USD as well, and an
/// earlier version offered both on that basis — but the valuation engine converts every holding to
/// INR unconditionally, and the rate feed in `src/data/refresh.ts` only fetches pairs quoted in
/// INR. Choosing USD therefore stopped USD/INR ever being written again while the engine carried on
/// converting through the last rate it had: net worth kept moving daily on refreshed prices with
/// the FX leg frozen at the day the setting changed, and nothing on screen said so.
///
/// A choice that changes a label without changing the arithmetic is worse than no choice, so the
/// list is one entry until the engine reads the setting. Any other currency is refused here rather
/// than accepted and quietly ignored. Kept in step with `CURRENCY_EXPONENT` in
/// `src/domain/numeric.ts`: a base currency this list admits but that table does not would fail at
/// the first attempt to format a total.
const CURRENCIES: &[&str] = &["INR"];

struct Spec {
    key: &'static str,
    label: &'static str,
    help: &'static str,
    /// `None` for the currency choice; `Some((min, max, unit))` for an integer.
    range: Option<(i64, i64, &'static str)>,
}

/// The four rows of `setting` this screen owns.
///
/// Deliberately a closed list. `setting` is a key-value table and an unconstrained writer would let
/// the frontend invent keys nothing reads, or overwrite one that something else depends on.
///
/// The help text says what each key *means*, in the present tense of the setting rather than of the
/// engine. Whether a given subsystem consults it yet is a separate fact, and the screen states that
/// separately rather than letting a description imply it.
const SPECS: &[Spec] = &[
    Spec {
        key: "base_currency",
        label: "Base currency",
        help: "The currency every total is expressed in. INR only: the valuation engine converts \
               to INR unconditionally, so a second choice here would relabel the totals without \
               converting them. Present value uses the latest stored rate; cost and XIRR use the \
               rate stored on each transaction.",
        range: None,
    },
    Spec {
        key: "price_cache_ttl_minutes",
        label: "Price cache lifetime",
        help: "The age past which a refresh should re-fetch a stored price. The price table is \
               the cache; there is no second layer, so this is the only knob.",
        range: Some((1, 20_160, "minutes")),
    },
    Spec {
        key: "stale_price_days",
        label: "Stale-price threshold",
        help: "The age past which a price should be treated as stale, and every figure derived \
               from it labelled accordingly.",
        range: Some((1, 365, "days")),
    },
    Spec {
        key: "concentration_flag_percent",
        label: "Concentration flag",
        help: "The share of net worth at which a single holding should be flagged. An observation \
               about your own portfolio, not a recommendation.",
        range: Some((1, 100, "percent")),
    },
];

pub fn definitions() -> Vec<SettingDefinition> {
    SPECS
        .iter()
        .map(|spec| match spec.range {
            None => SettingDefinition {
                key: spec.key,
                label: spec.label,
                help: spec.help,
                kind: "currency",
                unit: None,
                min: None,
                max: None,
                choices: CURRENCIES.to_vec(),
            },
            Some((min, max, unit)) => SettingDefinition {
                key: spec.key,
                label: spec.label,
                help: spec.help,
                kind: "integer",
                unit: Some(unit),
                min: Some(min),
                max: Some(max),
                choices: Vec::new(),
            },
        })
        .collect()
}

/// Validate a setting write, returning the value as it will be stored.
///
/// Every rejection names the problem rather than reporting that one exists. A user who typed `6.5`
/// into a minutes field needs to be told it must be whole, not that it is invalid.
pub fn validate_setting(key: &str, raw: &str) -> Result<String> {
    let value = raw.trim();
    let Some(spec) = SPECS.iter().find(|spec| spec.key == key) else {
        return Err(MisalError::Other(format!(
            "{key} is not a setting this screen may change"
        )));
    };

    match spec.range {
        None => {
            let upper = value.to_ascii_uppercase();
            if !CURRENCIES.contains(&upper.as_str()) {
                return Err(MisalError::Other(format!(
                    "{} must be one of {}; every total is computed in INR, so {} would relabel \
                     them without converting them",
                    spec.label,
                    CURRENCIES.join(", "),
                    quoted(value)
                )));
            }
            Ok(upper)
        }
        Some((min, max, unit)) => {
            if value.is_empty() {
                return Err(MisalError::Other(format!(
                    "{} needs a value in {unit}; the field is empty",
                    spec.label
                )));
            }
            let Ok(number) = value.parse::<i64>() else {
                return Err(MisalError::Other(format!(
                    "{} must be a whole number of {unit}; {} is not",
                    spec.label,
                    quoted(value)
                )));
            };
            if number < min || number > max {
                return Err(MisalError::Other(format!(
                    "{} must be between {min} and {max} {unit}; {number} is outside that range",
                    spec.label
                )));
            }
            Ok(number.to_string())
        }
    }
}

fn quoted(value: &str) -> String {
    format!("\u{201c}{value}\u{201d}")
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingRow {
    pub key: String,
    pub value: String,
    pub updated_at: String,
}

fn read_settings(conn: &Connection) -> Result<Vec<SettingRow>> {
    let mut stmt = conn.prepare("SELECT key, value, updated_at FROM setting ORDER BY key")?;
    let rows = stmt.query_map([], |row| {
        Ok(SettingRow {
            key: row.get(0)?,
            value: row.get(1)?,
            updated_at: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn write_setting(conn: &Connection, key: &str, raw: &str) -> Result<SettingRow> {
    let value = validate_setting(key, raw)?;
    let updated_at = now_iso();
    conn.execute(
        "INSERT INTO setting (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![key, value, updated_at],
    )?;
    Ok(SettingRow {
        key: key.to_string(),
        value,
        updated_at,
    })
}

// ---------------------------------------------------------------------------
// Provider keys — bring your own, and nothing here can hand one back
// ---------------------------------------------------------------------------

/// The keychain, behind a trait so tests can assert the no-secret property without one.
///
/// There is deliberately no `read` on this trait. A method returning the secret would be the one
/// thing a future command could accidentally expose, so the capability does not exist rather than
/// existing unused.
pub trait KeyStore {
    fn store(&self, keychain_key: &str, secret: &str) -> Result<()>;
    fn present(&self, keychain_key: &str) -> Result<bool>;
    fn clear(&self, keychain_key: &str) -> Result<()>;
}

pub struct Keychain;

impl KeyStore for Keychain {
    fn store(&self, keychain_key: &str, secret: &str) -> Result<()> {
        secrets::store_secret(keychain_key, secret)
    }

    /// Presence, never the value.
    ///
    /// `keyring` offers no existence probe, so the secret is fetched and dropped in the same
    /// expression. It is never bound to a name, never logged, and never returned.
    fn present(&self, keychain_key: &str) -> Result<bool> {
        Ok(secrets::read_secret(keychain_key)?.is_some())
    }

    fn clear(&self, keychain_key: &str) -> Result<()> {
        secrets::delete_secret(keychain_key)
    }
}

pub struct ProviderSpec {
    pub id: &'static str,
    pub display_name: &'static str,
    /// What this key buys, and what already works without it.
    pub covers: &'static str,
    pub without_key: &'static str,
}

/// Providers a user may bring a key for.
///
/// One, in v1. AMFI needs no key and CoinGecko's free tier needs none either, which is why the
/// screen leads with what works keyless rather than with this list.
pub const PROVIDERS: &[ProviderSpec] = &[ProviderSpec {
    id: "twelvedata",
    display_name: "Twelve Data",
    covers: "US equities, crypto and FX rates, on the free Basic plan.",
    without_key: "Indian exchange data is not on the Basic plan even with a key: NSE and BSE \
                  quotes need a paid tier. Those instruments take a manual price instead.",
}];

/// Keychain entry for a provider key.
///
/// A namespace of its own, distinct from `secrets::account_secret_key`'s `secret/{account_id}`, so
/// a provider id can never collide with an account id or with the database key entry.
pub fn provider_secret_key(provider_id: &str) -> String {
    format!("provider-key/{provider_id}")
}

/// Whether a key is held. Three states, because "the keychain would not answer" is not "no key".
///
/// Collapsing `unavailable` into `absent` would tell a user their key had vanished whenever the
/// Secret Service was not running, and invite them to re-enter a key they already have.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKeyStatus {
    pub id: String,
    pub display_name: String,
    pub covers: String,
    pub without_key: String,
    /// `"present"`, `"absent"` or `"unavailable"`. Never the key, in any state.
    pub status: String,
    /// Why the keychain could not be read, when it could not be.
    pub detail: Option<String>,
}

fn provider_spec(provider_id: &str) -> Result<&'static ProviderSpec> {
    PROVIDERS
        .iter()
        .find(|spec| spec.id == provider_id)
        .ok_or_else(|| {
            MisalError::Other(format!(
                "{provider_id} is not a provider Misal can hold a key for"
            ))
        })
}

fn status_of(spec: &ProviderSpec, keys: &dyn KeyStore) -> ProviderKeyStatus {
    let (status, detail) = match keys.present(&provider_secret_key(spec.id)) {
        Ok(true) => ("present", None),
        Ok(false) => ("absent", None),
        Err(error) => ("unavailable", Some(error.to_string())),
    };
    ProviderKeyStatus {
        id: spec.id.to_string(),
        display_name: spec.display_name.to_string(),
        covers: spec.covers.to_string(),
        without_key: spec.without_key.to_string(),
        status: status.to_string(),
        detail,
    }
}

fn provider_statuses(keys: &dyn KeyStore) -> Vec<ProviderKeyStatus> {
    PROVIDERS.iter().map(|spec| status_of(spec, keys)).collect()
}

/// Store a provider key.
///
/// Every rejection describes the *shape* of the input — its length, the kind of character that is
/// wrong — and never echoes it. An error message is the easiest place for a secret to escape into a
/// log, and a message quoting the value would put it there.
pub fn set_provider_key(
    keys: &dyn KeyStore,
    provider_id: &str,
    secret: &str,
) -> Result<ProviderKeyStatus> {
    let spec = provider_spec(provider_id)?;
    let trimmed = secret.trim();
    if trimmed.is_empty() {
        return Err(MisalError::Other(
            "the key field is empty; paste the key, or use Clear to remove the stored one"
                .to_string(),
        ));
    }
    if trimmed.len() > 512 {
        return Err(MisalError::Other(format!(
            "that is {} characters, which is longer than any provider key; check you pasted the \
             key and not a whole response",
            trimmed.len()
        )));
    }
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(MisalError::Other(
            "the key contains a space or a line break; provider keys do not, so something else \
             was pasted with it"
                .to_string(),
        ));
    }

    keys.store(&provider_secret_key(provider_id), trimmed)?;
    Ok(status_of(spec, keys))
}

pub fn clear_provider_key(keys: &dyn KeyStore, provider_id: &str) -> Result<ProviderKeyStatus> {
    let spec = provider_spec(provider_id)?;
    keys.clear(&provider_secret_key(provider_id))?;
    Ok(status_of(spec, keys))
}

// ---------------------------------------------------------------------------
// Manual price overrides
// ---------------------------------------------------------------------------

/// The canonical decimal grammar, matching `DEC_PATTERN` in `src/domain/numeric.ts`.
///
/// Hand-written rather than a regex crate: no exponent, no separators, no leading `+`, no leading
/// zeros. A price is never parsed to a float on the way in — the point of the whole numeric design
/// is that `1512.50` is stored as those characters.
fn is_canonical_decimal(value: &str) -> bool {
    let digits = value.strip_prefix('-').unwrap_or(value);
    let (whole, fraction) = match digits.split_once('.') {
        None => (digits, None),
        Some((whole, fraction)) => (whole, Some(fraction)),
    };
    if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    if whole.len() > 1 && whole.starts_with('0') {
        return false;
    }
    match fraction {
        None => true,
        Some(fraction) => !fraction.is_empty() && fraction.bytes().all(|b| b.is_ascii_digit()),
    }
}

/// `YYYY-MM-DD`, and a date that exists.
///
/// Two checks, both needed. 31 February is refused because it would otherwise become a row that
/// sorts between two real days and is never selected by a valuation. `2026-8-1` is refused because
/// chrono accepts it but SQLite compares `as_of` as text: an unpadded date sorts after every padded
/// one, so the override would be invisible to a "most recent price at or before this day" read.
fn validate_as_of(raw: &str) -> Result<String> {
    let value = raw.trim();
    let padded = value.len() == 10
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value
            .bytes()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit());
    if !padded || chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_err() {
        return Err(MisalError::Other(format!(
            "the date must be a real calendar day written as YYYY-MM-DD; {} is not",
            quoted(value)
        )));
    }
    Ok(value.to_string())
}

fn validate_close(raw: &str) -> Result<String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(MisalError::Other(
            "a manual price needs a value; the field is empty".to_string(),
        ));
    }
    if value.contains(',') {
        return Err(MisalError::Other(format!(
            "{} contains a comma; enter the price without grouping separators, as 152000.50",
            quoted(value)
        )));
    }
    if !is_canonical_decimal(value) {
        return Err(MisalError::Other(format!(
            "{} is not a plain decimal number; enter digits and at most one decimal point, with \
             no currency symbol and no exponent",
            quoted(value)
        )));
    }
    if value.starts_with('-') {
        return Err(MisalError::Other(format!(
            "{} is negative; a price per unit cannot be below zero",
            quoted(value)
        )));
    }
    Ok(value.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualPriceRow {
    pub instrument_id: String,
    pub instrument_name: String,
    pub asset_class: String,
    pub as_of: String,
    pub close: String,
    pub currency: String,
    pub recorded_at: String,
    /// The fetched row this override outranks for the same day, if one exists. Carried so the
    /// screen can show the value being superseded rather than implying the override is unopposed.
    pub superseded_source: Option<String>,
    pub superseded_close: Option<String>,
}

const MANUAL_PRICE_SELECT: &str = "SELECT p.instrument_id, i.display_name, i.asset_class, p.as_of,
            p.close, p.currency, p.fetched_at,
            (SELECT f.source FROM price f
              WHERE f.instrument_id = p.instrument_id AND f.as_of = p.as_of
                AND f.source <> 'manual' ORDER BY f.source LIMIT 1),
            (SELECT f.close FROM price f
              WHERE f.instrument_id = p.instrument_id AND f.as_of = p.as_of
                AND f.source <> 'manual' ORDER BY f.source LIMIT 1)
       FROM price p
       JOIN instrument i ON i.id = p.instrument_id
      WHERE p.source = 'manual'
      ORDER BY p.as_of DESC, i.display_name";

pub fn list_manual_prices(conn: &Connection) -> Result<Vec<ManualPriceRow>> {
    let mut stmt = conn.prepare(MANUAL_PRICE_SELECT)?;
    let rows = stmt.query_map([], |row| {
        Ok(ManualPriceRow {
            instrument_id: row.get(0)?,
            instrument_name: row.get(1)?,
            asset_class: row.get(2)?,
            as_of: row.get(3)?,
            close: row.get(4)?,
            currency: row.get(5)?,
            recorded_at: row.get(6)?,
            superseded_source: row.get(7)?,
            superseded_close: row.get(8)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualPriceInput {
    pub instrument_id: String,
    pub as_of: String,
    /// A canonical decimal string. Validated, never parsed to a float.
    pub close: String,
}

/// Record a manual price.
///
/// The currency is taken from the instrument rather than from the caller. A price in a currency the
/// instrument is not denominated in reads back as `PRICE_CURRENCY_MISMATCH` and makes the holding
/// unpriceable — a way to make things worse by trying to fix them, so the field does not exist.
///
/// `ON CONFLICT (instrument_id, as_of, source)` with `source` fixed at `'manual'` can only ever
/// meet another manual row, so this statement replaces the user's own earlier override and has no
/// expressible effect on a fetched one.
pub fn set_manual_price(conn: &Connection, input: &ManualPriceInput) -> Result<ManualPriceRow> {
    let as_of = validate_as_of(&input.as_of)?;
    let close = validate_close(&input.close)?;

    let currency: String = conn
        .query_row(
            "SELECT currency FROM instrument WHERE id = ?1",
            [&input.instrument_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| {
            MisalError::Other(format!(
                "no instrument {} to price; choose one from the list",
                input.instrument_id
            ))
        })?;

    conn.execute(
        "INSERT INTO price (instrument_id, as_of, close, currency, source, fetched_at)
         VALUES (?1, ?2, ?3, ?4, 'manual', ?5)
         ON CONFLICT (instrument_id, as_of, source)
         DO UPDATE SET close = excluded.close,
                       currency = excluded.currency,
                       fetched_at = excluded.fetched_at",
        rusqlite::params![input.instrument_id, as_of, close, currency, now_iso()],
    )?;

    list_manual_prices(conn)?
        .into_iter()
        .find(|row| row.instrument_id == input.instrument_id && row.as_of == as_of)
        .ok_or_else(|| MisalError::Other("the override was not stored".to_string()))
}

/// Remove one override.
///
/// Scoped to `source = 'manual'` so a mis-typed argument cannot delete a fetched price, and
/// reported as an error when it matches nothing rather than succeeding silently — a delete that
/// removed nothing looks identical to one that worked.
pub fn delete_manual_price(conn: &Connection, instrument_id: &str, as_of: &str) -> Result<()> {
    let removed = conn.execute(
        "DELETE FROM price WHERE instrument_id = ?1 AND as_of = ?2 AND source = 'manual'",
        rusqlite::params![instrument_id, as_of],
    )?;
    if removed == 0 {
        return Err(MisalError::Other(format!(
            "no manual price for that instrument on {as_of}"
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// What leaves the machine
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDestination {
    pub host: String,
    /// The only path prefix the allowlist admits on this host.
    pub path_prefix: String,
    pub purpose: String,
    /// What is in the request. The question a sceptical user is actually asking.
    pub sends: String,
    pub requires_key: bool,
}

/// What each allowlisted host is for, keyed by host.
///
/// The host list itself is `http::MARKET_DATA_HOSTS` and is not restated here — this table only
/// annotates it, and `every_allowlisted_host_is_described` fails if a host is added there without a
/// description, so the disclosure cannot silently fall behind the code that opens the socket.
const PURPOSES: &[(&str, &str, &str, bool)] = &[
    (
        "portal.amfiindia.com",
        "AMFI's official daily NAV file, for every Indian mutual fund.",
        "Nothing identifying. The whole all-schemes file is downloaded and matched locally, so the \
         request does not say which funds you hold.",
        false,
    ),
    (
        "www.amfiindia.com",
        "The same AMFI NAV file, on AMFI's alternate host.",
        "Nothing identifying. The whole all-schemes file is downloaded and matched locally, so the \
         request does not say which funds you hold.",
        false,
    ),
    (
        "query1.finance.yahoo.com",
        "Yahoo's quote endpoint — the only free source covering NSE and BSE.",
        "The exchange symbol of each instrument being priced. Not your quantities, not your \
         accounts, and no identifier of you.",
        false,
    ),
    (
        "query2.finance.yahoo.com",
        "Yahoo's second quote host, used when the first does not answer.",
        "The exchange symbol of each instrument being priced. Not your quantities, not your \
         accounts, and no identifier of you.",
        false,
    ),
    (
        "api.twelvedata.com",
        "Twelve Data quotes and FX rates, reached only if you have entered a key.",
        "The exchange symbol of each instrument being priced, and your API key. Contacted only \
         when a key is stored.",
        true,
    ),
    (
        "api.coingecko.com",
        "CoinGecko spot prices for crypto holdings.",
        "The CoinGecko id of each coin being priced. Not your balances and not your wallet or \
         exchange accounts.",
        false,
    ),
];

/// Every host Misal's price path may reach, in the order the allowlist declares them.
pub fn network_destinations() -> Vec<NetworkDestination> {
    MARKET_DATA_HOSTS
        .iter()
        .map(|(host, prefix)| {
            let annotation = PURPOSES.iter().find(|(name, _, _, _)| name == host);
            let (purpose, sends, requires_key) = match annotation {
                Some((_, purpose, sends, requires_key)) => (*purpose, *sends, *requires_key),
                // Unreachable while the test below passes. Stated rather than assumed, because a
                // silent empty string here would be a false claim about a real socket.
                None => (
                    "Not yet described in Settings.",
                    "Undescribed. Treat this host as contacted until this entry is filled in.",
                    false,
                ),
            };
            NetworkDestination {
                host: (*host).to_string(),
                path_prefix: (*prefix).to_string(),
                purpose: purpose.to_string(),
                sends: sends.to_string(),
                requires_key,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Everything the settings screen renders, in one call.
///
/// Fetched together for the same reason the portfolio is: a screen assembled from four staggered
/// responses shows a key as absent for a moment after storing it, which reads as the write having
/// failed.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub settings: Vec<SettingRow>,
    pub definitions: Vec<SettingDefinition>,
    pub providers: Vec<ProviderKeyStatus>,
    pub overrides: Vec<ManualPriceRow>,
    pub network: Vec<NetworkDestination>,
}

fn snapshot(conn: &Connection, keys: &dyn KeyStore) -> Result<SettingsSnapshot> {
    Ok(SettingsSnapshot {
        settings: read_settings(conn)?,
        definitions: definitions(),
        providers: provider_statuses(keys),
        overrides: list_manual_prices(conn)?,
        network: network_destinations(),
    })
}

#[tauri::command]
pub fn settings_snapshot(state: tauri::State<'_, AppState>) -> Result<SettingsSnapshot> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    snapshot(&conn, &Keychain)
}

#[tauri::command]
pub fn settings_write(
    state: tauri::State<'_, AppState>,
    key: String,
    value: String,
) -> Result<SettingRow> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    write_setting(&conn, &key, &value)
}

/// Store a provider key.
///
/// The secret arrives as an argument and leaves as a boolean. It is not written to the database, is
/// not returned, and is not in the response type — `ProviderKeyStatus` has no field that could
/// carry it.
#[tauri::command]
pub fn settings_set_provider_key(provider_id: String, secret: String) -> Result<ProviderKeyStatus> {
    set_provider_key(&Keychain, &provider_id, &secret)
}

#[tauri::command]
pub fn settings_clear_provider_key(provider_id: String) -> Result<ProviderKeyStatus> {
    clear_provider_key(&Keychain, &provider_id)
}

#[tauri::command]
pub fn settings_set_manual_price(
    state: tauri::State<'_, AppState>,
    input: ManualPriceInput,
) -> Result<ManualPriceRow> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    set_manual_price(&conn, &input)
}

#[tauri::command]
pub fn settings_delete_manual_price(
    state: tauri::State<'_, AppState>,
    instrument_id: String,
    as_of: String,
) -> Result<()> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    delete_manual_price(&conn, &instrument_id, &as_of)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use tempfile::TempDir;

    const TEST_KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    /// A keychain that is not the keychain, so these tests never touch the developer's.
    #[derive(Default)]
    struct MemoryKeys {
        entries: RefCell<HashMap<String, String>>,
        broken: bool,
    }

    impl KeyStore for MemoryKeys {
        fn store(&self, keychain_key: &str, secret: &str) -> Result<()> {
            self.entries
                .borrow_mut()
                .insert(keychain_key.to_string(), secret.to_string());
            Ok(())
        }
        fn present(&self, keychain_key: &str) -> Result<bool> {
            if self.broken {
                return Err(MisalError::Other(
                    "secret service is not running".to_string(),
                ));
            }
            Ok(self.entries.borrow().contains_key(keychain_key))
        }
        fn clear(&self, keychain_key: &str) -> Result<()> {
            self.entries.borrow_mut().remove(keychain_key);
            Ok(())
        }
    }

    fn open_test_db() -> (TempDir, Connection) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("t.db");
        let conn = db::open_at(&path, TEST_KEY).unwrap();
        db::migrate(&conn, &path).unwrap();
        conn.execute_batch(
            "INSERT INTO instrument (id, asset_class, display_name, currency, created_at)
               VALUES ('i-gold', 'gold', 'Sovereign gold bond 2031', 'INR', 'now'),
                      ('i-aapl', 'us_equity', 'Apple Inc', 'USD', 'now');",
        )
        .unwrap();
        (dir, conn)
    }

    fn input(instrument_id: &str, as_of: &str, close: &str) -> ManualPriceInput {
        ManualPriceInput {
            instrument_id: instrument_id.to_string(),
            as_of: as_of.to_string(),
            close: close.to_string(),
        }
    }

    // -- the property this module exists to hold -------------------------------------------------

    /// No response carries the secret, in any state.
    ///
    /// Asserted against real JSON rather than against the type declarations, because the boundary
    /// is serde's output and not the struct. Every command's response is serialised: the one that
    /// stores the key, the one that clears it, and the snapshot the screen reads on every render.
    #[test]
    fn no_settings_response_carries_the_secret() {
        let (_dir, conn) = open_test_db();
        let keys = MemoryKeys::default();
        const SENTINEL: &str = "td-sentinel-8f2c1a4e9b7d";

        let stored = set_provider_key(&keys, "twelvedata", SENTINEL).unwrap();
        assert_eq!(stored.status, "present");

        let responses = [
            serde_json::to_string(&stored).unwrap(),
            serde_json::to_string(&snapshot(&conn, &keys).unwrap()).unwrap(),
            serde_json::to_string(&clear_provider_key(&keys, "twelvedata").unwrap()).unwrap(),
        ];
        for response in &responses {
            assert!(
                !response.contains(SENTINEL),
                "a settings response carried the key: {response}"
            );
        }

        // And the database never saw it either. Both tables the screen writes are searched, not
        // just the one it was written through.
        let mut stmt = conn
            .prepare("SELECT key || '=' || value FROM setting UNION ALL SELECT close FROM price")
            .unwrap();
        let cells: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(
            !cells.iter().any(|cell| cell.contains(SENTINEL)),
            "the key reached the database"
        );
    }

    /// A rejected key is rejected without being quoted back.
    #[test]
    fn a_refused_key_is_never_echoed_in_the_error() {
        let keys = MemoryKeys::default();
        const SENTINEL: &str = "td-sentinel-with a space";
        let error = set_provider_key(&keys, "twelvedata", SENTINEL)
            .unwrap_err()
            .to_string();
        assert!(!error.contains("td-sentinel"), "the error quoted the key");
        assert!(
            error.contains("space"),
            "the error did not name the problem"
        );
    }

    #[test]
    fn presence_is_reported_without_the_value_and_survives_a_broken_keychain() {
        let keys = MemoryKeys::default();
        assert_eq!(provider_statuses(&keys)[0].status, "absent");
        set_provider_key(&keys, "twelvedata", "abc123").unwrap();
        assert_eq!(provider_statuses(&keys)[0].status, "present");
        clear_provider_key(&keys, "twelvedata").unwrap();
        assert_eq!(provider_statuses(&keys)[0].status, "absent");

        // An unreadable keychain is its own state. Reporting "absent" would tell a user their key
        // had vanished and invite them to re-enter one they already have.
        let broken = MemoryKeys {
            broken: true,
            ..MemoryKeys::default()
        };
        let status = &provider_statuses(&broken)[0];
        assert_eq!(status.status, "unavailable");
        assert!(status.detail.is_some());
    }

    #[test]
    fn a_provider_with_no_key_slot_is_refused() {
        let keys = MemoryKeys::default();
        assert!(set_provider_key(&keys, "amfi", "anything").is_err());
        assert!(clear_provider_key(&keys, "amfi").is_err());
    }

    // -- settings --------------------------------------------------------------------------------

    #[test]
    fn a_setting_write_names_the_problem_rather_than_reporting_one() {
        let (_dir, conn) = open_test_db();

        let fractional = write_setting(&conn, "price_cache_ttl_minutes", "6.5")
            .unwrap_err()
            .to_string();
        assert!(
            fractional.contains("whole number of minutes"),
            "{fractional}"
        );

        let out_of_range = write_setting(&conn, "concentration_flag_percent", "250")
            .unwrap_err()
            .to_string();
        assert!(out_of_range.contains("between 1 and 100"), "{out_of_range}");

        let currency = write_setting(&conn, "base_currency", "EUR")
            .unwrap_err()
            .to_string();
        assert!(currency.contains("must be one of INR"), "{currency}");

        let unknown = write_setting(&conn, "telemetry_enabled", "1")
            .unwrap_err()
            .to_string();
        assert!(unknown.contains("not a setting"), "{unknown}");

        // None of the four attempts moved a stored value.
        let ttl: String = conn
            .query_row(
                "SELECT value FROM setting WHERE key = 'price_cache_ttl_minutes'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ttl, "360");
    }

    /// The base currency offers INR and nothing else, and USD is refused rather than stored.
    ///
    /// The defect this guards: USD was selectable, nothing in the engine read the setting, and the
    /// FX refresh in `src/data/refresh.ts` early-returns for any base but INR. Selecting it stopped
    /// USD/INR ever being written again while the engine carried on converting at the last rate it
    /// had — net worth moving daily on refreshed prices with one factor frozen, and no warning
    /// anywhere. The setting is closed until the engine reads it.
    #[test]
    fn the_base_currency_offers_only_the_one_the_engine_actually_uses() {
        let (_dir, conn) = open_test_db();
        assert_eq!(CURRENCIES, ["INR"]);

        let definition = definitions()
            .into_iter()
            .find(|d| d.key == "base_currency")
            .expect("base_currency has a definition");
        assert_eq!(definition.choices, vec!["INR"]);

        let refused = write_setting(&conn, "base_currency", "USD")
            .unwrap_err()
            .to_string();
        assert!(refused.contains("computed in INR"), "{refused}");

        // And the stored value is untouched, so a refused choice cannot freeze the rate feed.
        let stored: String = conn
            .query_row(
                "SELECT value FROM setting WHERE key = 'base_currency'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, "INR");
    }

    #[test]
    fn a_valid_setting_is_normalised_and_stamped() {
        let (_dir, conn) = open_test_db();
        let row = write_setting(&conn, "base_currency", " inr ").unwrap();
        assert_eq!(row.value, "INR");

        let stored: (String, String) = conn
            .query_row(
                "SELECT value, updated_at FROM setting WHERE key = 'base_currency'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(stored.0, "INR");
        assert_ne!(stored.1, row.updated_at.is_empty().to_string());
        assert!(stored.1.ends_with('Z'));
    }

    #[test]
    fn every_seeded_setting_has_a_definition_and_every_definition_a_row() {
        let (_dir, conn) = open_test_db();
        let stored = read_settings(&conn).unwrap();
        for definition in definitions() {
            let row = stored.iter().find(|row| row.key == definition.key);
            assert!(row.is_some(), "{} has no seeded row", definition.key);
            // The seeded value has to survive its own validator, or the screen opens invalid.
            assert!(
                validate_setting(definition.key, &row.unwrap().value).is_ok(),
                "the seeded value for {} is rejected by its own rule",
                definition.key
            );
        }
    }

    // -- manual prices ---------------------------------------------------------------------------

    /// The whole reason `price` is keyed by source.
    #[test]
    fn a_manual_price_coexists_with_the_fetched_one_and_outranks_it() {
        let (_dir, conn) = open_test_db();
        conn.execute(
            "INSERT INTO price (instrument_id, as_of, close, currency, source, fetched_at)
             VALUES ('i-aapl', '2026-08-12', '221.10', 'USD', 'twelvedata', 'now')",
            [],
        )
        .unwrap();

        let row = set_manual_price(&conn, &input("i-aapl", "2026-08-12", "230.55")).unwrap();
        assert_eq!(row.close, "230.55");
        assert_eq!(
            row.currency, "USD",
            "the currency did not come from the instrument"
        );
        assert_eq!(row.superseded_source.as_deref(), Some("twelvedata"));
        assert_eq!(row.superseded_close.as_deref(), Some("221.10"));

        let count: i64 = conn
            .query_row("SELECT count(*) FROM price", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2, "the override destroyed the fetched value");
    }

    /// A refresh writing the same day cannot touch the override.
    ///
    /// The guard is structural: every fetched write carries its own source, so the conflict target
    /// never matches the manual row. Asserted against the statement the price service actually
    /// issues rather than trusting the primary key by inspection.
    #[test]
    fn a_later_fetch_cannot_overwrite_a_manual_price() {
        let (_dir, conn) = open_test_db();
        set_manual_price(&conn, &input("i-gold", "2026-08-12", "7412.00")).unwrap();

        conn.execute(
            "INSERT INTO price (instrument_id, as_of, close, currency, source, fetched_at)
             VALUES ('i-gold', '2026-08-12', '1.00', 'INR', 'yahoo', 'now')
             ON CONFLICT (instrument_id, as_of, source)
             DO UPDATE SET close = excluded.close",
            [],
        )
        .unwrap();

        let manual: String = conn
            .query_row(
                "SELECT close FROM price WHERE instrument_id = 'i-gold' AND source = 'manual'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(manual, "7412.00", "a fetch overwrote a manual override");
    }

    #[test]
    fn re_entering_an_override_replaces_the_users_own_earlier_one() {
        let (_dir, conn) = open_test_db();
        set_manual_price(&conn, &input("i-gold", "2026-08-12", "7412.00")).unwrap();
        set_manual_price(&conn, &input("i-gold", "2026-08-12", "7500.25")).unwrap();

        let rows = list_manual_prices(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].close, "7500.25");
    }

    #[test]
    fn a_malformed_price_is_refused_with_the_reason() {
        let (_dir, conn) = open_test_db();
        let cases = [
            ("1,250.50", "comma"),
            ("₹1250.50", "plain decimal"),
            ("1.2e3", "plain decimal"),
            ("-5.00", "negative"),
            ("", "empty"),
        ];
        for (raw, expected) in cases {
            let error = set_manual_price(&conn, &input("i-gold", "2026-08-12", raw))
                .unwrap_err()
                .to_string();
            assert!(
                error.contains(expected),
                "{raw:?} was rejected as {error:?}, which does not name the problem"
            );
        }
        assert!(list_manual_prices(&conn).unwrap().is_empty());
    }

    #[test]
    fn a_price_keeps_its_trailing_zeros_and_its_full_precision() {
        // Through an f64 the eighteenth decimal is gone before it reaches SQLite; through a string
        // it is not. Trailing zeros are significant to the display precision and are preserved.
        let (_dir, conn) = open_test_db();
        let exact = "0.000000000000000001";
        set_manual_price(&conn, &input("i-gold", "2026-08-12", exact)).unwrap();
        set_manual_price(&conn, &input("i-gold", "2026-08-11", "1500.5000")).unwrap();

        let rows = list_manual_prices(&conn).unwrap();
        assert_eq!(rows[0].close, exact);
        assert_eq!(rows[1].close, "1500.5000");
    }

    #[test]
    fn an_impossible_date_is_refused() {
        let (_dir, conn) = open_test_db();
        for raw in ["2026-02-31", "12/08/2026", "2026-8-1", "yesterday"] {
            assert!(
                set_manual_price(&conn, &input("i-gold", raw, "10.00")).is_err(),
                "{raw} was accepted as a date"
            );
        }
    }

    #[test]
    fn an_unknown_instrument_is_refused_rather_than_creating_an_orphan_price() {
        let (_dir, conn) = open_test_db();
        assert!(set_manual_price(&conn, &input("i-nope", "2026-08-12", "10.00")).is_err());
        assert_eq!(list_manual_prices(&conn).unwrap().len(), 0);
    }

    #[test]
    fn removing_an_override_leaves_the_fetched_price_alone() {
        let (_dir, conn) = open_test_db();
        conn.execute(
            "INSERT INTO price (instrument_id, as_of, close, currency, source, fetched_at)
             VALUES ('i-aapl', '2026-08-12', '221.10', 'USD', 'twelvedata', 'now')",
            [],
        )
        .unwrap();
        set_manual_price(&conn, &input("i-aapl", "2026-08-12", "230.55")).unwrap();

        delete_manual_price(&conn, "i-aapl", "2026-08-12").unwrap();
        assert!(list_manual_prices(&conn).unwrap().is_empty());

        let left: String = conn
            .query_row("SELECT source FROM price", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            left, "twelvedata",
            "removing the override removed the quote"
        );

        // A second removal changed nothing, so it reports that rather than succeeding.
        assert!(delete_manual_price(&conn, "i-aapl", "2026-08-12").is_err());
    }

    // -- what leaves the machine -----------------------------------------------------------------

    /// The disclosure is generated from the allowlist, and this is what keeps it honest.
    #[test]
    fn every_allowlisted_host_is_described() {
        let destinations = network_destinations();
        assert_eq!(destinations.len(), MARKET_DATA_HOSTS.len());
        for destination in &destinations {
            assert!(
                !destination.purpose.contains("Not yet described"),
                "{} is contacted but not described in Settings",
                destination.host
            );
            assert!(!destination.sends.is_empty());
        }
        // And nothing is described that is not on the list, which would be a claim about a socket
        // that does not exist.
        for (host, _, _, _) in PURPOSES {
            assert!(
                MARKET_DATA_HOSTS.iter().any(|(allowed, _)| allowed == host),
                "{host} is described in Settings but is not on the allowlist"
            );
        }
    }

    #[test]
    fn twelve_data_is_the_only_destination_marked_as_needing_a_key() {
        let keyed: Vec<_> = network_destinations()
            .into_iter()
            .filter(|d| d.requires_key)
            .map(|d| d.host)
            .collect();
        assert_eq!(keyed, vec!["api.twelvedata.com".to_string()]);
    }

    #[test]
    fn the_path_prefix_shown_is_the_one_the_allowlist_enforces() {
        let destinations = network_destinations();
        for (host, prefix) in MARKET_DATA_HOSTS {
            let shown = destinations.iter().find(|d| d.host == *host).unwrap();
            assert_eq!(&shown.path_prefix, prefix);
        }
    }

    #[test]
    fn canonical_decimals_are_recognised_exactly_as_the_typescript_grammar_does() {
        for good in [
            "0",
            "1",
            "1500.5000",
            "-3",
            "0.5",
            "999999999999999999999.1",
        ] {
            assert!(is_canonical_decimal(good), "{good} was refused");
        }
        for bad in [
            "", "01", "1.", ".5", "1e3", "+1", "1,000", "1.2.3", " 1", "abc",
        ] {
            assert!(!is_canonical_decimal(bad), "{bad} was accepted");
        }
    }
}
