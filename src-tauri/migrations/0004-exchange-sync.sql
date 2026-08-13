-- What a live exchange sync needs and migration 0002 did not provide.
--
-- 0002 added `sync_state`, which is per (account, stream, scope) and holds the opaque watermark.
-- Three further pieces of state are per account or per provider rather than per stream, so they
-- have nowhere to live in that table.

-- Account-level sync state.
--
-- `discovered_assets` is the set Binance's symbol enumeration is computed from: every asset the
-- account has ever been seen to hold, from balances, transfers and previously ingested fills.
-- `myTrades` requires a symbol and there is no all-symbols endpoint, so without a persisted set
-- the first sync's discovery work would be repeated in full on every subsequent sync. The set
-- only ever grows.
--
-- `last_status` and `last_error_code` are what the account manager shows instead of a green tick
-- when a sync finished without seeing everything. 'quarantined' is distinct from 'failed': it
-- means a key was found to have gained withdrawal permission and Misal has stopped syncing on
-- purpose, keeping everything already imported.
CREATE TABLE exchange_account_state (
  account_id        TEXT PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  -- JSON array of exchange asset codes.
  discovered_assets TEXT NOT NULL DEFAULT '[]',
  last_synced_at    TEXT,
  last_status       TEXT CHECK (last_status IN ('ok', 'partial', 'failed', 'quarantined')),
  last_error_code   TEXT
);

-- The exchange market catalogue, cached per provider per day.
--
-- Roughly a thousand markets on CoinDCX and three thousand on Binance, refetched at most daily.
-- Cached because symbols are never split by string manipulation - 'BTCUSDT' and 'BTCUSD' are
-- indistinguishable to a suffix match - so every fill needs the catalogue, and re-fetching it per
-- page would spend the weight budget on data that changes once a day.
CREATE TABLE exchange_market_cache (
  provider_id TEXT NOT NULL REFERENCES provider(id),
  as_of       TEXT NOT NULL,
  -- JSON array of { symbol, base, quote, quantityPrecision }.
  markets     TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (provider_id, as_of)
);

-- What a key is allowed to do, so the account manager can render the over-scoped badge across
-- restarts rather than only in the session that connected it.
--
-- No secret goes here. `scope_verification` records whether the exchange told us authoritatively
-- ('introspected'), could not tell us and the user confirmed the settings ('attested'), or has no
-- permission model at all ('unscopable') - CoinDCX issues one key class with full trade
-- authority. `acknowledged_at` is when the user accepted that exposure, which is required before
-- a trade-capable credential may be stored at all.
ALTER TABLE credential_ref ADD COLUMN scope_verification TEXT;
-- JSON of the ScopeReport's tristate flags. 'unknown' is a value, distinct from false.
ALTER TABLE credential_ref ADD COLUMN scope_flags TEXT;
ALTER TABLE credential_ref ADD COLUMN acknowledged_at TEXT;
