# Subsystem A — Core schema and storage

**Status:** draft
**Date:** 2026-08-12
**Depends on:** [v1 design](2026-08-12-misal-v1-design.md)
**Blocks:** every other subsystem

This is the contract. Ingestion, valuation and the UI all read and write these structures, so this
document is fixed before any of them are implemented.

## Non-negotiables

1. **No floating-point arithmetic anywhere near money or quantities.** Ever.
2. **No secret is written to the database or to any export.** Secrets live only in the OS keychain.
3. **Every stored fact points at the document it came from.** A row without provenance is a bug.
4. **Re-importing the same document changes nothing.** Idempotency is enforced in the schema, not
   left to callers.

## Numeric representation

The single most consequential decision in this subsystem. Getting it wrong corrupts every figure
downstream, silently.

### Money

Stored as **integer minor units** in a signed 64-bit column, alongside an ISO-4217 currency code.
Paise for INR, cents for USD.

```
amount_minor  INTEGER NOT NULL      -- e.g. 483215000 = ₹48,32,150.00
currency      TEXT    NOT NULL      -- 'INR', 'USD'
```

The exponent per currency comes from a static table, not from the data. INR and USD are both 2.
Signed 64-bit holds ~₹9.2 × 10^16 in paise, which is beyond any plausible personal portfolio.

### Quantities

Money's approach does not work here. Mutual fund units carry 3–4 decimals, and crypto carries up to
18 — a single ETH balance in wei overflows int64. Quantities are therefore stored as
**canonical decimal strings** in TEXT:

```
quantity  TEXT NOT NULL   -- '12.3450', '0.00000042', '-3'
```

Rules: no exponent notation, no thousands separators, optional leading `-`, at most one `.`.
Trailing zeros are preserved as written because they carry significance in fund statements.

All arithmetic on quantities happens through a decimal library (`decimal.js` in TypeScript),
never through `Number`. **A lint rule must fail the build on `parseFloat`, `Number(` or unary `+`
applied to a quantity or amount field.** This is cheap to enforce now and impossible to retrofit
once wrong values are in users' databases.

### Prices

A price is money per unit, and needs more precision than minor units allow — a NAV of ₹412.3456 is
routine. Stored as a decimal string with an explicit currency, same rules as quantities.

### Rounding

Rounding happens only at the display boundary, never in storage or intermediate computation. The
valuation engine returns full-precision decimals; formatting rounds half-up to the currency's
exponent.

## Schema

SQLite. `PRAGMA foreign_keys = ON`. All timestamps are **UTC ISO-8601 strings with an explicit
offset**; a separate column records the original timezone where a source document carried one, so
Indian trade dates never shift across a date boundary during conversion.

### provider

Static registry, seeded by the application, not user-editable.

```sql
CREATE TABLE provider (
  id            TEXT PRIMARY KEY,        -- 'nsdl-cas', 'cams-cas', 'coindcx', 'zerodha-kite'
  display_name  TEXT NOT NULL,
  kind          TEXT NOT NULL,           -- 'statement' | 'exchange-api' | 'broker-api'
  country       TEXT NOT NULL            -- 'IN', 'US'
);
```

### account

```sql
CREATE TABLE account (
  id            TEXT PRIMARY KEY,        -- uuid
  provider_id   TEXT NOT NULL REFERENCES provider(id),
  label         TEXT NOT NULL,           -- user-facing, e.g. 'Zerodha Kite'
  external_ref  TEXT,                    -- demat/folio/account number, may be masked
  capability    TEXT NOT NULL            -- 'ledger' | 'snapshot'
                CHECK (capability IN ('ledger','snapshot')),
  base_currency TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  archived_at   TEXT
);
```

`capability` is the flag the UI reads to decide which metrics may be shown. It is set by the
ingestion path, not by the user.

### instrument and instrument_alias

The hardest problem in the project, isolated into two tables.

```sql
CREATE TABLE instrument (
  id            TEXT PRIMARY KEY,        -- uuid
  asset_class   TEXT NOT NULL            -- 'indian_equity' | 'mutual_fund' | 'us_equity'
                                         -- | 'crypto' | 'gold' | 'bond' | 'cash'
                CHECK (asset_class IN ('indian_equity','mutual_fund','us_equity',
                                       'crypto','gold','bond','cash')),
  display_name  TEXT NOT NULL,
  isin          TEXT,                    -- canonical where it exists
  currency      TEXT NOT NULL,           -- currency the instrument is denominated in
  precision     INTEGER NOT NULL DEFAULT 4,  -- display precision for quantity
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_instrument_isin ON instrument(isin) WHERE isin IS NOT NULL;

CREATE TABLE instrument_alias (
  instrument_id TEXT NOT NULL REFERENCES instrument(id) ON DELETE CASCADE,
  scheme        TEXT NOT NULL,           -- 'isin' | 'nse' | 'bse' | 'amfi' | 'ticker'
                                         -- | 'coingecko' | 'provider-local'
  value         TEXT NOT NULL,
  provider_id   TEXT REFERENCES provider(id),  -- non-null when scheme='provider-local'
  PRIMARY KEY (scheme, value, provider_id)
);
```

