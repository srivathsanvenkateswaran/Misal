//! The live exchange sync: the wiring between the adapters and the socket.
//!
//! `exchange_guard` decides whether a request may be made and signs it; `http::ReqwestTransport`
//! sends it. Neither is reachable from the frontend on its own, and this module is the only thing
//! that joins them. It owns three responsibilities and deliberately no judgement:
//!
//!   * **Credentials.** Staging is memory-only; `exchange_commit_credential` is the sole path to
//!     the OS keychain. That is what makes "an over-scoped key is refused before the secret is
//!     stored" a structural property rather than a promise - the connect flow probes with a staged
//!     handle, and a refusal simply never calls commit. Asserted below by looking at what was
//!     written, not by trusting a return value.
//!
//!   * **The transport.** Every outbound exchange request passes `Session::authorise` here, in the
//!     process that owns the socket and the secret. The frontend's own allowlist is ignored: the
//!     canonical list lives below, in Rust, so a compromised or buggy webview cannot widen it.
//!     Neither can it choose a host - `hostUrl` from the caller is discarded and the URL is looked
//!     up from the adapter's own table, because a signed request carries the user's API key and
//!     must not be aimable at an arbitrary origin. Nor can it choose *which* key: the account id
//!     and the adapter id arrive in the same object, so the pairing is re-derived from
//!     `account.provider_id` before a stored credential is read. Pinning the origin without
//!     pinning the credential would only decide which third party receives the secret.
//!
//!   * **The store.** One command per `SyncStore` method in `src/adapters/sync/store.ts`, mapped
//!     mechanically, following `ingest.rs`: money and quantities cross as strings in both
//!     directions, and anything that must be atomic is one command holding one SQLite
//!     transaction. Balances are all-or-nothing for an `as_of`; a page of fills is its own
//!     transaction, because a partial trade history is merely incomplete and resumable while a
//!     partial balance set is wrong and looks complete.

use crate::error::{MisalError, Result};
use crate::exchange_guard::{
    AllowedRequest, Method, OutboundRequest, Secret, Session, SignedRequest, SigningScheme,
    Transport,
};
use crate::http::ReqwestTransport;
use crate::secrets;
use crate::AppState;
use chrono::SecondsFormat;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;

// ---------------------------------------------------------------------------
// Adapter specifications
// ---------------------------------------------------------------------------

/// Which of an adapter's declared hosts a request goes to.
///
/// Named rather than supplied as a URL, so an adapter - or anything impersonating one - cannot
/// point a signed request at an origin of its choosing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HostKey {
    Primary,
    /// The unauthenticated market-data host, where the exchange has one.
    Public,
}

struct Endpoint {
    method: Method,
    path: &'static str,
    host: HostKey,
}

/// Everything the core will let one adapter do.
///
/// The mirror of `src/adapters/<exchange>/allowlist.ts`. Duplicated on purpose: the TypeScript
/// copy gives a contributor a stack trace pointing at their adapter, and this copy is the one that
/// counts, because it is the one the frontend cannot edit.
struct AdapterSpec {
    id: &'static str,
    primary: &'static str,
    public: &'static str,
    endpoints: &'static [Endpoint],
    /// The one signed scheme this exchange uses. A Binance request signed CoinDCX-style would put
    /// the secret's HMAC somewhere the caller chose, so the pairing is fixed here rather than
    /// taken from the request.
    signing: SigningScheme,
}

const BINANCE: AdapterSpec = AdapterSpec {
    id: "binance",
    primary: "https://api.binance.com",
    // Public market data only, so exchangeInfo's weight stays off the authenticated IP budget.
    public: "https://data-api.binance.vision",
    signing: SigningScheme::BinanceQuery,
    endpoints: &[
        Endpoint {
            method: Method::Get,
            path: "/api/v3/time",
            host: HostKey::Primary,
        },
        Endpoint {
            method: Method::Get,
            path: "/api/v3/exchangeInfo",
            host: HostKey::Public,
        },
        // Read for `permissions` and `uid` only. Its canTrade/canWithdraw describe the ACCOUNT,
        // not the key, and are never used for a scope decision.
        Endpoint {
            method: Method::Get,
            path: "/api/v3/account",
            host: HostKey::Primary,
        },
        Endpoint {
            method: Method::Get,
            path: "/api/v3/myTrades",
            host: HostKey::Primary,
        },
        // The authoritative scope report for the key itself.
        Endpoint {
            method: Method::Get,
            path: "/sapi/v1/account/apiRestrictions",
            host: HostKey::Primary,
        },
        Endpoint {
            method: Method::Get,
            path: "/sapi/v1/capital/deposit/hisrec",
            host: HostKey::Primary,
        },
        Endpoint {
            method: Method::Get,
            path: "/sapi/v1/capital/withdraw/history",
            host: HostKey::Primary,
        },
        // Convert history. The only place Binance Convert fills appear at all - they are in no
        // trade history - so without it an account bought entirely through Convert reads as units
        // with no purchase behind them. Its mutating siblings /convert/getQuote and
        // /convert/acceptQuote are refused by the path classifier, not merely left off this list.
        Endpoint {
            method: Method::Get,
            path: "/sapi/v1/convert/tradeFlow",
            host: HostKey::Primary,
        },
        // Read-only despite the verb.
        Endpoint {
            method: Method::Post,
            path: "/sapi/v3/asset/getUserAsset",
            host: HostKey::Primary,
        },
    ],
};

const COINDCX: AdapterSpec = AdapterSpec {
    id: "coindcx",
    primary: "https://api.coindcx.com",
    public: "https://public.coindcx.com",
    signing: SigningScheme::CoindcxBody,
    endpoints: &[
        Endpoint {
            method: Method::Get,
            path: "/exchange/v1/markets_details",
            host: HostKey::Primary,
        },
        // Authenticated reads are POSTs because the signature covers the body. A POST here is not
        // a mutation; the guard judges the path, which is the part that names the action.
        Endpoint {
            method: Method::Post,
            path: "/exchange/v1/users/balances",
            host: HostKey::Primary,
        },
        Endpoint {
            method: Method::Post,
            path: "/exchange/v1/orders/trade_history",
            host: HostKey::Primary,
        },
    ],
};

const ADAPTERS: &[&AdapterSpec] = &[&BINANCE, &COINDCX];

fn spec_for(adapter_id: &str) -> Result<&'static AdapterSpec> {
    ADAPTERS
        .iter()
        .copied()
        .find(|spec| spec.id == adapter_id)
        .ok_or_else(|| refused(adapter_id, "no such adapter"))
}

impl AdapterSpec {
    fn allowlist(&self) -> Vec<AllowedRequest> {
        self.endpoints
            .iter()
            .map(|e| AllowedRequest {
                method: e.method,
                path_pattern: e.path.to_string(),
            })
            .collect()
    }

    fn host_url(&self, host: HostKey) -> &'static str {
        match host {
            HostKey::Primary => self.primary,
            HostKey::Public => self.public,
        }
    }

    /// Is this exact method, path and host one of the declared endpoints?
    ///
    /// Exact rather than pattern matching, and stricter than `Session` on purpose: neither v1
    /// adapter needs a wildcard, and a path that cannot be enumerated cannot be reviewed. Both
    /// checks run; this one adds the host, which the guard's allowlist has no field for.
    fn permits(&self, method: Method, path: &str, host: HostKey) -> bool {
        self.endpoints
            .iter()
            .any(|e| e.method == method && e.path == path && e.host == host)
    }
}

fn refused(adapter: &str, reason: &str) -> MisalError {
    MisalError::Other(format!("{adapter} refused the request: {reason}"))
}

// ---------------------------------------------------------------------------
// Account ownership
// ---------------------------------------------------------------------------

/// Which exchange this account belongs to, as the database records it, or `None` if it does not
/// exist yet.
///
/// `account.provider_id` holds exactly the `AdapterSpec::id` string, written by
/// `commit_credential` and by nothing else, which is what makes it comparable to the adapter id a
/// request names.
fn account_provider(conn: &Connection, account_id: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT provider_id FROM account WHERE id = ?1",
            [account_id],
            |row| row.get(0),
        )
        .optional()?)
}

