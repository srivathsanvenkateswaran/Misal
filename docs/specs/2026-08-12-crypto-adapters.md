# Subsystem C — Live exchange adapters (crypto, v1)

**Status:** draft
**Date:** 2026-08-12
**Depends on:** [core schema and storage](2026-08-12-core-schema-storage.md),
[v1 design](2026-08-12-misal-v1-design.md)
**Implements:** Binance and CoinDCX. Researches CoinSwitch and WazirX without implementing them.

The core schema is a fixed contract. Nothing here changes it. Three places where crypto genuinely
does not fit the existing columns are recorded in
[Open questions for core](#open-questions-for-core) rather than worked around.

## Decisions

The non-obvious ones, up front, so a reviewer can disagree before reading the detail.

1. **Adapters replace only `acquire` and `extract`.** Everything downstream is the shared pipeline.
   Adding an exchange must be one file and a fixture directory, not a pipeline.
2. **Read-only is enforced in our code, not by the key.** Every adapter declares a request
   allowlist and the HTTP layer refuses anything else. CoinDCX has no read-only keys at all, so a
   safety story resting on key scoping is one we could not tell for half the exchanges we support.
3. **A key with withdrawal permission is refused, not warned about.** It is the only permission
   that can empty an account, a tracker never needs it, and on Binance it cannot be enabled by
   accident.
4. **Crypto accounts are `snapshot` in v1**, even though fills are ingested. Neither exchange can
   prove complete trade coverage, and `ledger` capability unlocks XIRR and realised P&L. Claiming
   it on incomplete history produces confidently wrong numbers.
5. **Balances commit atomically; trades commit incrementally per page.** A half-written balance set
   understates net worth. A half-written trade page is merely incomplete, and resumable.
6. **Symbols are never matched to instruments by ticker.** Only a curated
   `(exchange, asset_code) → CoinGecko id` mapping resolves. Crypto ticker collisions are routine,
   and a wrong merge double-counts net worth — the worst failure this application has.
7. **Fees paid in kind become their own `fee` transaction** against the fee asset. `fees_minor` is
   an integer in a currency's minor units; a fee of `0.000114 BNB` has neither.
8. **Watermarks are opaque adapter-owned strings held by core.** Binance needs a per-symbol
   trade-id map, CoinDCX one integer. Core should not know the difference.

## Where an adapter sits

The pipeline from the v1 design is unchanged:

```
acquire → extract → normalize → resolve → reconcile → commit
```

Statement ingestion acquires by reading a file the user chose. An adapter acquires by making signed
HTTP requests. That is the whole difference. `normalize`, `resolve`, `reconcile` and `commit` are
the same code paths, which is what keeps the two ingestion routes from drifting apart in their
handling of duplicates, unresolved instruments and partial failure.

An adapter therefore produces exactly what a statement parser produces: a `SourceDocument`
descriptor plus a batch of raw records. It never touches SQL, never resolves an instrument, and
never decides whether a transaction is a duplicate.

### Source documents for API responses

`source_document.kind = 'api-response'`, and `content_hash` is the SHA-256 of a canonical **request
envelope**, not of the response body:

```
sha256(JSON.stringify({ providerId, accountId, endpoint, params, asOfDate?, body }))
```

Two consequences, both intended:

- **Snapshot fetches include `asOfDate`** (the UTC date of the sync). One balance document per
  account per day. Re-syncing balances the same day is a genuine no-op via the `UNIQUE`
  constraint on `content_hash`; syncing tomorrow produces a new document and a new `position`
  row for the new `as_of`. Without `asOfDate`, an unchanged balance set would hash identically
  forever and could never record a second day's position.
- **Trade pages include the cursor** in `params`, so each page is a distinct document and a
  re-fetched page is a no-op.

On a `content_hash` collision the adapter runner **reuses the existing `source_document.id`**
rather than raising. A repeated fetch is not an error; it is idempotency working.

Per the core spec, raw bytes are never stored. `page_ref` carries a human-readable locator for the
UI source stamp — `binance:myTrades BTCUSDT fromId=0` — and the stamp codes are `BIN` for Binance
and `DCX` for CoinDCX. (`BNB` is deliberately avoided: it is also a token symbol.)

## The adapter contract

```ts
/** Numerics cross every boundary as strings. See core spec, "Data-access layer". */
type DecimalString = string;   // '0.000000000000000001' — up to 18 dp for crypto
type MinorUnits    = string;   // integer minor units, as a string: int64 exceeds 2^53
type Iso8601       = string;   // UTC with explicit offset
type EpochMs       = string;   // integer milliseconds, as a string

type ProviderId = 'binance' | 'coindcx';

/** An asset as the exchange names it. Never assumed to be globally meaningful. */
interface RawAsset {
  readonly code: string;           // 'BTC', 'USDT', 'INR' — verbatim from the exchange
}

interface RawBalance {
  readonly asset: RawAsset;
  readonly free: DecimalString;
  readonly locked: DecimalString;  // '0' if the exchange has no such concept
}

interface RawFill {
  readonly externalId: string;     // exchange trade id, stringified
  readonly symbol: string;         // exchange market name, verbatim: 'BTCUSDT', 'BTCINR'
  readonly side: 'buy' | 'sell';
  readonly quantity: DecimalString;   // in the base asset
  readonly price: DecimalString;      // quote asset per base asset
  readonly quoteQuantity?: DecimalString;
  readonly fee?: { amount: DecimalString; asset: RawAsset };
  readonly occurredAt: Iso8601;
}

interface RawTransfer {
  readonly externalId: string;
  readonly asset: RawAsset;
  readonly direction: 'in' | 'out';
  readonly quantity: DecimalString;
  readonly occurredAt: Iso8601;
  readonly status: 'completed' | 'pending' | 'failed';
}

/**
 * Splits an exchange symbol into its assets. Supplied by the adapter from the exchange's own
 * market catalogue — never inferred by string-splitting, which breaks on BTCUSDT vs BTCUSD
 * and on any base asset whose code contains the quote asset's code.
 */
interface MarketSpec {
  readonly symbol: string;
  readonly base: RawAsset;         // the asset whose quantity is traded
  readonly quote: RawAsset;        // the asset the price is denominated in
  readonly quantityPrecision: number;   // display precision, 0–18
}

/** One acquire step: a batch of records plus the document descriptor they came from. */
interface AcquiredPage<T> {
  readonly document: SourceDocumentDescriptor;
  readonly records: readonly T[];
  readonly nextCursor: string | null;   // null = caller has reached the end
}

interface SourceDocumentDescriptor {
  readonly providerId: ProviderId;
  readonly accountId: string;
  readonly kind: 'api-response';
  readonly contentHash: string;
  readonly pageRef: string;
  readonly periodStart?: Iso8601;
  readonly periodEnd?: Iso8601;
}
```

### Scope introspection

```ts
type ScopeVerification =
  | 'introspected'      // the exchange told us, authoritatively
  | 'attested'          // the exchange cannot tell us; the user confirmed the settings
  | 'unscopable';       // the exchange has no permission model at all

interface ScopeReport {
  readonly verification: ScopeVerification;
  readonly canRead: boolean | 'unknown';
  readonly canTrade: boolean | 'unknown';
  readonly canWithdraw: boolean | 'unknown';
  readonly canTransferInternally: boolean | 'unknown';
  readonly ipRestricted: boolean | 'unknown';
  readonly raw?: Readonly<Record<string, unknown>>;  // for the diagnostics pane
}
```

`'unknown'` is a distinct value from `false` and the UI must render it differently. Reporting
"withdrawals disabled" when we simply cannot see is the kind of false reassurance that makes a
security control worse than none.

### The adapter interface

```ts
interface AdapterContext {
  readonly accountId: string;
  /** Signs and sends. Rejects any request outside `requestAllowlist` before opening a socket. */
  readonly http: GuardedHttp;
  /** Exchange server time minus local time, in ms, measured at sync start. */
  readonly clockOffsetMs: number;
  readonly log: (issue: AdapterIssue) => void;
}

interface ExchangeAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly baseCurrency: string;            // 'USD' for Binance, 'INR' for CoinDCX
  readonly capability: 'ledger' | 'snapshot';
  readonly credentialFields: readonly CredentialFieldSpec[];

  /** Enforced by the HTTP layer. The single mechanism that makes Misal structurally read-only. */
  readonly requestAllowlist: readonly AllowedRequest[];

  /** Exchange clock, for HMAC skew correction. */
  serverTime(ctx: AdapterContext): Promise<EpochMs>;

  /** Called at connect and again before every sync. See "Credential handling". */
  describeScope(ctx: AdapterContext): Promise<ScopeReport>;

  /** Cached locally; refreshed at most daily. */
  markets(ctx: AdapterContext): Promise<readonly MarketSpec[]>;

  fetchBalances(ctx: AdapterContext): Promise<AcquiredPage<RawBalance>>;

  fetchFills(ctx: AdapterContext, cursor: string | null): AsyncIterable<AcquiredPage<RawFill>>;

  /** Optional: not every exchange exposes deposits and withdrawals. */
  fetchTransfers?(
    ctx: AdapterContext, cursor: string | null,
  ): AsyncIterable<AcquiredPage<RawTransfer>>;
}

interface AllowedRequest {
  readonly method: 'GET' | 'POST';
  readonly pathPattern: string;    // exact path or a single trailing wildcard
}
```

`fetchFills` returns an `AsyncIterable` rather than an array specifically so the runner can commit
and advance the watermark **per page**. A backfill of 40,000 trades that dies on the last page must
keep the first 39,000.

### Why the request allowlist is the real security control

CoinDCX issues one key class with full trade authority — there is no read-only option and no
permission model to query. CoinSwitch is the same. If Misal's safety story were "use a read-only
key", it would be a story we cannot tell for half the exchanges we support.

So the guarantee is inverted. `GuardedHttp` is constructed in the Rust core from the adapter's
`requestAllowlist` and rejects any request whose method and path are not on it, before the socket
opens. Binance's `POST /api/v3/order` is unreachable from Misal not because the key forbids it but
because no code path can express it. The allowlist is a small, reviewable, diffable list — the
kind of thing a security-minded contributor can audit in a minute:

```ts
const BINANCE_ALLOWLIST: readonly AllowedRequest[] = [
  { method: 'GET', pathPattern: '/api/v3/time' },
  { method: 'GET', pathPattern: '/api/v3/exchangeInfo' },
  { method: 'GET', pathPattern: '/api/v3/account' },
  { method: 'GET', pathPattern: '/api/v3/myTrades' },
  { method: 'GET', pathPattern: '/sapi/v1/account/apiRestrictions' },
  { method: 'GET', pathPattern: '/sapi/v1/capital/deposit/hisrec' },
  { method: 'GET', pathPattern: '/sapi/v1/capital/withdraw/history' },
  { method: 'POST', pathPattern: '/sapi/v3/asset/getUserAsset' },  // read-only despite POST
];
```

A conformance test asserts that every allowlist entry is non-mutating, and that no adapter's
allowlist contains an order, transfer, or withdrawal path. That test is the one a reviewer should
read first.

## Numeric and time discipline

The core spec's rules apply unchanged; crypto stresses three of them harder than statements do.

- **Configure `decimal.js` to `precision: 40`** at process start. An 18-decimal quantity multiplied
  by an 8-decimal price needs 26 significant digits before rounding; the library's default of 20
  silently truncates.
- **Parse JSON without `JSON.parse` for any response containing quantities.** Binance returns
  quantities as strings and is safe. CoinDCX returns strings for spot balances and fills but
  **JSON floats for every futures endpoint and for `markets_details`** — by the time `JSON.parse`
  returns, the digits are already gone. Use a lossless JSON parser that yields raw number literals
  as strings. This is not defensive; CoinDCX's own docs show a balance of `265.01745775027309`,
  which is 17 significant digits and already unrepresentable as a double.
- **Timestamps are integers, always truncated, never rounded.** CoinDCX returns fill timestamps as
  fractional milliseconds (`1718386312255.3608`). Truncate the string at the decimal point before
  parsing. Passing it through a float and rounding introduces a one-millisecond jitter that changes
  the `natural_key` and defeats deduplication.
- `txn.occurred_tz` is `NULL` for exchange data. Exchanges report epoch UTC; there is no original
  local timezone to preserve.

## Credential handling

### Storage

Unchanged from the core spec: the secret goes to the OS keychain under `secret/<account-id>`, and
`credential_ref` records only the pointer. Additionally:

- The API **key** (the public identifier) is also a secret in practice, because it identifies the
  account to anyone who obtains it. Both key and secret are stored as a single JSON blob in the
  one keychain entry. Nothing exchange-related is written to SQLite except the `credential_ref` row.
- The secret is read into memory only for the duration of a signing operation and is zeroised
  after. Signing happens in the Rust core; the TypeScript adapter never sees the secret, only a
  `GuardedHttp` handle that signs on its behalf. This is why `GuardedHttp` exists rather than the
  adapter building its own request.
- `credential_ref.last_used_at` is updated on every successful sync, so the account manager can
  show a key that has silently stopped being used.

### Over-scoped keys

Users paste whatever they generated. Three tiers, and the handling differs because the exchanges'
capabilities differ:

| Tier | Exchange | What we can know |
|---|---|---|
| Introspectable | Binance | `GET /sapi/v1/account/apiRestrictions` reports the key's permissions |
| Attestable | WazirX | Keys are scopable and read-only by default, but no endpoint reports scope |
| Unscopable | CoinDCX, CoinSwitch | No permission model exists; every key is trade-capable |

**Rules, in order:**

1. **Withdrawal permission is a hard refusal.** If `describeScope()` reports `canWithdraw === true`,
   the connect flow aborts, the secret is **never written to the keychain**, and the user is told
   to generate a new key without withdrawal rights. No override, no "I understand" checkbox.
   Rationale: it is the only permission that can move funds off the exchange, a tracker has no
   use for it, and on Binance it cannot be enabled without also configuring an IP allowlist — so
   its presence is deliberate configuration, not a slip. Refusing costs the user two minutes;
   accepting costs them everything.
2. **Trade permission is a warning with an acknowledgement.** `canTrade`, `canTransferInternally`,
   margin, futures or universal-transfer rights are recorded, surfaced as a persistent badge on
   the account, and require a one-time explicit acknowledgement before the credential is stored.
   They are not refused, because on CoinDCX refusing would mean refusing the exchange entirely.
3. **`'unknown'` is stated plainly, never rounded to "safe".** For an unscopable exchange the
   connect dialog says so in those words: *"CoinDCX does not offer read-only API keys. This key can
   place trades. Misal will never do so — it cannot construct a trade request — but anyone who
   obtains this key can."* For an attestable exchange, the dialog shows the checklist of settings
   the user should verify on the exchange and records the result as `attested`.
4. **Scope is re-checked before every sync, not only at connect.** A user can widen a key's
   permissions on the exchange website at any time. On Binance this costs weight 1. If withdrawal
   permission appears on a key that previously lacked it, the sync aborts, the account is marked
   `credential_quarantined`, and the user is prompted — we do not delete their data, and we do not
   keep syncing.
5. **Misal never calls a mutating endpoint to "fix" an over-scoped key.** There is no code path to
   revoke, downgrade, or rotate a key. Remediation is entirely on the exchange's website.

Mitigations we recommend but cannot enforce, surfaced as advice in the connect dialog:

- Bind the key to a static IP where the exchange supports it. On CoinDCX the binding is to the IP
  of the machine that generated the key, so the key must be generated on the machine that will run
  Misal.
- On CoinDCX, consider a sub-account holding only the tracked assets; sub-accounts have separate
  keys and separate trade histories.
- CoinDCX has no crypto-withdrawal endpoint in its API at all — off-platform withdrawal is UI-only.
  This is a meaningful mitigation and worth telling the user, but it is CoinDCX's choice, not a
  guarantee, and must not be described as one.

### Scope proposal for `credential_ref`

`credential_ref` has no column for any of this. See
[Open questions for core](#open-questions-for-core).

## Sync semantics

### State

Sync state is not in the core schema. A `sync_state` table is required; its proposed shape is in
[Open questions for core](#open-questions-for-core). The behaviour specified here assumes it.

The watermark is an **opaque string owned by the adapter**. Core stores and returns it without
interpretation. Binance's is a JSON map of symbol to last trade id; CoinDCX's is a single integer.
Keeping core ignorant of the shape is what lets a contributor add an exchange with a different
pagination model without touching the runner.

### First connect: backfill

1. `describeScope()` → apply the rules above. Abort before storing anything on refusal.
2. `serverTime()` → compute and store `clockOffsetMs`.
3. `markets()` → cache the market catalogue.
4. `fetchBalances()` → commit positions. **This happens before the trade backfill**, so the user
   sees their net worth within seconds rather than after a 40,000-trade crawl.
5. `fetchFills(cursor = null)` → page from the beginning of history, committing per page.
6. `fetchTransfers()` where supported.

Backfill is resumable by construction: it is the same loop as an incremental sync with a null
starting cursor. There is no separate backfill code path, and therefore no backfill-only bug class.

### Incremental sync

Identical, with the stored cursor. Balances are always fetched in full — no exchange offers a
balance delta, and a full balance set is small.

### Commit and watermark ordering

**The watermark advances only after the transaction that commits its page has succeeded.** Never
before, never in the same statement batch as a subsequent page. A crash between commit and
watermark update causes the next sync to re-fetch one page, and `txn.natural_key`'s unique index
makes that a no-op. The reverse ordering would silently lose a page forever, which is exactly the
failure that makes a net-worth tool untrustworthy.

### Atomicity asymmetry

- **Trades commit incrementally**, one transaction per page. A partial trade history is
  incomplete but not wrong, and it is resumable.
- **Balances commit atomically**, all assets for an `as_of` or none. A partially written balance
  set is not incomplete — it is *wrong*, and it understates net worth while looking complete.
  If the balance fetch fails partway, nothing is written and the previous day's positions stand,
  visibly stale.

### Partial and rate-limited syncs

A failed sync must never leave the store inconsistent, and "inconsistent" here means: a watermark
ahead of committed data, a partial balance set, or an `import_run` that claims success while data
is missing.

- A sync that commits at least one page finishes as `import_run.status = 'completed'` with
  non-zero `rows_failed` and one `import_issue` per failed unit. This matches the core spec's
  "partial imports commit, with failures surfaced and individually re-runnable".
- `status = 'failed'` is reserved for a sync that committed nothing.
- The account's sync state records `last_error_code` and `partial: true`, and the account manager
  shows "partially synced" with the reason rather than a green tick.
- On rate limiting mid-backfill the run stops cleanly at the last committed page, records a
  `rate_limited` issue, and schedules a retry after the exchange's stated cooldown. It does not
  spin.
- On an unresolvable asset the record is **not** an error: it goes to `unresolved_instrument` with
  its observed quantity, per the core spec, and the sync completes. The value withheld is
  reportable because `observed_value_minor` is populated where a price is known.

### Rate limiting

A token-bucket limiter per exchange, seeded from the exchange's own response headers rather than
from a hardcoded constant, because both exchanges publish live budget headers and both have
changed their documented limits.

- Read Binance's `X-MBX-USED-WEIGHT-1M` and the `REQUEST_WEIGHT` limit from
  `GET /api/v3/exchangeInfo` at startup. Do not hardcode 6,000/min.
- Read CoinDCX's undocumented but consistently present `ratelimit: limit=5000, remaining=…,
  reset=…` headers, and additionally cap at a conservative 16 requests/second — CoinDCX publishes
  four mutually contradictory limits across its docs, FAQ and help site, so the live header plus a
  conservative floor is the only defensible policy.
- Target 50% of the budget. Misal is a background tracker; there is no reason to race.
- On `429`: honour `Retry-After`, then exponential backoff with full jitter, capped at 5 attempts.
- On `418` (Binance IP ban): **stop the adapter entirely** for the stated duration and surface it
  loudly. Bans escalate from 2 minutes to 3 days for repeat offenders; retrying into one converts
  a two-minute outage into a three-day one.

### Clock skew

Both exchanges reject signed requests whose timestamp drifts too far, and a laptop resuming from
sleep is exactly the machine this happens to.

- Measure `clockOffsetMs` at sync start and apply it to every signed timestamp. Do not use the
  local clock directly.
- Binance: `GET /api/v3/time`. CoinDCX has **no server-time endpoint** — every candidate path
  404s — so use the `Date` response header from any public request. It has one-second granularity,
  which is ample against a 10-second window.
- On Binance error `-1021`, re-measure the offset **once** and retry the request **once**. If it
  fails again, fail the sync with a `clock_skew` error reporting the measured drift and telling
  the user to fix system time. Retrying indefinitely against a broken clock burns rate budget and
  hides a real machine problem.
- CoinDCX cannot be handled this way: it returns an identical `401 Invalid credentials` for a bad
  key, a stale timestamp, and a missing timestamp. So a CoinDCX `401` is reported as
  `auth_or_skew` — a deliberately compound error whose message names both possibilities — and the
  adapter re-measures the offset before the single retry. Reporting it as "invalid credentials"
  would send users to regenerate a perfectly good key.

### Error taxonomy

```ts
type AdapterErrorCode =
  | 'auth_invalid'        // terminal; needs the user
  | 'auth_or_skew'        // terminal after one retry; CoinDCX's ambiguous 401
  | 'auth_over_scoped'    // terminal; credential refused or quarantined
  | 'clock_skew'          // one automatic resync-and-retry, then terminal
  | 'rate_limited'        // retryable with backoff
  | 'ip_banned'           // adapter halted for the ban duration
  | 'network'             // retryable
  | 'upstream_unavailable'// 5xx or maintenance; retryable
  | 'malformed_response'  // page abandoned, logged as an import_issue, sync continues
  | 'blocked_by_edge';    // non-JSON 403 from a WAF; retryable, NOT an auth failure

interface AdapterError {
  readonly code: AdapterErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly message: string;         // user-facing
  readonly detail?: string;         // diagnostics pane only; never contains the secret
}
```

`blocked_by_edge` exists because CoinDCX sits behind Cloudflare, which returns a `text/plain` or
HTML 403 to clients that do not send a browser-like `User-Agent`. Parsing that as JSON throws a
decode error, and treating a 403 as an auth failure would tell the user their key is bad when the
real fix is a request header. Every adapter sets an explicit `User-Agent`.

## Instrument resolution for crypto

Crypto has no ISIN, no CUSIP, and no registrar. The core spec's resolution order
(ISIN → AMFI → exchange+symbol → provider-local) has no first three steps here.

### The identity anchor

**CoinGecko coin ids are the canonical crypto identifier**, stored as
`instrument_alias(scheme = 'coingecko', value = 'bitcoin', provider_id = NULL)`. The core schema
already lists `coingecko` as a valid scheme, so this needs no change.

Chosen because it is the only broadly-adopted identifier that is free, keyless, stable across
renames, and already covers both exchanges' listings. `/coins/list` is available on the keyless
public tier and returns `{ id, symbol, name }`, optionally with per-chain contract addresses.

### The resolution ladder

For an asset code observed on an exchange:

1. **`provider-local` alias.** `(scheme='provider-local', value='BTC', provider_id='binance')`.
   This is the fast path and the memory of every previous resolution, including ones a user
   confirmed manually in the review queue.
2. **Bundled seed catalogue.** A versioned data file in the repository mapping
   `(providerId, assetCode) → coingeckoId`, generated offline and reviewed by a human. A hit
   creates the `provider-local` alias, and either links to the existing instrument carrying that
   `coingecko` alias or creates a new instrument plus the `coingecko` alias.
3. **Miss → `unresolved_instrument`.** With `observed_quantity` populated so the UI can state the
   exact value withheld from totals.

### Why symbol matching is forbidden

Nothing in this ladder matches on ticker symbol alone, and that is the point. Crypto ticker
collisions are routine rather than exceptional — the same three or four letters are reused by
unrelated projects across exchanges, and CoinGecko's own list contains many duplicate `symbol`
values pointing at entirely different assets. Matching `(exchange, code)` against a curated table
is the only step that is safe, because a human decided that CoinDCX's `XYZ` and CoinGecko's `xyz`
are the same thing.

The catalogue is deliberately incomplete. Covering the top few hundred assets by listing on both
exchanges resolves the overwhelming majority of real balances; everything else goes to the review
queue, where the user resolves it once and the `provider-local` alias makes it permanent. An
incomplete catalogue produces a visible question. A fuzzy one produces a wrong number.

### The same asset on two exchanges

This falls out of the design rather than needing machinery. `(binance, BTC)` and `(coindcx, BTC)`
both map to CoinGecko `bitcoin`. The alias table's primary key `(scheme, value, provider_id)`
makes `('coingecko', 'bitcoin', NULL)` unique, so the second exchange's resolution finds the
existing instrument and attaches its own `provider-local` alias to it. Positions from both
exchanges then aggregate onto one instrument row, and the instrument detail screen shows
per-account positions — exactly as it does for an equity held at two brokers.

### Deliberate non-merges

- **Wrapped and bridged tokens are separate instruments.** `WBTC` is not `BTC`; they have distinct
  CoinGecko ids and distinct issuer risk. Merging them would hide a real exposure.
- **Stablecoins are `asset_class = 'crypto'`, not `'cash'`.** `USDT` carries issuer and depeg risk
  and is traded; classifying it as cash would present it as risk-free in the allocation chart.
- **Fiat balances are `asset_class = 'cash'`.** A CoinDCX `INR` balance is rupees.
- **Chain variants are one instrument.** Both exchanges report a single unified balance for an
  asset regardless of which chain it was deposited on, so there is nothing to split.

### Instrument field conventions

- `asset_class = 'crypto'`; `isin = NULL`.
- `currency = 'USD'`. Crypto is priced in USD by the price providers, and the valuation engine
  already applies USD→INR conversion for US equities. Reusing that path is simpler than a
  crypto-specific one. *Note for subsystem D:* Indian exchanges trade at a persistent premium or
  discount to the global USD price, so an INR-quoted CoinDCX fill will not reconcile exactly
  against `global USD price × FX`. That difference is real and belongs to the valuation engine.
- `precision` is taken from the exchange market catalogue's step size, clamped to `[0, 18]`,
  defaulting to 8. The core default of 4 would render a Bitcoin balance uselessly.

### Turning fills into transactions

- A fill of `BTCUSDT` is a `buy` or `sell` of the **base** asset's instrument, quantity in base
  units, `price` as the decimal string quote-per-base.
- **CoinDCX inverts the usual naming.** Its docs define *target currency* as the traded quantity
  and *base currency* as the price denomination — the opposite of the convention everywhere else.
  For `BTCINR`, CoinDCX's `target_currency_short_name` is `BTC` and its `base_currency_short_name`
  is `INR`. The adapter maps CoinDCX's *target* onto `MarketSpec.base`. Mapping it by name would
  invert every position, and would do so silently.
- Symbols are split using the exchange's market catalogue, never by string manipulation.
- **Fees paid in kind become a separate `fee` transaction** against the fee asset's instrument,
  with the trade row carrying `fees_minor = 0`. `fees_minor` is an integer in a currency's minor
  units and cannot represent `0.000114 BNB`. Only INR-denominated fees go in `fees_minor`.
- `natural_key` is computed by shared core code from the same fields as statement transactions, so
  a trade ingested from an exchange CSV and the same trade from the API deduplicate against each
  other. This matters: users import a CSV first and connect the key later.

### Reconciliation as a coverage check

After a sync, fold the ingested transactions per instrument and compare against the reported
balance. A mismatch is expected — deposits from an external wallet, staking rewards, trades in a
symbol we never queried — and is recorded as a **warning-severity `import_issue`**, not an error.

This is a feature. It measures exactly how incomplete the trade history is, and it is the evidence
behind decision 4: crypto accounts stay `snapshot` because we cannot demonstrate coverage. When
the fold matches the balance exactly across the full history, an account could be upgraded to
`ledger` and unlock XIRR — that is deferred to v2, but the check that would justify it is built now.

## Adapter: Binance

The better-behaved of the two by a wide margin: real key scoping, an endpoint that reports it,
string-typed numerics, and a published weight budget.

**Host:** `https://api.binance.com`, with `api1`–`api4` as alternates. Indian users are served by
the global host — there is no `api.binance.in`, no Indian entity, and no migration announcement
(contrast Japan, which has both). Binance.US is a separate API and is out of scope. Public market
data may be pulled from `data-api.binance.vision` to keep `exchangeInfo` weight off the
authenticated IP budget.

**Auth.** HMAC-SHA256. The API key goes in the `X-MBX-APIKEY` header. The signature is the hex
HMAC of the **exact query string as serialised**, appended as a trailing `signature` parameter —
the server re-reads the literal string, so parameter order is free but must not be re-serialised
after signing. `timestamp` in milliseconds is mandatory; `recvWindow` defaults to 5000 ms and
caps at 60000. Ed25519 and RSA keys are also supported; v1 implements HMAC only, and this matters
for scope handling (see below).

**Clock skew.** `GET /api/v3/time`. Violations return `-1021`.

**Scope introspection — the crux.**

```
GET /sapi/v1/account/apiRestrictions      weight 1
```

Returns exactly, all booleans except `createTime`:

```
ipRestrict, createTime, enableReading, enableWithdrawals, enableInternalTransfer,
enableMargin, enableFutures, permitsUniversalTransfer, enableVanillaOptions,
enableFixApiTrade, enableFixReadOnly, enableSpotAndMarginTrading,
enablePortfolioMarginTrading
```

This is the authoritative source and the only one. **`GET /api/v3/account`'s `canTrade`,
`canWithdraw` and `canDeposit` describe the *account*, not the *key*, and must never be used for
scope decisions** — a read-only key on a healthy account still reports `canWithdraw: true`. This
distinction is the single easiest way to build a scope check that silently does nothing.

Two further traps:

- Do not infer scope from `ipRestrict`. The rule that an unrestricted key is read-only applies
  **only to HMAC keys**; a self-generated Ed25519 or RSA key can hold trading permission with no
  IP restriction. Always read the booleans.
- `tradingAuthorityExpirationTime` appears in Binance's generated swagger, marked required, but
  not in the current documentation. Parse it as optional and build no logic on it.

Withdrawals additionally require an IP allowlist to enable at all, which is why decision 3 treats
their presence as deliberate rather than accidental.

**Balances.**

```
GET /api/v3/account?omitZeroBalances=true          weight 20
```

`balances[]` carries `asset`, `free`, `locked`, all **strings**. Also returns `permissions[]`,
`accountType`, `uid` (use a masked form as `account.external_ref`), and `commissionRates`.

`POST /sapi/v3/asset/getUserAsset` (weight 5, read-only despite the verb) is the richer
alternative: it returns positive balances only, adding `freeze`, `withdrawing` and `ipoable`.
Use it as the primary balance source and `/api/v3/account` for `permissions` and `uid`.

**Trade history — and its central problem.**

```
GET /api/v3/myTrades?symbol=…            weight 20 (5 when orderId is supplied)
```

Parameters: `symbol` **required**, plus `orderId`, `startTime`, `endTime`, `fromId`, `limit`
(default 500, max 1000), `recvWindow`. Valid combinations are constrained, and
**`startTime`/`endTime` may not span more than 24 hours.** Response fields — `price`, `qty`,
`quoteQty`, `commission` — are strings; `commissionAsset` names the fee asset; `time` is epoch ms.

Two consequences drive the whole design:

1. **Never backfill by time window.** A 24-hour cap means several years of history would need
   thousands of calls per symbol. Backfill by `fromId`, starting at 0, paging with
   `limit=1000` until a short page returns. The watermark is the last seen trade `id` per symbol.
2. **`symbol` is required, so we must decide which symbols to ask about.** There is no
   all-symbols trade endpoint. Brute-forcing every listed pair is thousands of calls at weight 20
   and is not acceptable.

**Symbol enumeration strategy**, in order:

1. Collect a *discovered asset set* for the account: assets with a non-zero balance, plus every
   asset seen in deposit and withdrawal history, plus every asset seen in any previously ingested
   fill or CSV import. The set only ever grows and is persisted.
2. Take `exchangeInfo` (from the data-only host) and select every symbol whose `baseAsset` or
   `quoteAsset` is in the discovered set **and** whose counter-asset is a plausible quote asset
   (`USDT`, `USDC`, `FDUSD`, `BTC`, `ETH`, `BNB`, `TUSD`, `BUSD`, plus any fiat seen in the
   account). For a typical user this is 50–200 symbols, not 3,000.
3. Query each candidate once at `fromId=0`. Symbols with no trades cost one call and are then
   recorded as empty and re-checked only when the discovered set changes.
4. Offer a manual "add a symbol to sync" control for the residual case.

**The residual gap must be stated in the UI, not hidden:** an asset that was bought and then
entirely sold, in a pair we never guessed, leaves no balance and no transfer record, so its trades
are invisible. This is a principal reason Binance accounts are `snapshot`. The reconciliation check
above will surface the discrepancy rather than absorbing it.

**Transfers.** `GET /sapi/v1/capital/deposit/hisrec` and `GET /sapi/v1/capital/withdraw/history`,
both defaulting to a 90-day window and requiring explicit `startTime`/`endTime` paging for a full
backfill. Deposit records carry `travelRuleStatus`, which became meaningful for Indian users under
the Travel Rule effective 22 June 2026 — read it, do not assume zero.

**Rate limits.** Weight-based per IP, reported in `X-MBX-USED-WEIGHT-1M`; the limit is published in
`exchangeInfo.rateLimits` and must be read from there. SAPI endpoints have a separate UID-based
budget with its own headers. `429` carries `Retry-After`; `418` is an IP ban escalating from
2 minutes to 3 days.

**Error codes.** `-1021` timestamp outside `recvWindow`; `-1022` invalid signature; `-2014` bad
API key format; `-2015` rejected key, IP, or permissions. All arrive as `{"code": …, "msg": "…"}`.

**Testing note.** The Spot testnet serves only `/api` paths, so `apiRestrictions`, transfer history
and `getUserAsset` cannot be exercised there. This is not a problem for us — see
[Testing](#testing) — but it rules out testnet as a validation route for exactly the endpoints
that matter most.

## Adapter: CoinDCX

Workable, but every part of it needs defensive handling. The published documentation's response
samples disagree with real responses in several places; where they conflict, real recorded
responses win.

**Hosts.** `https://api.coindcx.com` for everything authenticated and for
`/exchange/v1/markets_details`. `https://public.coindcx.com` for public market data. Set an
explicit `User-Agent` — Cloudflare returns a non-JSON 403 to default library user-agents.

**Auth.** HMAC-SHA256 over the **serialised JSON request body**, hex-encoded, in
`X-AUTH-SIGNATURE`, with the key in `X-AUTH-APIKEY`. Because the body is signed,
**authenticated endpoints are POSTs even when they only read.** `timestamp` (milliseconds) lives
inside the signed body; there is no `recvWindow`.

The critical implementation rule: **sign the exact bytes you transmit.** There is no
canonicalisation — no key sorting, no whitespace normalisation. Serialise once, sign that string,
send that string. The common failure in the wild is serialising for the signature and then letting
an HTTP client re-serialise the object for the wire, producing different bytes and a permanent
401. This deserves a dedicated test.

Two endpoints are genuinely GET-only and take a signed JSON body **over GET** — the futures wallet
and its transactions. Their query strings are not part of the signature. Calling them with POST
returns `404`, and calling `users/balances` with GET also returns `404`; a wrong method is
indistinguishable from a wrong path.

**Clock skew.** The documented window is 10 seconds, stated only on one page, and there is no
`recvWindow`. Parameter tables claim seconds while every code sample computes milliseconds — **use
milliseconds.** There is **no server-time endpoint**; every candidate path 404s. Use the HTTP
`Date` response header. As noted above, a bad key and a stale timestamp both return an identical
`401 Invalid credentials`, so the adapter reports `auth_or_skew`.

**Scope.** There is none. CoinDCX's own FAQ states plainly that read-only APIs are not offered and
that all API users have the same permissions. There is no endpoint that reports a key's scope, and
there cannot be: a key that authenticates is a full-access key. `describeScope()` therefore returns
`verification: 'unscopable'` with `canTrade: true` and `canWithdraw: false` — the latter because
CoinDCX exposes no crypto-withdrawal endpoint at all, which is a genuine structural limit rather
than a permission. CoinDCX's *blog* claims read-only keys and per-key permissions exist; it
contradicts the FAQ and the actual key-creation form, which offers only a label and an optional
IP binding. **Do not build against the blog.**

**Balances.**

```
POST /exchange/v1/users/balances     body {"timestamp": <ms>}
```

Returns `currency`, `balance`, `locked_balance`. Real responses return these as **strings**; the
documentation sample shows numbers. Accept both and coerce. Total holding is
`balance + locked_balance` — `balance` is only the usable portion, and treating it as the total
understates any asset with an open order against it. Whether zero-balance currencies are returned
is undocumented; filter client-side.

**Trade history.**

```
POST /exchange/v1/orders/trade_history
  { timestamp, limit, from_id, sort, symbol?, from_timestamp?, to_timestamp? }
```

`limit` defaults to 500 and is documented to 5000, though practitioners cap at 500; use 500.
`from_id` is an **exclusive** cursor — "the trade id after which you want the data" — and only
coheres with `sort: 'asc'`. `symbol` is optional, and **omitting it returns fills across all
symbols**, which is a real advantage over Binance: no symbol enumeration problem exists here.

Backfill: `sort: 'asc'`, `limit: 500`, `from_id` advancing to the last `id` of each page,
terminating on a short page. The watermark is that single integer.

Response fields: `id` (number), `order_id`, `side`, `symbol`, `quantity`, `price` and `fee_amount`
as **14-decimal strings**, and `timestamp` as a **fractional-millisecond float** — truncate it as
a string. `created_at` is polymorphic across ISO-8601 and epoch milliseconds depending on
endpoint and vintage; handle both.

**Transfers.** Not documented. `POST /exchange/v1/wallets/deposits` and
`POST /exchange/v1/wallets/withdrawals` are live routes — they answer `401` to a bogus signature
where non-existent paths answer `404`, and path-exact controls confirm the routing — but no
public source documents their request or response shape. **v1 does not implement
`fetchTransfers` for CoinDCX.** The endpoints are recorded here as the first thing to probe once a
real key is available; confirming them would close the largest gap in CoinDCX coverage. Do not
confuse them with `/api/v1/wallets/deposits`, which is a different auth surface backed by a web
session cookie and will not accept an API key.

**Markets.** `GET /exchange/v1/markets_details` returns roughly a thousand markets with
`coindcx_name`, `symbol`, `pair`, `ecode`, `base_currency_short_name`,
`target_currency_short_name`, precisions and `step`. Use `symbol` for joins against
`trade_history.symbol`; `pair` (`I-BTC_INR`) is what WebSocket, public market data and all futures
endpoints want. Remember the inverted target/base naming. Numerics here are **JSON numbers in
scientific notation** (`1e-05`) — another reason for a lossless parser. Cache daily.

**Rate limits.** Four contradictory published figures. Use the live `ratelimit` response headers
plus a conservative 16 req/s cap. Note that error responses may omit the headers, so the limiter
must tolerate their absence. `429` body shape is unconfirmed; treat any 429 as rate limiting
regardless of body.

**Other traps worth encoding in the adapter:**

- The `orders/*` family sits behind a different gateway from `users/*` and adds an `errorCode`
  field to error bodies. Its rate limits may not match the documented table.
- No TDS or tax fields exist anywhere in the API, despite CoinDCX being an Indian exchange with
  a statutory TDS obligation. Indian tax figures must be derived from fills, or imported from
  CoinDCX's CSV export. This is a real gap for Indian users and belongs in the UI as such.
- No fee-tier endpoint exists.
- `HEAD` returns 404 where `GET` returns 200 — do not health-check with `HEAD`.
- CCXT does **not** support CoinDCX; the open pull request is unmerged and contains real bugs.
  The one published third-party OpenAPI spec lists paths that 404. Do not generate a client from
  either.
- Keys created before roughly mid-2024 silently lack access to newer endpoints. If an endpoint
  404s for one user and works for another, key age is the first thing to check.

## Researched, not implemented

Both are documented here so that a future contributor starts from evidence rather than from the
search results, which are misleading for both.

### CoinSwitch (CoinSwitch PRO)

Current, actively maintained docs at `api-trading.coinswitch.co`; the old `developer.coinswitch.co`
hub no longer resolves and every third-party guide referencing it is dead. Operated by Bitkuber
Investments Pvt Ltd. Access is self-serve — no waitlist, no IP allowlist, no key registration —
with keys generated behind an OTP to the registered mobile.

**Auth is Ed25519, not HMAC.** Headers `X-AUTH-APIKEY` (public key, hex), `X-AUTH-SIGNATURE`
(hex), `X-AUTH-EPOCH` (Unix ms). The signed message is `METHOD + path_with_query + epoch`, where
the path is **URL-decoded** — literal commas and slashes, not percent-encoded — and excludes
scheme and host. The body is not signed when an epoch is present. Drift beyond 60 s is rejected;
±5 s is recommended. `GET /trade/api/v2/time` needs no auth.

Base URL `https://coinswitch.co/trade/api/v2`. Balances at `GET /trade/api/v2/user/portfolio`,
returning per-asset `currency`, `main_balance`, `blocked_balance_order`, `buy_average_price`,
`invested_value`, `current_value`. Order history at `GET /trade/api/v2/orders?open=false`.
`GET /trade/api/v2/tds` returns cumulative INR TDS by financial year, which is more than CoinDCX
offers. Note that `/trade/api/v2/trades` is **public market trades**, not the user's fills — an
easy and expensive misreading. Rate limits are generous (portfolio 5,000 per 10 s).

**Why it is not in v1:**

- **No read-only keys and no permission model**, same as CoinDCX.
- **Exactly one key pair may be active per account.** Generating a new pair invalidates the old
  one, so Misal would compete for the single key with any other tool the user runs, and rotation
  has no overlap window. This is worse than CoinDCX and is the deciding factor.
- **Closed-order history is capped at the latest 500 records**; older history requires emailing
  support. A tracker cannot backfill.
- Balance rows quote crypto amounts as strings and the INR row as numbers, in the same response.
- An unauthenticated call to `/user/portfolio` returns `500`, not `401`.

### WazirX

The news cycle is misleading here, and the technical reality inverts it: **WazirX is the
better-scoped API of the four, and the risk is semantic rather than technical.**

Status: the July 2024 Liminal hack was followed by a Singapore scheme of arrangement, sanctioned
13 October 2025 and effective 15 October, with operations moving to Zanmai Labs (India) rather than
the abandoned Panama entity. The platform relaunched 24 October 2025; Recovery Tokens were
allocated 9 January 2026; futures launched March 2026 with a futures API in July 2026. Withdrawals
are enabled — the widely-cited "withdrawals still blocked" reporting describes only the phased
re-enablement window in late October 2025.

API at `https://api.wazirx.com`, docs maintained and expanding. Auth is **HMAC-SHA256 with the key
in `X-API-KEY`**, signature over `totalParams` passed as a `signature` parameter, with `timestamp`
in ms and `recvWindow` (default 5000, max 60000). Endpoints: `GET /sapi/v1/funds`
(`asset`/`free`/`locked`/`reservedFee`), `GET /sapi/v2/funds?wallets=spot&wallets=futures`,
`GET /sapi/v1/account` (including a `canWithdraw` boolean), `GET /sapi/v1/myTrades`,
`GET /sapi/v1/allOrders`. Rate limit is **1 request/second** on general endpoints — the binding
constraint — with `429` then an escalating `418` IP ban.

**Key scoping is the best of the four: read-only is the default.** Trading rights must be
explicitly enabled, wallet transfer is off by default, crypto withdrawal is invite-only, IP
allowlisting is supported, and five keys per account allow clean rotation.

**Why it is not in v1, despite that:**

- **Reported balances are post-haircut and do not mean what they appear to.** Liabilities were
  frozen at 18 July 2024 prices; the first distribution returned roughly 85% of each claim, with
  some illiquid tokens settled in USDT instead of the original asset. Balances today are restated
  quantities, not the user's original holdings.
- **Recovery Tokens — the residual ~15% — are almost certainly invisible to the API.** They appear
  on the app's funds page; the documented fund schemas expose only `asset`/`free`/`locked`/
  `reservedFee`, and no Recovery Token base asset appears in `exchangeInfo`. They are not tradable,
  transferable or withdrawable, and no buyback has been announced.
- Consequently any cost basis or P&L derived by comparing API balances against pre-July-2024
  records is wrong by roughly the haircut plus token-substitution effects. Presenting that without
  a prominent annotation would violate the honest-metrics rule, and designing that annotation is
  work v1 does not need to carry.
- Official SDKs are abandoned (last released 2022), though the REST docs are current.

If WazirX is implemented later, the adapter is mechanically easy; the design work is entirely in
how the UI states what the numbers mean.

## Testing

No test may open a network socket, and no real API key may exist anywhere in the repository. Both
are enforced, not merely intended.

**Recorded fixtures.** Each adapter has `tests/fixtures/adapters/<exchange>/`, containing recorded
request/response pairs as JSON: status, headers, and body, one file per interaction, named for the
scenario. Adapters receive their transport through `AdapterContext.http`, so tests inject a replay
transport that matches on method, path and signed-body/query shape and returns the recorded
response. The real transport is not constructible in the test environment; a global guard fails any
test that attempts a DNS lookup or socket open, so a future adapter cannot quietly reintroduce a
live call.

**Fixture hygiene.** Fixtures are recorded once against a real account and then passed through a
scrubber that replaces uids, emails, deposit addresses and account identifiers with stable fakes,
and rewrites balances to synthetic values. CI runs a secret scan over the whole repository plus a
targeted grep for anything resembling a key — long hex or base64 runs, and each exchange's key
prefixes. The corpus is redacted or synthetic, exactly as the statement corpus is.

**Signing.** Known-answer tests for each signing scheme, using each exchange's own published
example key, secret and expected signature where one exists, and a fixed fake pair otherwise.
These are public, non-functional values by construction.

CoinDCX gets one additional, mandatory test: **assert that the bytes transmitted are byte-identical
to the bytes signed.** It is the failure that breaks every naive CoinDCX client, and it is
invisible to any test that only checks the signature function in isolation.

**Conformance suite.** A single adapter-agnostic test suite that every adapter must pass, so
adding an exchange means writing an adapter and a fixture directory rather than a test plan:

- Every `requestAllowlist` entry is non-mutating; no allowlist contains an order, transfer or
  withdrawal path.
- Every quantity in every fixture round-trips through the adapter as an exact decimal string,
  including trailing zeros and an 18-decimal value.
- `fetchFills` terminates, is monotonic in its cursor, and never returns the same `externalId`
  twice within a run.
- Replaying the entire fixture sync twice produces identical row counts — the idempotency rule,
  applied to adapters.
- Symbol splitting uses the market catalogue: a fixture containing a symbol whose base asset code
  contains its quote asset code must still split correctly.

**Behavioural tests, per adapter:**

- **Over-scoped key.** An `apiRestrictions` fixture with `enableWithdrawals: true` causes connect
  to abort with `auth_over_scoped` and **nothing written to the keychain** — asserted by reading
  the keychain afterwards, not by trusting the return value. A second fixture with
  `enableSpotAndMarginTrading: true` stores the credential but records the warning and requires
  acknowledgement. A third fixture flips withdrawals on mid-life and asserts the account is
  quarantined rather than synced.
- **Scope confusion.** A fixture where `/api/v3/account` reports `canWithdraw: true` while
  `apiRestrictions` reports `enableWithdrawals: false` asserts the credential is **accepted** —
  the guard against a scope check that reads the wrong field and rejects every valid key.
- **Clock skew.** A fixture returning `-1021` asserts exactly one resync-and-retry, then a typed
  `clock_skew` error carrying the measured drift. A CoinDCX `401` fixture asserts `auth_or_skew`
  and that the message names both possibilities.
- **Rate limiting.** A `429` with `Retry-After` asserts the limiter waits and loses no data. A
  `418` asserts the adapter halts and does not retry.
- **Partial sync.** Page 1 succeeds, page 2 returns `500`. Assert: page 1's rows are committed,
  the watermark sits at page 1, `import_run.status = 'completed'` with non-zero `rows_failed`, an
  `import_issue` exists, and a re-run resumes from page 1 and produces no duplicates.
- **Atomic balances.** A balance response that fails mid-parse asserts that **no** `position` row
  was written for that `as_of` and that the previous day's positions are intact.
- **Lossless numerics.** A CoinDCX fixture containing a raw JSON float with 17 significant digits
  asserts the parsed value retains every digit.
- **Edge block.** A non-JSON Cloudflare 403 asserts `blocked_by_edge`, not `auth_invalid`.

**Resolution tests.** A fixture containing an asset code absent from the seed catalogue asserts a
row in `unresolved_instrument` with `observed_quantity` populated, and that the sync still
completes. A fixture holding BTC on both exchanges asserts a single `instrument` row with two
`provider-local` aliases and one `coingecko` alias. A fixture containing two different assets that
share a ticker symbol asserts they resolve to two instruments, or to the review queue — never
merged.

## Open questions for core

Three things subsystem C needs that the fixed schema does not provide. None is worked around here;
all three need a core decision and a migration.

**1. Sync state has nowhere to live.** There is no table for watermarks, and the v1 design's
account manager requires a "last synced" figure. Proposed:

```sql
CREATE TABLE sync_state (
  account_id      TEXT PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  cursor          TEXT,            -- opaque, adapter-owned
  discovered_assets TEXT,          -- JSON array; Binance symbol enumeration
  last_synced_at  TEXT,
  last_status     TEXT,            -- 'ok' | 'partial' | 'failed' | 'quarantined'
  last_error_code TEXT,
  backfill_complete INTEGER NOT NULL DEFAULT 0
);
```

**2. `txn.currency` cannot express a crypto quote asset.** It is `NOT NULL` and is otherwise an
ISO-4217 code with a minor-unit exponent from a static table. A `BTCUSDT` fill is denominated in
USDT, which has no ISO code and no minor units, so `amount_minor` is meaningless for it. Proposed
convention, needing core's agreement: non-fiat quote assets are recorded as `'X:USDT'`, and
`amount_minor` is left `NULL` (it already permits it) with `price` carrying the full-precision
decimal string. The `X:` prefix is chosen because ISO 4217 already reserves `X` for codes that are
not national currencies, so it cannot collide with a real currency code. INR-quoted CoinDCX fills
are unaffected and use `'INR'` with real minor units.

**3. `provider.country` has no value for a global exchange.** The column is free-form `TEXT`, so
`'GL'` works without a migration, but the convention should be recorded in the provider registry
rather than invented per-adapter. CoinDCX is `'IN'`; Binance is `'GL'`.

A fourth, smaller item: `credential_ref` has no column for the scope report, so the account
manager cannot render the over-scoped badge across restarts. Adding
`scope_verification TEXT`, `scope_flags TEXT` (JSON) and `acknowledged_at TEXT` to `credential_ref`
would be sufficient, and stores no secret.

## Out of scope

**Indian broker APIs.** Zerodha, Groww, Upstox, Angel One, Dhan and Fyers all expire their access
token daily by SEBI mandate, with no long-lived refresh token. An adapter for any of them could not
run unattended, which is the entire premise of this subsystem — it would instead demand a manual
login before every sync. Statement ingestion covers these holdings.

**US broker APIs.** E\*TRADE issues per-user OAuth keys that expire daily; Fidelity has no public
API at all; the remainder are export-only. Same reasoning.

**CoinSwitch and WazirX adapters.** Researched above, deliberately not built, for the reasons given
in each section.

**Also out of scope for v1:**

- Futures, margin, options and any derivative position on either exchange. Spot balances and spot
  fills only. CoinDCX's futures endpoints use a different pagination model, a different symbol
  format and JSON floats throughout, and would roughly double the adapter's surface.
- **Earn, staking, savings and lending balances.** Binance holds these outside the spot account, so
  they do not appear in `/api/v3/account` or `getUserAsset`. This means a Binance balance may
  **understate** what the user holds, and the account view must say so rather than implying the
  figure is complete. Naming this gap is in scope; closing it is not.
- CoinDCX deposit and withdrawal history, pending confirmation of the undocumented endpoints.
- WebSockets. Sync is poll-only. A background refresh every few minutes is ample for a net-worth
  tracker and avoids a persistent connection holding a credential in memory.
- Order placement, cancellation, transfers and withdrawals — **permanently**, not merely in v1.
  Misal is read-only by construction, and the request allowlist is the mechanism.
- Tax computation, including TDS. Neither exchange exposes it; deriving it belongs to a later
  subsystem, not to the adapter.
- On-chain wallet addresses and NFTs. Exchange accounts only.
