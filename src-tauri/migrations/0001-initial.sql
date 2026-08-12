-- Misal initial schema.
--
-- Conventions, applied throughout:
--   * Money is an INTEGER count of a currency's minor unit, always beside a currency column.
--   * Quantities, prices and rates are TEXT decimal strings. Never REAL. SQLite's REAL is a
--     float64 and would defeat the entire numeric design.
--   * Timestamps are TEXT, UTC ISO-8601 with an explicit offset. Where a source document carried
--     a local timezone, it is preserved alongside so an Indian trade date never shifts a day.
--   * Every fact carries the source_document it came from.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Registry
-- ---------------------------------------------------------------------------

CREATE TABLE provider (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  -- Three-letter code shown in the UI's marginal source stamp (CAS, KIT, GRW, DCX, ETR).
  -- Lives here rather than in the UI so a new provider ships its own stamp.
  short_code    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('statement', 'exchange-api', 'broker-api')),
  country       TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_provider_short_code ON provider(short_code);

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

CREATE TABLE account (
  id            TEXT PRIMARY KEY,
  provider_id   TEXT NOT NULL REFERENCES provider(id),
  label         TEXT NOT NULL,
  external_ref  TEXT,

  -- Realm-qualified account identity, e.g. 'mf-folio:HDFC:12345678/91' or 'demat:IN30001234'.
  --
  -- The same mutual fund folio appears in BOTH a CAMS statement and an NSDL eCAS. Keyed on
  -- (provider, external_ref) those would be two accounts holding the same units, and net worth
  -- would double. The identity key is therefore provider-independent and unique across the
  -- whole database, so the second document recognises the account the first created.
  identity_key  TEXT,

  -- Decides which metrics may be displayed AND whether Subsystem D may fold transactions into
  -- positions at all. 'ledger' requires a complete history: a CAMS/KFin Detailed statement from
  -- inception with zero opening balances and passing running-balance checksums. A depository
  -- eCAS covers only one month, so it is always 'snapshot' despite containing transactions.
  capability    TEXT NOT NULL CHECK (capability IN ('ledger', 'snapshot')),
  base_currency TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  archived_at   TEXT
);

CREATE INDEX idx_account_provider ON account(provider_id);
CREATE UNIQUE INDEX idx_account_identity ON account(identity_key) WHERE identity_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Instruments and identity resolution
-- ---------------------------------------------------------------------------

