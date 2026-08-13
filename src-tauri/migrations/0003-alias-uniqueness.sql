-- Close a hole in instrument_alias.
--
-- The table declares PRIMARY KEY (scheme, value, provider_id), which looks like it prevents the
-- same identifier being claimed twice. It does not. SQLite treats NULLs in a unique index as
-- distinct from one another, and provider_id is NULL for every global scheme - isin, amfi, nse,
-- bse, ticker, coingecko. So in practice the only aliases that were constrained were the
-- provider-local ones, which are the least likely to collide.
--
-- The consequence is the same shape as the folio-doubling bug that account.identity_key exists to
-- prevent: one ISIN could resolve to two instruments, and a holding counted under both would
-- inflate net worth. Resolution would pick whichever row it saw first, so the wrong answer would
-- also be unstable between runs.

-- Deduplicate before constraining, or the index cannot be created on an existing database.
--
-- Keeping the lowest rowid per (scheme, value) is arbitrary but deterministic, and safe here:
-- duplicate global aliases are by definition rows asserting the same identifier, so the
-- information lost is a claim that contradicts one already recorded. Anything genuinely distinct
-- carries a provider_id and is untouched by this statement.
DELETE FROM instrument_alias
 WHERE provider_id IS NULL
   AND rowid NOT IN (
     SELECT min(rowid) FROM instrument_alias
      WHERE provider_id IS NULL
      GROUP BY scheme, value
   );

-- The partial index the primary key should have been. Global schemes get exactly one owner.
CREATE UNIQUE INDEX idx_alias_global_unique
    ON instrument_alias(scheme, value)
 WHERE provider_id IS NULL;
