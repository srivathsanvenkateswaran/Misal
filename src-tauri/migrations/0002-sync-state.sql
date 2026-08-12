-- Gaps identified by the crypto adapter spec while reviewing the core contract.

-- Incremental sync watermarks.
--
-- Binance's myTrades requires a symbol and caps a startTime/endTime window at 24 hours, so
-- backfill pages forward by trade id rather than by date. Resuming that walk needs a durable
-- per-(account, stream, scope) cursor; without one, every sync would re-walk full history.
--
-- `scope` is the symbol or asset the cursor applies to, or '*' where the stream is not
-- partitioned. `cursor` is deliberately opaque TEXT: a trade id for Binance, a millisecond
-- timestamp for CoinDCX, and whatever the next exchange needs.
CREATE TABLE sync_state (
  account_id   TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  stream       TEXT NOT NULL,
  scope        TEXT NOT NULL DEFAULT '*',
  cursor       TEXT,
  last_synced_at TEXT,
  -- Set when a sync finished without being able to prove it saw everything, so the UI can say
  -- so rather than implying completeness. Neither exchange can guarantee full coverage:
  -- Binance hides fills in pairs we never enumerated, and Convert trades never appear in the
  -- trade history at all.
  coverage_note TEXT,
  PRIMARY KEY (account_id, stream, scope)
);

-- Binance is a single global platform; Indian users trade on the same api.binance.com as
-- everyone else, so tagging it 'IN' was wrong.
UPDATE provider SET country = 'GLOBAL' WHERE id = 'binance';

-- Crypto-denominated amounts.
--
-- txn.amount_minor assumes an ISO-4217 currency with a fixed minor unit. A BTCUSDT fill is
-- denominated in USDT, which has neither. Such rows use a reserved 'X:<asset>' currency
-- namespace and leave amount_minor NULL; their value is derived from quantity and price at
-- valuation time instead. This is a convention rather than a constraint because retrofitting a
-- CHECK onto txn would require a full table rebuild for no added safety - the ingestion layer
-- is the only writer, and it is tested.
--
-- Recorded here so the convention is discoverable from the schema history rather than only
-- from the adapter spec.
INSERT INTO setting (key, value, updated_at)
  VALUES ('crypto_currency_namespace', 'X:', datetime('now'));