Resolution order when ingesting a raw record: ISIN → AMFI scheme code → exchange+symbol →
provider-local alias. **A miss creates a row in `unresolved_instrument`, never a guessed match and
never a new instrument.** The uniqueness constraint on `(scheme, value, provider_id)` is what makes
a wrong alias impossible to insert twice, and `provider_id` keeps E\*TRADE's `INFY` (the US ADR)
from colliding with Zerodha's `INFY` (the NSE line).

### unresolved_instrument

```sql
CREATE TABLE unresolved_instrument (
  id                TEXT PRIMARY KEY,
  source_document_id TEXT NOT NULL REFERENCES source_document(id) ON DELETE CASCADE,
  account_id        TEXT NOT NULL REFERENCES account(id),
  raw_identifier    TEXT NOT NULL,
  raw_name          TEXT,
  observed_quantity TEXT,
  observed_value_minor INTEGER,
  currency          TEXT,
  first_seen_at     TEXT NOT NULL,
  resolved_at       TEXT,
  resolved_instrument_id TEXT REFERENCES instrument(id)
);
```

Holding `observed_value_minor` is what lets the UI state the exact amount withheld from totals,
which the mockups display. Without it the coverage figure would be a guess.

### source_document

```sql
CREATE TABLE source_document (
  id            TEXT PRIMARY KEY,
  account_id    TEXT REFERENCES account(id),
  provider_id   TEXT NOT NULL REFERENCES provider(id),
  kind          TEXT NOT NULL,           -- 'cas-pdf' | 'csv' | 'api-response'
  content_hash  TEXT NOT NULL UNIQUE,    -- sha256 of raw bytes
  original_name TEXT,
  period_start  TEXT,
  period_end    TEXT,
  imported_at   TEXT NOT NULL,
  page_ref      TEXT                     -- feeds the UI source stamp, e.g. 'p.4-9'
);
```

The `UNIQUE` on `content_hash` is the first line of idempotency: the same file cannot be imported
twice. `page_ref` exists specifically to populate the marginal source stamp in the UI.

**Raw document bytes are never stored.** Only the hash and metadata. A user's CAS PDF stays wherever
they put it; Misal records that it read it, not the contents.

### txn

```sql
CREATE TABLE txn (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES account(id),
  instrument_id   TEXT NOT NULL REFERENCES instrument(id),
  type            TEXT NOT NULL
                  CHECK (type IN ('buy','sell','dividend','split','bonus',
                                  'transfer_in','transfer_out','fee','interest','tds')),
  occurred_at     TEXT NOT NULL,         -- UTC ISO-8601
  occurred_tz     TEXT,                  -- original timezone, e.g. 'Asia/Kolkata'
  quantity        TEXT NOT NULL,         -- decimal string, signed
  price           TEXT,                  -- decimal string, per unit, null for splits/bonuses
  amount_minor    INTEGER,               -- gross consideration
  fees_minor      INTEGER NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL,
  fx_rate         TEXT,                  -- to base currency, at transaction time
  source_document_id TEXT NOT NULL REFERENCES source_document(id) ON DELETE CASCADE,
  natural_key     TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_txn_natural ON txn(natural_key);
CREATE INDEX idx_txn_account_time ON txn(account_id, occurred_at);
CREATE INDEX idx_txn_instrument   ON txn(instrument_id, occurred_at);
```

`natural_key` is the second line of idempotency and the one that matters when statements overlap:
a deterministic hash of `account_id | instrument_id | type | occurred_at(date) | quantity |
amount_minor`. Overlapping CAS periods covering the same trade produce the same key, and the
`UNIQUE` index makes the duplicate insert a no-op rather than a doubled holding.

Storing `fx_rate` per transaction is deliberate. XIRR on USD holdings must use the rate on each
vest date, not today's rate; a single portfolio-wide conversion would produce a materially wrong
annualised return.

### position

Authoritative for snapshot accounts, derived for ledger accounts.

```sql
CREATE TABLE position (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES account(id),
  instrument_id TEXT NOT NULL REFERENCES instrument(id),
  quantity      TEXT NOT NULL,
  as_of         TEXT NOT NULL,
  source_document_id TEXT NOT NULL REFERENCES source_document(id) ON DELETE CASCADE,
  UNIQUE (account_id, instrument_id, as_of)
);
```

### price and fx_rate