CREATE TABLE instrument (
  id            TEXT PRIMARY KEY,
  asset_class   TEXT NOT NULL CHECK (asset_class IN (
                  'indian_equity', 'mutual_fund', 'us_equity',
                  'crypto', 'gold', 'bond', 'cash')),
  -- Indian capital gains treatment depends on more than asset class: an equity-oriented fund,
  -- a section 50AA specified fund and a gold fund are all 'mutual_fund' but taxed differently.
  -- Without this, every fund's realised gain would have to report an unknown tax regime.
  tax_regime    TEXT CHECK (tax_regime IN (
                  'listed_equity', 'equity_oriented_fund', 'specified_fund',
                  'other_fund', 'vda', 'unlisted', 'debt')),
  display_name  TEXT NOT NULL,
  isin          TEXT,
  currency      TEXT NOT NULL,
  precision     INTEGER NOT NULL DEFAULT 4,
  -- Fair market value on 31 Jan 2018, for LTCG grandfathering under section 112A.
  -- This is the HIGHEST quoted price on that date, not the close.
  fmv_31jan2018 TEXT,
  created_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_instrument_isin ON instrument(isin) WHERE isin IS NOT NULL;
CREATE INDEX idx_instrument_asset_class ON instrument(asset_class);

CREATE TABLE instrument_alias (
  instrument_id TEXT NOT NULL REFERENCES instrument(id) ON DELETE CASCADE,
  scheme        TEXT NOT NULL CHECK (scheme IN (
                  'isin', 'nse', 'bse', 'amfi', 'ticker', 'coingecko', 'provider-local')),
  value         TEXT NOT NULL,
  -- Non-null for provider-local schemes. Keeps E*TRADE's INFY (the US ADR) from colliding
  -- with Zerodha's INFY (the NSE line) - a collision that would silently merge two holdings.
  provider_id   TEXT REFERENCES provider(id),
  PRIMARY KEY (scheme, value, provider_id)
);

CREATE INDEX idx_alias_instrument ON instrument_alias(instrument_id);

-- ---------------------------------------------------------------------------
-- Provenance
-- ---------------------------------------------------------------------------

CREATE TABLE source_document (
  id            TEXT PRIMARY KEY,
  account_id    TEXT REFERENCES account(id) ON DELETE CASCADE,
  provider_id   TEXT NOT NULL REFERENCES provider(id),
  kind          TEXT NOT NULL CHECK (kind IN ('cas-pdf', 'csv', 'api-response')),
  -- First line of idempotency: the same file cannot be imported twice.
  -- Raw bytes are deliberately NOT stored; only the hash and metadata.
  content_hash  TEXT NOT NULL UNIQUE,
  original_name TEXT,
  period_start  TEXT,
  period_end    TEXT,
  imported_at   TEXT NOT NULL,
  -- Secondary reference under the UI source stamp, e.g. 'p.4-9', 'r.318', 'api key'.
  page_ref      TEXT
);

CREATE INDEX idx_source_document_account ON source_document(account_id);

-- ---------------------------------------------------------------------------
-- Ledger
-- ---------------------------------------------------------------------------

CREATE TABLE txn (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  instrument_id   TEXT NOT NULL REFERENCES instrument(id),
  type            TEXT NOT NULL CHECK (type IN (
                    'buy', 'sell', 'dividend', 'split', 'bonus',
                    'transfer_in', 'transfer_out', 'fee', 'interest', 'tds')),
  occurred_at     TEXT NOT NULL,
  occurred_tz     TEXT,
  quantity        TEXT NOT NULL,
  price           TEXT,
  amount_minor    INTEGER,

  -- Fees are decomposed because section 48 allows brokerage as a cost of transfer but
  -- expressly disallows STT. A single fees_minor column would make correct capital gains
  -- impossible to compute without re-parsing the source.
  brokerage_minor INTEGER NOT NULL DEFAULT 0,
  stt_minor       INTEGER NOT NULL DEFAULT 0,
  gst_minor       INTEGER NOT NULL DEFAULT 0,
  stamp_duty_minor INTEGER NOT NULL DEFAULT 0,
  other_fees_minor INTEGER NOT NULL DEFAULT 0,
  tds_minor       INTEGER NOT NULL DEFAULT 0,

  currency        TEXT NOT NULL,
  -- Recorded per transaction so XIRR on foreign holdings uses the rate at each vest date
  -- rather than today's. A portfolio-wide conversion gives a materially wrong return.
  fx_rate         TEXT,
  source_document_id TEXT NOT NULL REFERENCES source_document(id) ON DELETE CASCADE,

  -- Second line of idempotency, and the one that matters when statement periods overlap.
  --
  -- Includes `occurrence` because two genuinely distinct transactions can be identical in every
  -- other respect: a doubled SIP instalment on the same day, at the same NAV, for the same
  -- amount, is real and must not be deduplicated away. Occurrence counts identical tuples within
  -- a single source document, so re-importing that document reproduces the same keys while two
  -- real instalments stay distinct.
  natural_key     TEXT NOT NULL,
  occurrence      INTEGER NOT NULL DEFAULT 0,

  -- Which document asserted this row. Depository and registrar statements disagree about the
  -- same folio; when they do, the registrar is authoritative for units and the depository for
  -- valuation, and the fold needs to know which it is holding.
  authority       TEXT NOT NULL DEFAULT 'primary'
                  CHECK (authority IN ('primary', 'corroborating')),

  created_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_txn_natural ON txn(natural_key, occurrence);
CREATE INDEX idx_txn_account_time ON txn(account_id, occurred_at);
CREATE INDEX idx_txn_instrument ON txn(instrument_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Positions (authoritative for snapshot accounts, derived for ledger accounts)
-- ---------------------------------------------------------------------------

CREATE TABLE position (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  instrument_id TEXT NOT NULL REFERENCES instrument(id),
  quantity      TEXT NOT NULL,
  as_of         TEXT NOT NULL,
  source_document_id TEXT NOT NULL REFERENCES source_document(id) ON DELETE CASCADE,
  UNIQUE (account_id, instrument_id, as_of)
);

CREATE INDEX idx_position_account ON position(account_id);

-- ---------------------------------------------------------------------------
-- Prices and FX
-- ---------------------------------------------------------------------------

CREATE TABLE price (
  instrument_id TEXT NOT NULL REFERENCES instrument(id) ON DELETE CASCADE,
  as_of         TEXT NOT NULL,
  close         TEXT NOT NULL,
  currency      TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('amfi', 'twelvedata', 'yahoo', 'coingecko', 'manual')),
  fetched_at    TEXT NOT NULL,
  -- source is part of the key so a manual override can coexist with the fetched value for the
  -- same day rather than destroying it. Read precedence is manual first, then the configured
  -- provider; see the valuation spec.
  PRIMARY KEY (instrument_id, as_of, source)
);

CREATE TABLE fx_rate (
  base       TEXT NOT NULL,
  quote      TEXT NOT NULL,
  as_of      TEXT NOT NULL,
  rate       TEXT NOT NULL,
  source     TEXT NOT NULL,
  PRIMARY KEY (base, quote, as_of, source)
);

-- ---------------------------------------------------------------------------
-- Import reporting
-- ---------------------------------------------------------------------------

CREATE TABLE import_run (
  id            TEXT PRIMARY KEY,
  source_document_id TEXT NOT NULL REFERENCES source_document(id) ON DELETE CASCADE,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  -- A partial import is a first-class outcome: 'completed' with a non-zero rows_failed.
  status        TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  -- Recorded so a statement can be reprocessed when a parser bug is fixed: the app can find
  -- every document imported by a version known to be wrong, rather than asking users to
  -- re-import everything on faith.
  parser_version TEXT NOT NULL DEFAULT '0',
  rows_read     INTEGER NOT NULL DEFAULT 0,
  rows_committed INTEGER NOT NULL DEFAULT 0,
  rows_duplicate INTEGER NOT NULL DEFAULT 0,
  -- Distinct from duplicate: rows deliberately not imported, such as a summary line.
  rows_skipped  INTEGER NOT NULL DEFAULT 0,
  rows_failed   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE import_issue (
  id            TEXT PRIMARY KEY,
  import_run_id TEXT NOT NULL REFERENCES import_run(id) ON DELETE CASCADE,
  row_ref       TEXT,
  severity      TEXT NOT NULL CHECK (severity IN ('error', 'warning')),
  code          TEXT NOT NULL,
  message       TEXT NOT NULL,
  -- JSON of the offending row, so an individual failure is re-runnable after a mapping fix.
  raw_payload   TEXT,
  -- Without this the import report cannot distinguish a failure the user has dealt with from
  -- one still needing attention, and the queue never appears to shrink.
  resolution    TEXT NOT NULL DEFAULT 'open'
                CHECK (resolution IN ('open', 'resolved', 'ignored')),
  resolved_at   TEXT
);

CREATE INDEX idx_import_issue_run ON import_issue(import_run_id);
CREATE INDEX idx_import_issue_open ON import_issue(resolution) WHERE resolution = 'open';

CREATE TABLE unresolved_instrument (
  id                TEXT PRIMARY KEY,
  source_document_id TEXT NOT NULL REFERENCES source_document(id) ON DELETE CASCADE,
  account_id        TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  raw_identifier    TEXT NOT NULL,
  raw_name          TEXT,
  -- What the parser believed this was, so the review queue can pre-filter candidate matches
  -- instead of offering the user every instrument in the database.
  asset_class_hint  TEXT,
  observed_quantity TEXT,
  -- Held so the UI can state the exact amount withheld from totals rather than estimating it.
  observed_value_minor INTEGER,
  currency          TEXT,
  first_seen_at     TEXT NOT NULL,
  resolved_at       TEXT,
  resolved_instrument_id TEXT REFERENCES instrument(id)
);

CREATE INDEX idx_unresolved_open ON unresolved_instrument(resolved_at) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- Secrets and settings
-- ---------------------------------------------------------------------------

-- Never holds a secret. Only a reference to the OS keychain entry that does.
CREATE TABLE credential_ref (
  account_id   TEXT PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  keychain_key TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('api-key-secret', 'oauth-token')),
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE schema_migration (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------------

INSERT INTO provider (id, display_name, short_code, kind, country) VALUES
  ('nsdl-cas',   'NSDL consolidated statement',   'NSD', 'statement',    'IN'),
  ('cdsl-cas',   'CDSL consolidated statement',   'CDS', 'statement',    'IN'),
  ('cams-cas',   'CAMS consolidated statement',   'CAS', 'statement',    'IN'),
  ('kfin-cas',   'KFintech consolidated statement','KFN', 'statement',   'IN'),
  ('zerodha-kite','Zerodha Kite',                 'KIT', 'statement',    'IN'),
  ('groww',      'Groww',                         'GRW', 'statement',    'IN'),
  ('etrade',     'E*TRADE by Morgan Stanley',     'ETR', 'statement',    'US'),
  ('fidelity',   'Fidelity',                      'FID', 'statement',    'US'),
  ('coindcx',    'CoinDCX',                       'DCX', 'exchange-api', 'IN'),
  ('binance',    'Binance',                       'BNB', 'exchange-api', 'IN');

INSERT INTO setting (key, value, updated_at) VALUES
  ('base_currency',              'INR',  datetime('now')),
  ('price_cache_ttl_minutes',    '360',  datetime('now')),
  ('concentration_flag_percent', '20',   datetime('now')),
  ('stale_price_days',           '3',    datetime('now'));