/// Refuse an account that does not belong to the adapter the caller named.
///
/// The adapter id and the account id arrive in one object and nothing in the wire format makes
/// them agree. Pinning the origin is only half of it: a request aimed at `api.binance.com` while
/// carrying the CoinDCX account's key would put a trade-and-withdrawal credential - CoinDCX issues
/// no read-only ones - into a third party's request log, having passed every other check here. So
/// the pairing is re-derived from the `account` table rather than trusted, exactly as the host,
/// the method, the path and the signing scheme already are.
///
/// The mismatch is named in the error rather than being allowed to look like an absent row,
/// because "no credential is stored" would send a contributor looking at the wrong thing.
fn require_account_provider(conn: &Connection, account_id: &str, adapter_id: &str) -> Result<()> {
    match account_provider(conn, account_id)? {
        Some(provider) if provider == adapter_id => Ok(()),
        Some(provider) => Err(refused(
            adapter_id,
            &format!("account {account_id} belongs to {provider}, not {adapter_id}"),
        )),
        None => Err(refused(
            adapter_id,
            &format!("there is no account {account_id}"),
        )),
    }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/// Key material held in memory and overwritten when it goes out of scope.
///
/// Volatile writes, so the compiler cannot elide an overwrite of a buffer that is about to be
/// freed and never read again. No `Debug` or `Display`, so it cannot reach a log line by accident.
struct Zeroising(Vec<u8>);

impl Zeroising {
    fn new(value: &str) -> Self {
        Self(value.as_bytes().to_vec())
    }

    fn to_text(&self) -> String {
        String::from_utf8_lossy(&self.0).into_owned()
    }

    fn to_secret(&self) -> Secret {
        Secret::new(self.0.clone())
    }
}

impl Drop for Zeroising {
    fn drop(&mut self) {
        for byte in self.0.iter_mut() {
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
        std::sync::atomic::fence(std::sync::atomic::Ordering::SeqCst);
    }
}

struct StagedCredential {
    api_key: Zeroising,
    api_secret: Zeroising,
}

/// Credentials that exist only for the duration of a connect probe.
///
/// The connect flow has to authenticate before the scope check has decided whether the secret may
/// be written to the keychain at all. Staging is how it does that without a disk write: a handle
/// signs on the credential's behalf, and `commit` is the only thing that ever reaches the OS
/// keychain.
#[derive(Default)]
pub struct ExchangeState {
    staged: Mutex<HashMap<String, StagedCredential>>,
}

impl ExchangeState {
    pub fn new() -> Self {
        Self::default()
    }

    fn stage(&self, api_key: &str, api_secret: &str) -> String {
        let handle = uuid::Uuid::new_v4().to_string();
        let mut staged = self.staged.lock().expect("staging mutex poisoned");
        staged.insert(
            handle.clone(),
            StagedCredential {
                api_key: Zeroising::new(api_key),
                api_secret: Zeroising::new(api_secret),
            },
        );
        handle
    }

    fn take(&self, handle: &str) -> Option<StagedCredential> {
        self.staged
            .lock()
            .expect("staging mutex poisoned")
            .remove(handle)
    }

    fn with<T>(&self, handle: &str, f: impl FnOnce(&StagedCredential) -> T) -> Option<T> {
        self.staged
            .lock()
            .expect("staging mutex poisoned")
            .get(handle)
            .map(f)
    }

    #[cfg(test)]
    fn staged_count(&self) -> usize {
        self.staged.lock().expect("staging mutex poisoned").len()
    }
}

/// What the keychain entry holds.
///
/// The API key is stored beside the secret rather than in the database: it is a public identifier
/// only in the sense that the exchange knows it, and anyone who obtains it learns which account
/// this is. Nothing exchange-related is written to SQLite except the `credential_ref` row.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialBlob {
    api_key: String,
    api_secret: String,
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn json_error(what: &str, error: impl std::fmt::Display) -> MisalError {
    MisalError::Other(format!("{what}: {error}"))
}

/// Write the credential to the keychain and record the account and the reference that names it.
///
/// The database rows are staged first and the keychain written inside the same window, so a
/// failure on either side leaves neither: a rollback drops the rows, and a failed commit deletes
/// the secret. An orphaned keychain entry is a quiet security failure rather than a visible bug,
/// which is exactly the kind worth spending an extra branch on.
pub fn commit_credential(
    conn: &mut Connection,
    state: &ExchangeState,
    handle: &str,
    account: &AccountIdentity,
) -> Result<()> {
    let staged = state
        .take(handle)
        .ok_or_else(|| MisalError::Other(format!("no staged credential {handle}")))?;
    spec_for(&account.provider_id)?;

    // An account that already exists under another exchange is never re-pointed at this one. The
    // upsert below leaves `provider_id` alone, so the row would keep its old exchange while
    // `credential_ref` gained this key: the same credential confusion the transport guards
    // against, arriving through the connect flow instead.
    if let Some(existing) = account_provider(conn, &account.id)? {
        if existing != account.provider_id {
            return Err(refused(
                &account.provider_id,
                &format!("account {} already belongs to {existing}", account.id),
            ));
        }
    }

    let blob = serde_json::to_string(&CredentialBlob {
        api_key: staged.api_key.to_text(),
        api_secret: staged.api_secret.to_text(),
    })
    .map_err(|e| json_error("could not encode the credential", e))?;
    let keychain_key = secrets::account_secret_key(&account.id);

    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO account (id, provider_id, label, capability, base_currency, created_at)
         VALUES (?1, ?2, ?3, 'snapshot', ?4, ?5)
         ON CONFLICT (id) DO UPDATE SET label = excluded.label",
        rusqlite::params![
            account.id,
            account.provider_id,
            account.label,
            account.base_currency,
            now_iso(),
        ],
    )?;
    tx.execute(
        "INSERT INTO credential_ref (account_id, keychain_key, kind, created_at)
         VALUES (?1, ?2, 'api-key-secret', ?3)
         ON CONFLICT (account_id) DO UPDATE SET keychain_key = excluded.keychain_key",
        rusqlite::params![account.id, keychain_key, now_iso()],
    )?;

    secrets::store_secret(&keychain_key, &blob)?;
    if let Err(error) = tx.commit() {
        let _ = secrets::delete_secret(&keychain_key);
        return Err(error.into());
    }
    Ok(())
}

/// The api key and secret to sign this request with, or empty values for an unsigned one.
///
/// Read for the duration of one signing operation and no longer. A public endpoint never touches
/// the keychain at all.
///
/// The stored credential is looked up by account **and** by exchange. A staged handle is exempt
/// because it is not borrowed from anywhere: it is the credential the caller just supplied, in a
/// connect flow whose account row does not exist yet.
fn credential_for(
    conn: &Connection,
    state: &ExchangeState,
    request: &ExchangeRequest,
) -> Result<(String, Secret)> {
    if request.signing == SigningScheme::None {
        return Ok((String::new(), Secret::new(Vec::new())));
    }

    if let Some(handle) = &request.credential_handle {
        return state
            .with(handle, |staged| {
                (staged.api_key.to_text(), staged.api_secret.to_secret())
            })
            .ok_or_else(|| MisalError::Other(format!("no staged credential {handle}")));
    }

    require_account_provider(conn, &request.account_id, &request.adapter_id)?;

    // Joined rather than filtered afterwards, so the account's exchange is part of what selects
    // the row: there is no order of statements here in which the key is read first and checked
    // second.
    let keychain_key: String = conn
        .query_row(
            "SELECT c.keychain_key
               FROM credential_ref c
               JOIN account a ON a.id = c.account_id
              WHERE c.account_id = ?1 AND a.provider_id = ?2",
            rusqlite::params![&request.account_id, &request.adapter_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| {
            MisalError::Other(format!(
                "no credential is stored for account {}",
                request.account_id
            ))
        })?;

    let raw = secrets::read_secret(&keychain_key)?.ok_or_else(|| {
        MisalError::Other(format!(
            "the keychain entry for account {} is missing",
            request.account_id
        ))
    })?;
    let blob: CredentialBlob = serde_json::from_str(&raw)
        .map_err(|e| json_error("the stored credential is unreadable", e))?;
    Ok((blob.api_key, Secret::new(blob.api_secret.into_bytes())))
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

/// A request as the adapter expressed it.
///
/// `query` and `body` arrive already serialised, as strings, and are signed and transmitted
/// unchanged. The caller also sends its own allowlist and host URL; both are **ignored** in favour
/// of the tables above. Trusting them would make the guard advisory.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeRequest {
    pub adapter_id: String,
    pub account_id: String,
    pub host: HostKey,
    pub method: Method,
    pub path: String,
    pub query: String,
    pub body: Option<String>,
    pub signing: SigningScheme,
    /// Explicit and browser-like. CoinDCX's edge answers a default library agent with a non-JSON
    /// 403 that reads exactly like an auth failure.
    pub user_agent: String,
    /// Sign with a staged, memory-only credential rather than the account's stored one. Present
    /// only during the connect probe.
    pub credential_handle: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    /// Raw text, never parsed here. CoinDCX returns JSON floats that a parser would round before
    /// the adapter ever saw them.
    pub text: String,
}

/// Authorise, then sign. There is no path to a signed request that skips either check.
fn prepare(
    conn: &Connection,
    state: &ExchangeState,
    request: &ExchangeRequest,
) -> Result<SignedRequest> {
    let spec = spec_for(&request.adapter_id)?;

    if request.signing != SigningScheme::None && request.signing != spec.signing {
        return Err(refused(
            spec.id,
            "that signing scheme does not belong to this exchange",
        ));
    }
    if !spec.permits(request.method, &request.path, request.host) {
        return Err(refused(
            spec.id,
            &format!(
                "{} {} is not a declared endpoint on this host",
                request.method, request.path
            ),
        ));
    }

    let session = Session::new(spec.id, spec.allowlist())
        .map_err(|error| MisalError::Other(error.to_string()))?;
    let (api_key, secret) = credential_for(conn, state, request)?;

    session
        .prepare(
            OutboundRequest {
                method: request.method,
                base_url: spec.host_url(request.host).to_string(),
                path: request.path.clone(),
                query: request.query.clone(),
                body: request.body.clone(),
                signing: request.signing,
                api_key,
                user_agent: request.user_agent.clone(),
            },
            &secret,
        )
        .map_err(|error| MisalError::Other(error.to_string()))
}

/// Sign and send one exchange request.
///
/// The database lock is released before the socket opens: a sync makes hundreds of requests and
/// holding the connection across each would block every read the UI makes while one is in flight.
#[tauri::command]
pub async fn exchange_send(
    state: tauri::State<'_, AppState>,
    exchange: tauri::State<'_, ExchangeState>,
    request: ExchangeRequest,
) -> Result<ExchangeResponse> {
    let signed = {
        let conn = state.conn.lock().expect("storage mutex poisoned");
        prepare(&conn, &exchange, &request)?
    };

    // Blocking client on the blocking pool, so a slow or hung exchange cannot stall the UI.
    tauri::async_runtime::spawn_blocking(move || {
        let transport = ReqwestTransport::new()?;
        let response = transport.send(&signed).map_err(MisalError::Other)?;
        Ok(ExchangeResponse {
            status: response.status,
            headers: response.headers.into_iter().collect(),
            text: response.text,
        })
    })
    .await
    .map_err(|e| MisalError::Other(format!("exchange request task failed: {e}")))?
}

// ---------------------------------------------------------------------------
// Row shapes - one per interface in src/adapters/sync/store.ts
// ---------------------------------------------------------------------------

/// Enough to create the account a credential belongs to, on first connect.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdentity {
    pub id: String,
    pub provider_id: String,
    pub label: String,
    pub base_currency: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDescriptor {
    pub provider_id: String,
    pub account_id: String,
    pub kind: String,
    pub content_hash: String,
    pub page_ref: String,
    pub period_start: Option<String>,
    pub period_end: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRef {
    pub id: String,
    /// True when this content hash was already stored. A repeated fetch is not an error; it is
    /// idempotency working, so the existing id is reused rather than raising.
    pub existed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCounts {
    pub rows_read: i64,
    pub rows_committed: i64,
    pub rows_duplicate: i64,
    pub rows_failed: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueRow {
    pub severity: String,
    pub code: String,
    pub message: String,
    pub row_ref: Option<String>,
    pub raw_payload: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionRow {
    pub instrument_id: String,
    pub quantity: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxnRow {
    pub account_id: String,
    pub instrument_id: String,
    #[serde(rename = "type")]
    pub txn_type: String,
    pub occurred_at: String,
    /// Always null for exchange data: exchanges report epoch UTC and there is no original zone.
    pub occurred_tz: Option<String>,
    pub quantity: String,
    pub price: Option<String>,
    /// Minor units as a string, or null for a crypto-quoted trade. Parsed to i64; never a float.
    pub amount_minor: Option<String>,
    pub other_fees_minor: String,
    /// 'INR' for a fiat-quoted trade; 'X:USDT' for a crypto-quoted one.
    pub currency: String,
    pub source_document_id: String,
    pub natural_key: String,
    pub occurrence: i64,
    /// The exchange's trade id. It has no column: it is an input to the natural key, and storing
    /// it again would invite a second, competing notion of transaction identity.
    #[allow(dead_code)]
    pub external_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitCounts {
    pub committed: i64,
    pub duplicate: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuantityRow {
    pub instrument_id: String,
    pub quantity: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentSpec {
    pub asset_class: String,
    pub display_name: String,
    pub currency: String,
    pub precision: i64,
    pub tax_regime: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedRecord {
    pub account_id: String,
    pub source_document_id: String,
    pub raw_identifier: String,
    pub raw_name: Option<String>,
    pub asset_class_hint: Option<String>,
    pub observed_quantity: Option<String>,
}

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

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

// ---------------------------------------------------------------------------
// Documents, runs and issues
// ---------------------------------------------------------------------------

/// Record the page a sync just fetched, or recognise one already stored.
///
/// The descriptor names both an account and a provider, which is the same pairing `credential_for`
/// checks and the same one nothing in the wire format enforces. An unchecked pair would attribute
/// a Binance page to a CoinDCX account: `start_run` reads the provider back off this row to stamp
/// the run's parser version, and every transaction committed under it would cite a document whose
/// provenance is a fiction.
pub fn upsert_document(conn: &Connection, descriptor: &DocumentDescriptor) -> Result<DocumentRef> {
    if descriptor.kind != "api-response" {
        return Err(MisalError::Other(format!(
            "an exchange sync writes api-response documents, not {}",
            descriptor.kind
        )));
    }
    require_account_provider(conn, &descriptor.account_id, &descriptor.provider_id)?;

    if let Some(id) = conn
        .query_row(
            "SELECT id FROM source_document WHERE content_hash = ?1",
            [&descriptor.content_hash],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(DocumentRef { id, existed: true });
    }

    let id = new_id();
    conn.execute(
        "INSERT INTO source_document (id, account_id, provider_id, kind, content_hash,
            period_start, period_end, imported_at, page_ref)
         VALUES (?1, ?2, ?3, 'api-response', ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            id,
            descriptor.account_id,
            descriptor.provider_id,
            descriptor.content_hash,
            descriptor.period_start,
            descriptor.period_end,
            now_iso(),
            descriptor.page_ref,
        ],
    )?;
    Ok(DocumentRef { id, existed: false })
}

pub fn start_run(conn: &Connection, document_id: &str) -> Result<String> {
    let provider: String = conn.query_row(
        "SELECT provider_id FROM source_document WHERE id = ?1",
        [document_id],
        |row| row.get(0),
    )?;
    let id = new_id();
    conn.execute(
        "INSERT INTO import_run (id, source_document_id, started_at, status, parser_version)
         VALUES (?1, ?2, ?3, 'running', ?4)",
        rusqlite::params![id, document_id, now_iso(), format!("{provider}-adapter")],
    )?;
    Ok(id)
}

pub fn finish_run(conn: &Connection, run_id: &str, status: &str, counts: &RunCounts) -> Result<()> {
    // A partial import is a completed import: 'completed' with a non-zero rows_failed and an
    // issue per failed unit. 'failed' is reserved for a run that committed nothing.
    if status != "completed" && status != "failed" {
        return Err(MisalError::Other(format!("unknown run status: {status}")));
    }
    conn.execute(
        "UPDATE import_run
            SET finished_at = ?2, status = ?3, rows_read = ?4, rows_committed = ?5,
                rows_duplicate = ?6, rows_failed = ?7
          WHERE id = ?1",
        rusqlite::params![
            run_id,
            now_iso(),
            status,
            counts.rows_read,
            counts.rows_committed,
            counts.rows_duplicate,
            counts.rows_failed,
        ],
    )?;
    Ok(())
}

pub fn record_issue(conn: &Connection, run_id: &str, issue: &IssueRow) -> Result<()> {
    conn.execute(
        "INSERT INTO import_issue (id, import_run_id, row_ref, severity, code, message,
            raw_payload, resolution)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open')",
        rusqlite::params![
            new_id(),
            run_id,
            issue.row_ref,
            issue.severity,
            issue.code,
            issue.message,
            issue.raw_payload,
        ],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/// Write the whole balance set for one `as_of`, or none of it.
///
/// A partially written balance set is not incomplete, it is *wrong*: it understates net worth
/// while looking complete. If anything here fails, the transaction drops and the previous day's
/// positions stand, visibly stale, which is the honest outcome.
///
/// Assets the exchange no longer reports are removed for that date rather than left behind, so a
/// holding sold this morning does not linger in today's figures. Scoped to one account, which for
/// an exchange account is fed by this sync and nothing else.
pub fn commit_positions(
    conn: &mut Connection,
    account_id: &str,
    as_of: &str,
    rows: &[PositionRow],
    document_id: &str,
) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM position WHERE account_id = ?1 AND as_of = ?2",
        rusqlite::params![account_id, as_of],
    )?;
    for row in rows {
        tx.execute(
            "INSERT INTO position (id, account_id, instrument_id, quantity, as_of,
                source_document_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                new_id(),
                account_id,
                row.instrument_id,
                row.quantity,
                as_of,
                document_id,
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Commit one page of fills.
///
/// One transaction per page, because a partial trade history is merely incomplete and is
/// resumable, while the watermark that follows it must never advance past data that did not land.
/// A row already present under `(natural_key, occurrence)` is a duplicate rather than an error:
/// that is the same trade, whether it arrived from a re-fetched page or from a CSV import.
pub fn commit_transactions(conn: &mut Connection, rows: &[TxnRow]) -> Result<CommitCounts> {
    let tx = conn.transaction()?;
    let mut committed = 0i64;

    for row in rows {
        let changed = tx.execute(
            "INSERT INTO txn (id, account_id, instrument_id, type, occurred_at, occurred_tz,
                quantity, price, amount_minor, other_fees_minor, currency, source_document_id,
                natural_key, occurrence, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT (natural_key, occurrence) DO NOTHING",
            rusqlite::params![
                new_id(),
                row.account_id,
                row.instrument_id,
                row.txn_type,
                row.occurred_at,
                row.occurred_tz,
                row.quantity,
                row.price,
                minor_opt(row.amount_minor.as_ref())?,
                minor(&row.other_fees_minor)?,
                row.currency,
                row.source_document_id,
                row.natural_key,
                row.occurrence,
                now_iso(),
            ],
        )?;
        committed += i64::from(changed > 0);
    }

    tx.commit()?;
    Ok(CommitCounts {
        committed,
        duplicate: i64::try_from(rows.len()).unwrap_or(i64::MAX) - committed,
    })
}

/// Every transaction quantity for an account, for the coverage check.
///
/// Returned unsummed. The fold happens in TypeScript, where the decimal library lives: an
/// eighteen-decimal quantity added up in SQL would go through SQLite's REAL, which is a float64,
/// and the whole numeric design exists to stop exactly that.
pub fn transaction_quantities(conn: &Connection, account_id: &str) -> Result<Vec<QuantityRow>> {
    let mut stmt = conn.prepare(
        "SELECT instrument_id, quantity FROM txn WHERE account_id = ?1 ORDER BY occurred_at, id",
    )?;
    let rows = stmt.query_map([account_id], |row| {
        Ok(QuantityRow {
            instrument_id: row.get(0)?,
            quantity: row.get(1)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

// ---------------------------------------------------------------------------
// Sync state
// ---------------------------------------------------------------------------

pub fn read_cursor(
    conn: &Connection,
    account_id: &str,
    stream: &str,
    scope: &str,
) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT cursor FROM sync_state
              WHERE account_id = ?1 AND stream = ?2 AND scope = ?3",
            rusqlite::params![account_id, stream, scope],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

/// Advance the watermark.
///
/// Called only after the transaction that committed its page has succeeded. A crash in between
/// costs one re-fetched page, which the natural key makes a no-op; the reverse ordering loses a
/// page forever, silently.
pub fn write_cursor(
    conn: &Connection,
    account_id: &str,
    stream: &str,
    scope: &str,
    cursor: Option<&str>,
    last_synced_at: &str,
    coverage_note: Option<&str>,
) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_state (account_id, stream, scope, cursor, last_synced_at, coverage_note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (account_id, stream, scope) DO UPDATE
           SET cursor = excluded.cursor,
               last_synced_at = excluded.last_synced_at,
               coverage_note = excluded.coverage_note",
        rusqlite::params![
            account_id,
            stream,
            scope,
            cursor,
            last_synced_at,
            coverage_note
        ],
    )?;
    Ok(())
}

fn ensure_account_state(conn: &Connection, account_id: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO exchange_account_state (account_id) VALUES (?1)
         ON CONFLICT (account_id) DO NOTHING",
        [account_id],
    )?;
    Ok(())
}

pub fn read_discovered_assets(conn: &Connection, account_id: &str) -> Result<Vec<String>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT discovered_assets FROM exchange_account_state WHERE account_id = ?1",
            [account_id],
            |row| row.get(0),
        )
        .optional()?;
    match raw {
        None => Ok(Vec::new()),
        Some(json) => serde_json::from_str(&json)
            .map_err(|e| json_error("the discovered asset set is unreadable", e)),
    }
}

/// Add to the discovered asset set, which only ever grows.
///
/// Binance's `myTrades` requires a symbol and there is no all-symbols endpoint, so this set is
/// what decides which pairs a sync asks about. Sorted so the stored value is stable and a
/// no-change update does not rewrite the row differently every time.
pub fn add_discovered_assets(conn: &Connection, account_id: &str, codes: &[String]) -> Result<()> {
    ensure_account_state(conn, account_id)?;
    let mut assets: BTreeSet<String> = read_discovered_assets(conn, account_id)?
        .into_iter()
        .collect();
    for code in codes {
        assets.insert(code.clone());
    }
    let json = serde_json::to_string(&assets.iter().collect::<Vec<_>>())
        .map_err(|e| json_error("could not encode the discovered asset set", e))?;
    conn.execute(
        "UPDATE exchange_account_state SET discovered_assets = ?2 WHERE account_id = ?1",
        rusqlite::params![account_id, json],
    )?;
    Ok(())
}

pub fn read_markets(conn: &Connection, provider_id: &str, as_of: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT markets FROM exchange_market_cache WHERE provider_id = ?1 AND as_of = ?2",
            rusqlite::params![provider_id, as_of],
            |row| row.get(0),
        )
        .optional()?)
}

pub fn write_markets(
    conn: &Connection,
    provider_id: &str,
    as_of: &str,
    markets: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO exchange_market_cache (provider_id, as_of, markets, fetched_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (provider_id, as_of) DO UPDATE
           SET markets = excluded.markets, fetched_at = excluded.fetched_at",
        rusqlite::params![provider_id, as_of, markets, now_iso()],
    )?;
    Ok(())
}

/// Record how the last sync went, without deleting anything the user holds.
///
/// 'quarantined' is not a failed sync; it is a refusal to run one, because the key was found to
/// have gained withdrawal permission since it was connected.
pub fn set_account_status(
    conn: &Connection,
    account_id: &str,
    status: &str,
    error_code: Option<&str>,
) -> Result<()> {
    ensure_account_state(conn, account_id)?;
    conn.execute(
        "UPDATE exchange_account_state
            SET last_status = ?2, last_error_code = ?3, last_synced_at = ?4
          WHERE account_id = ?1",
        rusqlite::params![account_id, status, error_code, now_iso()],
    )?;
    Ok(())
}

/// So the account manager can show a key that has silently stopped being used.
pub fn touch_credential(conn: &Connection, account_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE credential_ref SET last_used_at = ?2 WHERE account_id = ?1",
        rusqlite::params![account_id, now_iso()],
    )?;
    Ok(())
}

/// Record what the exchange said this key can do, so the badge survives a restart.
///
/// Stores no secret. 'unknown' is a value in `flags` and is not rounded to false: reporting
/// "withdrawals disabled" when we simply cannot see is false reassurance.
pub fn record_scope(
    conn: &Connection,
    account_id: &str,
    verification: &str,
    flags: &str,
    acknowledged: bool,
) -> Result<()> {
    conn.execute(
        "UPDATE credential_ref
            SET scope_verification = ?2, scope_flags = ?3,
                acknowledged_at = CASE WHEN ?4 THEN ?5 ELSE acknowledged_at END
          WHERE account_id = ?1",
        rusqlite::params![account_id, verification, flags, acknowledged, now_iso()],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

pub fn create_instrument(conn: &Connection, spec: &InstrumentSpec) -> Result<String> {
    let id = new_id();
    conn.execute(
        "INSERT INTO instrument (id, asset_class, tax_regime, display_name, currency, precision,
            created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            id,
            spec.asset_class,
            spec.tax_regime,
            spec.display_name,
            spec.currency,
            spec.precision,
            now_iso(),
        ],
    )?;
    Ok(id)
}

/// Insert an alias only where none exists for that identifier.
///
/// An alias already pointing at a different instrument is never repointed: the uniqueness
/// constraint exists so a wrong mapping cannot be written twice, and quietly overwriting it would
/// defeat that.
pub fn add_alias(
    conn: &Connection,
    instrument_id: &str,
    scheme: &str,
    value: &str,
    provider_id: Option<&str>,
) -> Result<()> {
    conn.execute(
        "INSERT INTO instrument_alias (instrument_id, scheme, value, provider_id)
         SELECT ?1, ?2, ?3, ?4
          WHERE NOT EXISTS (SELECT 1 FROM instrument_alias
                             WHERE scheme = ?2 AND value = ?3 AND provider_id IS ?4)",
        rusqlite::params![instrument_id, scheme, value, provider_id],
    )?;
    Ok(())
}

/// Queue an asset the catalogue does not know, with the quantity withheld from every total.
///
/// Not an error: the sync completes and the UI states the exact amount excluded. Guarded so a
/// daily sync of an account holding one unrecognised coin does not add a queue entry a day - the
/// question is the same question until the user answers it.
pub fn record_unresolved(conn: &Connection, record: &UnresolvedRecord) -> Result<()> {
    conn.execute(
        "INSERT INTO unresolved_instrument (id, source_document_id, account_id, raw_identifier,
            raw_name, asset_class_hint, observed_quantity, first_seen_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
          WHERE NOT EXISTS (SELECT 1 FROM unresolved_instrument
                             WHERE account_id = ?3 AND raw_identifier = ?4
                               AND resolved_at IS NULL)",
        rusqlite::params![
            new_id(),
            record.source_document_id,
            record.account_id,
            record.raw_identifier,
            record.raw_name,
            record.asset_class_hint,
            record.observed_quantity,
            now_iso(),
        ],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Hold a credential in memory and return a handle that can sign with it.
///
/// Nothing reaches disk here. The connect probe signs with the handle, and only
/// `exchange_commit_credential` writes to the keychain - so a key the scope check refuses is
/// never stored, structurally rather than by convention.
#[tauri::command]
pub fn exchange_stage_credential(
    exchange: tauri::State<'_, ExchangeState>,
    api_key: String,
    api_secret: String,
) -> Result<String> {
    Ok(exchange.stage(&api_key, &api_secret))
}

#[tauri::command]
pub fn exchange_discard_credential(
    exchange: tauri::State<'_, ExchangeState>,
    handle: String,
) -> Result<()> {
    // Dropping the staged value overwrites the key material.
    drop(exchange.take(&handle));
    Ok(())
}

#[tauri::command]
pub fn exchange_commit_credential(
    state: tauri::State<'_, AppState>,
    exchange: tauri::State<'_, ExchangeState>,
    handle: String,
    account: AccountIdentity,
) -> Result<()> {
    let mut conn = state.conn.lock().expect("storage mutex poisoned");
    commit_credential(&mut conn, &exchange, &handle, &account)
}

/// Present so a test - and the account manager - can ask whether anything was stored, without
/// reading a secret back out.
#[tauri::command]
pub fn exchange_has_credential(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<bool> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    let found: i64 = conn.query_row(
        "SELECT count(*) FROM credential_ref WHERE account_id = ?1",
        [&account_id],
        |row| row.get(0),
    )?;
    Ok(found > 0)
}

#[tauri::command]
pub fn exchange_record_scope(
    state: tauri::State<'_, AppState>,
    account_id: String,
    verification: String,
    flags: String,
    acknowledged: bool,
) -> Result<()> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    record_scope(&conn, &account_id, &verification, &flags, acknowledged)
}

#[tauri::command]
pub fn sync_read_cursor(
    state: tauri::State<'_, AppState>,
    account_id: String,
    stream: String,
    scope: String,
) -> Result<Option<String>> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    read_cursor(&conn, &account_id, &stream, &scope)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn sync_write_cursor(
    state: tauri::State<'_, AppState>,
    account_id: String,
    stream: String,
    scope: String,
    cursor: Option<String>,
    last_synced_at: String,
    coverage_note: Option<String>,
) -> Result<()> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    write_cursor(
        &conn,
        &account_id,
        &stream,
        &scope,
        cursor.as_deref(),
        &last_synced_at,
        coverage_note.as_deref(),
    )
}

#[tauri::command]
pub fn sync_upsert_document(
    state: tauri::State<'_, AppState>,
    descriptor: DocumentDescriptor,
) -> Result<DocumentRef> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    upsert_document(&conn, &descriptor)
}

#[tauri::command]
pub fn sync_start_run(state: tauri::State<'_, AppState>, document_id: String) -> Result<String> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    start_run(&conn, &document_id)
}

#[tauri::command]
pub fn sync_finish_run(
    state: tauri::State<'_, AppState>,
    run_id: String,
    status: String,
    counts: RunCounts,
) -> Result<()> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    finish_run(&conn, &run_id, &status, &counts)
}

#[tauri::command]
pub fn sync_record_issue(
    state: tauri::State<'_, AppState>,
    run_id: String,
    issue: IssueRow,
) -> Result<()> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    record_issue(&conn, &run_id, &issue)
}

#[tauri::command]
pub fn sync_commit_positions(
    state: tauri::State<'_, AppState>,
    account_id: String,
    as_of: String,
    rows: Vec<PositionRow>,
    document_id: String,
) -> Result<()> {
    let mut conn = state.conn.lock().expect("storage mutex poisoned");
    commit_positions(&mut conn, &account_id, &as_of, &rows, &document_id)
}

#[tauri::command]
pub fn sync_commit_transactions(
    state: tauri::State<'_, AppState>,
    rows: Vec<TxnRow>,
) -> Result<CommitCounts> {
    let mut conn = state.conn.lock().expect("storage mutex poisoned");
    commit_transactions(&mut conn, &rows)
}

#[tauri::command]
pub fn sync_transaction_quantities(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<Vec<QuantityRow>> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    transaction_quantities(&conn, &account_id)
}

#[tauri::command]
pub fn sync_read_discovered_assets(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<Vec<String>> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    read_discovered_assets(&conn, &account_id)
}

#[tauri::command]
pub fn sync_add_discovered_assets(
    state: tauri::State<'_, AppState>,
    account_id: String,
    codes: Vec<String>,
) -> Result<()> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    add_discovered_assets(&conn, &account_id, &codes)
}

#[tauri::command]
pub fn sync_read_markets(
    state: tauri::State<'_, AppState>,
    provider_id: String,
    as_of_date: String,
) -> Result<Option<String>> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    read_markets(&conn, &provider_id, &as_of_date)
}

#[tauri::command]
pub fn sync_write_markets(
    state: tauri::State<'_, AppState>,
    provider_id: String,
    as_of_date: String,
    markets: String,
) -> Result<()> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    write_markets(&conn, &provider_id, &as_of_date, &markets)
}

#[tauri::command]
pub fn sync_set_account_status(
    state: tauri::State<'_, AppState>,
    account_id: String,
    status: String,
    error_code: Option<String>,
) -> Result<()> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    set_account_status(&conn, &account_id, &status, error_code.as_deref())
}

#[tauri::command]
pub fn sync_touch_credential(state: tauri::State<'_, AppState>, account_id: String) -> Result<()> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    touch_credential(&conn, &account_id)
}

#[tauri::command]
pub fn sync_find_instrument_by_alias(
    state: tauri::State<'_, AppState>,
    scheme: String,
    value: String,
    provider_id: Option<String>,
) -> Result<Option<String>> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    crate::ingest::find_alias_target(&conn, &scheme, &value, provider_id.as_deref())
}

#[tauri::command]
pub fn sync_create_instrument(
    state: tauri::State<'_, AppState>,
    spec: InstrumentSpec,
) -> Result<String> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    create_instrument(&conn, &spec)
}

#[tauri::command]
pub fn sync_add_alias(
    state: tauri::State<'_, AppState>,
    instrument_id: String,
    scheme: String,
    value: String,
    provider_id: Option<String>,
) -> Result<()> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    add_alias(
        &conn,
        &instrument_id,
        &scheme,
        &value,
        provider_id.as_deref(),
    )
}

#[tauri::command]
pub fn sync_record_unresolved(
    state: tauri::State<'_, AppState>,
    record: UnresolvedRecord,
) -> Result<()> {
    let conn = state.conn.lock().expect("storage mutex poisoned");
    record_unresolved(&conn, &record)
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
            "INSERT INTO account (id, provider_id, label, capability, base_currency, created_at)
               VALUES ('a1', 'binance', 'Binance', 'snapshot', 'INR', 'now');
             INSERT INTO instrument (id, asset_class, display_name, currency, precision, created_at)
               VALUES ('i-btc', 'crypto', 'Bitcoin', 'USD', 8, 'now');
             INSERT INTO source_document (id, account_id, provider_id, kind, content_hash,
                 imported_at)
               VALUES ('d1', 'a1', 'binance', 'api-response', 'hash-1', 'now');",
        )
        .unwrap();
        (dir, conn)
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    /// A second account, on the other exchange, holding a credential of its own.
    ///
    /// `a1` from the base fixture is Binance; `c1` is CoinDCX and has the stored `credential_ref`
    /// row. Every existing guard test uses one account, which is why none of them could construct
    /// this: a credential can only be aimed at the wrong exchange when there are two.
    fn add_coindcx_account(conn: &Connection) {
        conn.execute_batch(
            "INSERT INTO account (id, provider_id, label, capability, base_currency, created_at)
               VALUES ('c1', 'coindcx', 'CoinDCX', 'snapshot', 'INR', 'now');
             INSERT INTO credential_ref (account_id, keychain_key, kind, created_at)
               VALUES ('c1', 'secret/c1', 'api-key-secret', 'now');",
        )
        .unwrap();
    }

    fn request(adapter: &str, method: Method, path: &str, host: HostKey) -> ExchangeRequest {
        ExchangeRequest {
            adapter_id: adapter.to_string(),
            account_id: "a1".to_string(),
            host,
            method,
            path: path.to_string(),
            query: "timestamp=1786528800000".to_string(),
            body: None,
            signing: SigningScheme::None,
            user_agent: "Misal/0.1 (test)".to_string(),
            credential_handle: None,
        }
    }

    // -- the guard ----------------------------------------------------------

    #[test]
    fn a_mutating_path_never_reaches_a_socket() {
        let (_dir, conn) = open_test_db();
        let state = ExchangeState::new();
        for path in [
            "/api/v3/order",
            "/sapi/v1/capital/withdraw/apply",
            "/sapi/v1/asset/transfer",
        ] {
            for method in [Method::Get, Method::Post] {
                let request = request("binance", method, path, HostKey::Primary);
                assert!(
                    prepare(&conn, &state, &request).is_err(),
                    "{method} {path} was prepared"
                );
            }
        }
    }

    #[test]
    fn a_request_cannot_choose_its_own_host() {
        // A signed request carries the user's API key. Letting the caller name the origin would
        // make every other check here decoration.
        let (_dir, conn) = open_test_db();
        let state = ExchangeState::new();

        let allowed = request("binance", Method::Get, "/api/v3/myTrades", HostKey::Primary);
        assert!(prepare(&conn, &state, &allowed).is_ok());

        let elsewhere = request("binance", Method::Get, "/api/v3/myTrades", HostKey::Public);
        assert!(prepare(&conn, &state, &elsewhere).is_err());
    }

    #[test]
    fn the_url_comes_from_the_adapter_table_not_from_the_caller() {
        let (_dir, conn) = open_test_db();
        let state = ExchangeState::new();
        let signed = prepare(
            &conn,
            &state,
            &request(
                "binance",
                Method::Get,
                "/api/v3/exchangeInfo",
                HostKey::Public,
            ),
        )
        .unwrap();
        assert!(signed
            .url
            .starts_with("https://data-api.binance.vision/api/v3/exchangeInfo"));
    }

    #[test]
    fn one_adapter_cannot_borrow_anothers_endpoint() {
        let (_dir, conn) = open_test_db();
        let state = ExchangeState::new();
        let borrowed = request("coindcx", Method::Get, "/api/v3/myTrades", HostKey::Primary);
        assert!(prepare(&conn, &state, &borrowed).is_err());
    }

    /// The two-account test the single-account fixture could not express.
    ///
    /// Every other guard here pins the *origin*. This one pins the credential aimed at it: with
    /// the join removed, `{adapterId: 'binance', accountId: 'c1'}` passes the adapter, host, path
    /// and scheme checks and opens TLS to `api.binance.com` carrying `X-MBX-APIKEY: <CoinDCX
    /// key>`. CoinDCX issues no read-only keys, so what lands in a third party's request log can
    /// trade and withdraw.
    ///
    /// Asserted on the message, not merely on `is_err`: without the join the lookup still fails,
    /// one step later and for the wrong reason - it finds the key, then cannot read the keychain
    /// entry - so `is_err()` alone would pass against the defect.
    #[test]
    fn one_adapter_cannot_sign_with_another_accounts_credential() {
        let (_dir, conn) = open_test_db();
        add_coindcx_account(&conn);
        let state = ExchangeState::new();

        let mut borrowed = request("binance", Method::Get, "/api/v3/myTrades", HostKey::Primary);
        borrowed.account_id = "c1".to_string();
        borrowed.signing = SigningScheme::BinanceQuery;

        let error = prepare(&conn, &state, &borrowed).unwrap_err().to_string();
        assert!(
            error.contains("account c1 belongs to coindcx"),
            "the CoinDCX key was aimed at Binance and the refusal did not say so: {error}"
        );
    }

    #[test]
    fn the_check_runs_in_both_directions() {
        let (_dir, conn) = open_test_db();
        add_coindcx_account(&conn);
        let state = ExchangeState::new();

        let mut borrowed = request(
            "coindcx",
            Method::Post,
            "/exchange/v1/users/balances",
            HostKey::Primary,
        );
        // a1 is the Binance account, and its key would be signed CoinDCX-style into a body.
        borrowed.signing = SigningScheme::CoindcxBody;

        let error = prepare(&conn, &state, &borrowed).unwrap_err().to_string();
        assert!(error.contains("account a1 belongs to binance"), "{error}");
    }

    /// The other half of the assertion: the check refuses a mismatch, not everything.
    ///
    /// A matching pair reaches the credential lookup and stops there, because this account has no
    /// stored credential - which is also why no test in this module touches the real keychain.
    #[test]
    fn an_account_on_its_own_exchange_reaches_the_credential_lookup() {
        let (_dir, conn) = open_test_db();
        add_coindcx_account(&conn);
        let state = ExchangeState::new();

        let mut matched = request("binance", Method::Get, "/api/v3/myTrades", HostKey::Primary);
        matched.signing = SigningScheme::BinanceQuery;

        let error = prepare(&conn, &state, &matched).unwrap_err().to_string();
        assert!(
            error.contains("no credential is stored for account a1"),
            "an account was refused its own exchange: {error}"
        );
    }

    #[test]
    fn a_page_cannot_be_filed_under_an_account_on_another_exchange() {
        // `start_run` reads the provider back off this row to stamp the run, so an unchecked pair
        // would give every transaction under it a provenance that is a fiction.
        let (_dir, conn) = open_test_db();
        add_coindcx_account(&conn);
        let error = upsert_document(
            &conn,
            &DocumentDescriptor {
                provider_id: "binance".to_string(),
                account_id: "c1".to_string(),
                kind: "api-response".to_string(),
                content_hash: "hash-borrowed".to_string(),
                page_ref: "binance:myTrades BTCUSDT fromId=0".to_string(),
                period_start: None,
                period_end: None,
            },
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("account c1 belongs to coindcx"), "{error}");
        assert_eq!(count(&conn, "source_document"), 1); // d1 alone
    }

    #[test]
    fn a_credential_cannot_be_committed_onto_an_account_of_another_exchange() {
        // The connect-flow door to the same confusion: the upsert leaves `provider_id` alone, so
        // this would leave a CoinDCX account row pointing at a Binance key.
        let (_dir, mut conn) = open_test_db();
        add_coindcx_account(&conn);
        let state = ExchangeState::new();
        let handle = state.stage("public-identifier", "0123456789abcdef");

        let account = AccountIdentity {
            id: "c1".to_string(),
            provider_id: "binance".to_string(),
            label: "Not CoinDCX".to_string(),
            base_currency: "INR".to_string(),
        };
        let error = commit_credential(&mut conn, &state, &handle, &account)
            .unwrap_err()
            .to_string();
        assert!(error.contains("already belongs to coindcx"), "{error}");

        let stored: String = conn
            .query_row(
                "SELECT keychain_key FROM credential_ref WHERE account_id = 'c1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, "secret/c1", "the stored credential was repointed");
    }

    #[test]
    fn the_signing_scheme_is_fixed_per_exchange() {
        // A Binance request signed CoinDCX-style would HMAC a body of the caller's choosing.
        let (_dir, conn) = open_test_db();
        let state = ExchangeState::new();
        let mut mismatched = request("binance", Method::Get, "/api/v3/myTrades", HostKey::Primary);
        mismatched.signing = SigningScheme::CoindcxBody;
        assert!(prepare(&conn, &state, &mismatched).is_err());
    }

    /// Every endpoint the core will let any adapter reach, checked as a set.
    ///
    /// The list is what a security reviewer reads, so it has to be enumerable and it has to be
    /// read-only in the classifier's own judgement rather than in the reviewer's. This is the
    /// check that catches an endpoint added to the table without a matching read terminal - the
    /// exact shape of the Convert addition, where `/sapi/v1/convert/tradeFlow` is admissible only
    /// because `tradeflow` earns the exemption and its sibling `getQuote` does not.
    #[test]
    fn every_declared_endpoint_is_read_only_and_builds_a_session() {
        for spec in ADAPTERS {
            for endpoint in spec.endpoints {
                assert!(
                    !crate::exchange_guard::is_mutating_path(endpoint.path),
                    "{} declares {} {}, which the classifier calls mutating: {:?}",
                    spec.id,
                    endpoint.method,
                    endpoint.path,
                    crate::exchange_guard::mutation_reason(endpoint.path)
                );
            }
            Session::new(spec.id, spec.allowlist())
                .unwrap_or_else(|e| panic!("{} allowlist rejected: {e}", spec.id));
        }
    }

    #[test]
    fn convert_history_is_reachable_and_converting_is_not() {
        let (_dir, conn) = open_test_db();
        let state = ExchangeState::new();
        // Reachable: Convert fills appear in no trade history, so this endpoint or nothing.
        assert!(BINANCE.permits(Method::Get, "/sapi/v1/convert/tradeFlow", HostKey::Primary));
        // And the operations that would actually convert are not on the table at all.
        for path in [
            "/sapi/v1/convert/getQuote",
            "/sapi/v1/convert/acceptQuote",
            "/sapi/v1/convert/limit/placeOrder",
        ] {
            assert!(!BINANCE.permits(Method::Post, path, HostKey::Primary));
            assert!(!BINANCE.permits(Method::Get, path, HostKey::Primary));
            let attempt = request("binance", Method::Post, path, HostKey::Primary);
            assert!(prepare(&conn, &state, &attempt).is_err());
        }
    }

    #[test]
    fn a_signed_request_without_a_credential_is_refused_rather_than_sent_unsigned() {
        let (_dir, conn) = open_test_db();
        let state = ExchangeState::new();
        let mut signed = request("binance", Method::Get, "/api/v3/myTrades", HostKey::Primary);
        signed.signing = SigningScheme::BinanceQuery;
        // No credential_ref row for a1 yet, and no staged handle.
        assert!(prepare(&conn, &state, &signed).is_err());
    }

    #[test]
    fn a_staged_credential_signs_the_probe_without_being_stored() {
        let (_dir, conn) = open_test_db();
        let state = ExchangeState::new();
        let handle = state.stage("public-identifier", "0123456789abcdef");

        let mut probe = request(
            "binance",
            Method::Get,
            "/sapi/v1/account/apiRestrictions",
            HostKey::Primary,
        );
        probe.signing = SigningScheme::BinanceQuery;
        probe.credential_handle = Some(handle);

        let prepared = prepare(&conn, &state, &probe).unwrap();
        assert!(prepared
            .headers
            .iter()
            .any(|(name, value)| name == "X-MBX-APIKEY" && value == "public-identifier"));
        assert!(prepared.url.contains("&signature="));
        // Nothing was written: the scope check has not run yet.
        assert_eq!(count(&conn, "credential_ref"), 0);
    }

    // -- the refusal that has no override -----------------------------------

    /// The definition-of-done test.
    ///
    /// The connect flow stages, probes, sees `enableWithdrawals: true`, and discards. Asserted by
    /// looking at what was written rather than by trusting a return value: "nothing reached the
    /// keychain" is only a check if something checks.
    #[test]
    fn an_over_scoped_key_is_refused_before_the_secret_is_stored() {
        let (_dir, mut conn) = open_test_db();
        let state = ExchangeState::new();
        let handle = state.stage("public-identifier", "0123456789abcdef");
        assert_eq!(state.staged_count(), 1);

        // What connect.ts does on `canWithdraw === true`: discard, never commit.
        drop(state.take(&handle));

        assert_eq!(state.staged_count(), 0);
        let account = AccountIdentity {
            id: "a2".to_string(),
            provider_id: "binance".to_string(),
            label: "Binance".to_string(),
            base_currency: "INR".to_string(),
        };
        assert!(
            commit_credential(&mut conn, &state, &handle, &account).is_err(),
            "a discarded credential could still be committed"
        );
        assert_eq!(count(&conn, "credential_ref"), 0);
        assert_eq!(
            count(&conn, "account WHERE id = 'a2'"),
            0,
            "a refused connect created an account anyway"
        );
    }

    #[test]
    fn a_credential_for_an_unknown_exchange_is_refused() {
        let (_dir, mut conn) = open_test_db();
        let state = ExchangeState::new();
        let handle = state.stage("k", "s");
        let account = AccountIdentity {
            id: "a3".to_string(),
            provider_id: "zerodha-kite".to_string(),
            label: "Not an exchange".to_string(),
            base_currency: "INR".to_string(),
        };
        assert!(commit_credential(&mut conn, &state, &handle, &account).is_err());
        assert_eq!(count(&conn, "credential_ref"), 0);
    }

    // -- the store ----------------------------------------------------------

    fn txn(natural_key: &str, occurrence: i64, quantity: &str) -> TxnRow {
        TxnRow {
            account_id: "a1".to_string(),
            instrument_id: "i-btc".to_string(),
            txn_type: "buy".to_string(),
            occurred_at: "2026-08-12T09:00:00.000Z".to_string(),
            occurred_tz: None,
            quantity: quantity.to_string(),
            price: Some("60000.00000000".to_string()),
            amount_minor: None,
            other_fees_minor: "0".to_string(),
            currency: "X:USDT".to_string(),
            source_document_id: "d1".to_string(),
            natural_key: natural_key.to_string(),
            occurrence,
            external_id: Some("28457".to_string()),
        }
    }

    #[test]
    fn re_fetching_a_page_commits_nothing_and_reports_it_as_duplicate() {
        let (_dir, mut conn) = open_test_db();
        let page = vec![txn("key-1", 0, "0.10000000"), txn("key-2", 0, "0.20000000")];

        let first = commit_transactions(&mut conn, &page).unwrap();
        assert_eq!((first.committed, first.duplicate), (2, 0));

        let again = commit_transactions(&mut conn, &page).unwrap();
        assert_eq!((again.committed, again.duplicate), (0, 2));
        assert_eq!(count(&conn, "txn"), 2);
    }

    #[test]
    fn two_identical_fills_in_one_page_both_survive() {
        // Uniqueness is on (natural_key, occurrence). The same commission twice in one page is
        // two real fees, and numbering them is what keeps both.
        let (_dir, mut conn) = open_test_db();
        let page = vec![txn("key-1", 0, "0.10000000"), txn("key-1", 1, "0.10000000")];
        let counts = commit_transactions(&mut conn, &page).unwrap();
        assert_eq!(counts.committed, 2);
    }

    #[test]
    fn an_eighteen_decimal_quantity_survives_the_write() {
        let (_dir, mut conn) = open_test_db();
        let quantity = "42.000000000000000001";
        commit_transactions(&mut conn, &[txn("key-1", 0, quantity)]).unwrap();
        let stored: String = conn
            .query_row("SELECT quantity FROM txn", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, quantity);
    }

    #[test]
    fn a_failed_page_leaves_none_of_itself_behind() {
        let (_dir, mut conn) = open_test_db();
        let mut doomed = txn("key-2", 0, "0.20000000");
        doomed.instrument_id = "i-does-not-exist".to_string();
        let page = vec![txn("key-1", 0, "0.10000000"), doomed];
        assert!(commit_transactions(&mut conn, &page).is_err());
        assert_eq!(count(&conn, "txn"), 0);
    }

    #[test]
    fn a_balance_set_that_fails_part_way_writes_nothing_and_leaves_yesterday_standing() {
        // A half-written balance set is not incomplete, it is wrong: it understates net worth
        // while looking complete.
        let (_dir, mut conn) = open_test_db();
        commit_positions(
            &mut conn,
            "a1",
            "2026-08-11",
            &[PositionRow {
                instrument_id: "i-btc".to_string(),
                quantity: "1.00000000".to_string(),
            }],
            "d1",
        )
        .unwrap();

        let doomed = vec![
            PositionRow {
                instrument_id: "i-btc".to_string(),
                quantity: "2.00000000".to_string(),
            },
            PositionRow {
                instrument_id: "i-does-not-exist".to_string(),
                quantity: "3.00000000".to_string(),
            },
        ];
        assert!(commit_positions(&mut conn, "a1", "2026-08-12", &doomed, "d1").is_err());

        assert_eq!(count(&conn, "position WHERE as_of = '2026-08-12'"), 0);
        assert_eq!(count(&conn, "position WHERE as_of = '2026-08-11'"), 1);
    }

    #[test]
    fn a_second_sync_the_same_day_restates_the_balance_rather_than_doubling_it() {
        let (_dir, mut conn) = open_test_db();
        let first = vec![PositionRow {
            instrument_id: "i-btc".to_string(),
            quantity: "1.00000000".to_string(),
        }];
        commit_positions(&mut conn, "a1", "2026-08-12", &first, "d1").unwrap();
        let second = vec![PositionRow {
            instrument_id: "i-btc".to_string(),
            quantity: "1.50000000".to_string(),
        }];
        commit_positions(&mut conn, "a1", "2026-08-12", &second, "d1").unwrap();

        assert_eq!(count(&conn, "position"), 1);
        let quantity: String = conn
            .query_row("SELECT quantity FROM position", [], |r| r.get(0))
            .unwrap();
        assert_eq!(quantity, "1.50000000");
    }

    #[test]
    fn an_asset_the_exchange_stopped_reporting_leaves_todays_figures() {
        let (_dir, mut conn) = open_test_db();
        conn.execute(
            "INSERT INTO instrument (id, asset_class, display_name, currency, created_at)
             VALUES ('i-eth', 'crypto', 'Ethereum', 'USD', 'now')",
            [],
        )
        .unwrap();
        commit_positions(
            &mut conn,
            "a1",
            "2026-08-12",
            &[
                PositionRow {
                    instrument_id: "i-btc".to_string(),
                    quantity: "1.00000000".to_string(),
                },
                PositionRow {
                    instrument_id: "i-eth".to_string(),
                    quantity: "5.00000000".to_string(),
                },
            ],
            "d1",
        )
        .unwrap();
        commit_positions(
            &mut conn,
            "a1",
            "2026-08-12",
            &[PositionRow {
                instrument_id: "i-btc".to_string(),
                quantity: "1.00000000".to_string(),
            }],
            "d1",
        )
        .unwrap();
        assert_eq!(count(&conn, "position"), 1);
    }

    #[test]
    fn the_same_page_fetched_twice_reuses_its_document() {
        let (_dir, conn) = open_test_db();
        let descriptor = DocumentDescriptor {
            provider_id: "binance".to_string(),
            account_id: "a1".to_string(),
            kind: "api-response".to_string(),
            content_hash: "hash-page-1".to_string(),
            page_ref: "binance:myTrades BTCUSDT fromId=0".to_string(),
            period_start: None,
            period_end: None,
        };
        let first = upsert_document(&conn, &descriptor).unwrap();
        assert!(!first.existed);
        let again = upsert_document(&conn, &descriptor).unwrap();
        assert!(again.existed);
        assert_eq!(first.id, again.id);
        assert_eq!(count(&conn, "source_document"), 2); // d1 plus this one
    }

    #[test]
    fn a_watermark_round_trips_and_is_replaced_rather_than_appended() {
        let (_dir, conn) = open_test_db();
        assert!(read_cursor(&conn, "a1", "fills", "*").unwrap().is_none());
        write_cursor(&conn, "a1", "fills", "*", Some("28458"), "now", None).unwrap();
        write_cursor(
            &conn,
            "a1",
            "fills",
            "*",
            Some("28460"),
            "now",
            Some("Convert trades are invisible"),
        )
        .unwrap();
        assert_eq!(
            read_cursor(&conn, "a1", "fills", "*").unwrap().as_deref(),
            Some("28460")
        );
        assert_eq!(count(&conn, "sync_state"), 1);
        let note: Option<String> = conn
            .query_row("SELECT coverage_note FROM sync_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(note.as_deref(), Some("Convert trades are invisible"));
    }

    #[test]
    fn the_discovered_asset_set_only_grows() {
        let (_dir, conn) = open_test_db();
        add_discovered_assets(&conn, "a1", &["BTC".to_string(), "USDT".to_string()]).unwrap();
        add_discovered_assets(&conn, "a1", &["BTC".to_string(), "BNB".to_string()]).unwrap();
        assert_eq!(
            read_discovered_assets(&conn, "a1").unwrap(),
            vec!["BNB".to_string(), "BTC".to_string(), "USDT".to_string()]
        );
    }

    #[test]
    fn the_market_catalogue_is_cached_per_provider_per_day() {
        let (_dir, conn) = open_test_db();
        assert!(read_markets(&conn, "binance", "2026-08-12")
            .unwrap()
            .is_none());
        write_markets(&conn, "binance", "2026-08-12", "[{\"symbol\":\"BTCUSDT\"}]").unwrap();
        assert_eq!(
            read_markets(&conn, "binance", "2026-08-12")
                .unwrap()
                .unwrap(),
            "[{\"symbol\":\"BTCUSDT\"}]"
        );
        assert!(read_markets(&conn, "binance", "2026-08-13")
            .unwrap()
            .is_none());
    }

    #[test]
    fn the_same_unresolved_asset_does_not_queue_again_on_the_next_sync() {
        let (_dir, conn) = open_test_db();
        let record = UnresolvedRecord {
            account_id: "a1".to_string(),
            source_document_id: "d1".to_string(),
            raw_identifier: "NEWCOIN".to_string(),
            raw_name: None,
            asset_class_hint: Some("crypto".to_string()),
            observed_quantity: Some("42.000000000000000001".to_string()),
        };
        record_unresolved(&conn, &record).unwrap();
        record_unresolved(&conn, &record).unwrap();
        assert_eq!(count(&conn, "unresolved_instrument"), 1);

        let quantity: String = conn
            .query_row(
                "SELECT observed_quantity FROM unresolved_instrument",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(quantity, "42.000000000000000001");
    }

    #[test]
    fn quantities_come_back_unsummed_and_as_text() {
        let (_dir, mut conn) = open_test_db();
        commit_transactions(
            &mut conn,
            &[
                txn("key-1", 0, "0.10000000"),
                txn("key-2", 0, "-0.00030000000000"),
            ],
        )
        .unwrap();
        let rows = transaction_quantities(&conn, "a1").unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|r| r.quantity == "-0.00030000000000"));
    }

    #[test]
    fn a_partial_sync_is_a_completed_run_with_failures_recorded() {
        let (_dir, conn) = open_test_db();
        let run = start_run(&conn, "d1").unwrap();
        finish_run(
            &conn,
            &run,
            "completed",
            &RunCounts {
                rows_read: 4,
                rows_committed: 2,
                rows_duplicate: 1,
                rows_failed: 1,
            },
        )
        .unwrap();
        record_issue(
            &conn,
            &run,
            &IssueRow {
                severity: "warning".to_string(),
                code: "coverage_gap".to_string(),
                message: "the fold and the balance disagree".to_string(),
                row_ref: Some("i-btc".to_string()),
                raw_payload: None,
            },
        )
        .unwrap();

        let (status, failed): (String, i64) = conn
            .query_row("SELECT status, rows_failed FROM import_run", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((status.as_str(), failed), ("completed", 1));
        assert_eq!(count(&conn, "import_issue WHERE severity = 'warning'"), 1);
    }

    #[test]
    fn account_status_records_a_quarantine_without_deleting_anything() {
        let (_dir, mut conn) = open_test_db();
        commit_positions(
            &mut conn,
            "a1",
            "2026-08-11",
            &[PositionRow {
                instrument_id: "i-btc".to_string(),
                quantity: "1.00000000".to_string(),
            }],
            "d1",
        )
        .unwrap();
        set_account_status(&conn, "a1", "quarantined", Some("auth_over_scoped")).unwrap();

        let (status, code): (String, String) = conn
            .query_row(
                "SELECT last_status, last_error_code FROM exchange_account_state",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (status.as_str(), code.as_str()),
            ("quarantined", "auth_over_scoped")
        );
        assert_eq!(count(&conn, "position"), 1);
    }

    #[test]
    fn sync_state_and_account_state_die_with_their_account() {
        let (_dir, conn) = open_test_db();
        write_cursor(&conn, "a1", "fills", "*", Some("1"), "now", None).unwrap();
        add_discovered_assets(&conn, "a1", &["BTC".to_string()]).unwrap();
        conn.execute("DELETE FROM account WHERE id = 'a1'", [])
            .unwrap();
        assert_eq!(count(&conn, "sync_state"), 0);
        assert_eq!(count(&conn, "exchange_account_state"), 0);
    }
}