```sql
CREATE TABLE price (
  instrument_id TEXT NOT NULL REFERENCES instrument(id) ON DELETE CASCADE,
  as_of         TEXT NOT NULL,           -- date
  close         TEXT NOT NULL,           -- decimal string
  currency      TEXT NOT NULL,
  source        TEXT NOT NULL,           -- 'amfi' | 'twelvedata' | 'manual'
  fetched_at    TEXT NOT NULL,
  PRIMARY KEY (instrument_id, as_of)
);

CREATE TABLE fx_rate (
  base       TEXT NOT NULL,
  quote      TEXT NOT NULL,
  as_of      TEXT NOT NULL,
  rate       TEXT NOT NULL,
  source     TEXT NOT NULL,
  PRIMARY KEY (base, quote, as_of)
);
```

`source = 'manual'` supports the manual price override feature and must be preferred over fetched
values for the same key.

### import_run and import_issue

Backs the import report screen.

```sql
CREATE TABLE import_run (
  id            TEXT PRIMARY KEY,
  source_document_id TEXT NOT NULL REFERENCES source_document(id) ON DELETE CASCADE,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL,           -- 'running' | 'completed' | 'failed'
  rows_read     INTEGER NOT NULL DEFAULT 0,
  rows_committed INTEGER NOT NULL DEFAULT 0,
  rows_duplicate INTEGER NOT NULL DEFAULT 0,
  rows_failed   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE import_issue (
  id            TEXT PRIMARY KEY,
  import_run_id TEXT NOT NULL REFERENCES import_run(id) ON DELETE CASCADE,
  row_ref       TEXT,                    -- e.g. 'p.7 r.12'
  severity      TEXT NOT NULL,           -- 'error' | 'warning'
  code          TEXT NOT NULL,
  message       TEXT NOT NULL,
  raw_payload   TEXT                     -- JSON of the offending row, for re-run
);
```

A partial import is a first-class outcome: `status = 'completed'` with a non-zero `rows_failed`.
`raw_payload` is what makes an individual row re-runnable after the user fixes a mapping.

## Encryption and secrets

**Database.** SQLite with SQLCipher, AES-256. The database key is a 32-byte random value generated
on first run.

**Where the key lives.** The OS keychain — macOS Keychain, Windows Credential Manager, Linux Secret
Service — under service `dev.misal.app`, account `db-key`. Never on disk in any other form, never in
a config file, never in an environment variable.

**Broker and exchange secrets.** Same keychain, keyed `secret/<account-id>`. The database stores
only a reference, never the secret:

```sql
CREATE TABLE credential_ref (
  account_id   TEXT PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  keychain_key TEXT NOT NULL,
  kind         TEXT NOT NULL,           -- 'api-key-secret' | 'oauth-token'
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);
```

Deleting an account must delete its keychain entry, not merely the row. This is a `Drop`
responsibility in the Rust layer and needs an explicit test.

**Linux caveat.** Secret Service requires a running keyring daemon, which headless and minimal
window managers may lack. Fall back to a passphrase-derived key (Argon2id) prompted at launch, and
say so plainly in the UI rather than silently storing the key unprotected.

**Exports never contain secrets.** The CSV/JSON export walks a whitelist of columns; `credential_ref`
is not exportable.

## Migrations

Forward-only, numbered SQL files in `migrations/NNNN-name.sql`, applied in a transaction, tracked
in a `schema_migration` table. Because this database holds data the user cannot re-derive — hand-
entered corrections, resolved instrument mappings — **every migration that drops or narrows a
column must be preceded by an automatic backup** of the encrypted file to a timestamped sibling.
No exceptions and no "this one is safe".

## Data-access layer

The Rust core exposes a narrow command surface to TypeScript; the UI never issues SQL.

Boundary rules:

- All writes go through a repository function that owns its transaction. No partially-applied
  imports.
- Reads return plain serialisable records. No lazy handles across the IPC boundary.
- Numeric fields cross the boundary as **strings**, never JSON numbers, because JSON numbers are
  doubles and would silently destroy the precision this whole section exists to protect.

## Testing

- **Numeric property tests**: round-tripping any decimal string through storage and the decimal
  library returns exactly the input, including trailing zeros.
- **Idempotency test**: importing the same document twice, and importing two overlapping documents
  covering a shared trade, both leave transaction counts unchanged after the first.
- **Keychain test**: deleting an account removes the keychain entry, verified by attempting a read.
- **Migration test**: every migration runs against a fixture database seeded at the previous
  version, and the pre-migration backup exists afterwards.
- **Export test**: no export output contains any value present in the keychain.

## Out of scope

Sync, the pairing protocol, and any multi-profile support. v1 is one profile on one machine. The
schema does not carry a `user_id`, and adding one later is a migration rather than a redesign.
