-- 0006 — the unresolved-instrument lifecycle.
--
-- Three different states were being written into one column. `resolved_at` was the only "still
-- open" predicate in the system — `queries.rs::list_unresolved`, `ingest.rs::unresolved_for_document`
-- and `valuation/portfolio.ts`'s withheld total all read it — and dismissing an entry set it. So a
-- dismissal did not merely stop the import report asking. It deleted the disclosure that money was
-- missing from every total: the withheld rupee figure fell to zero, the count fell to zero, and the
-- dashboard began stating, of a holding it had never identified, that every identifier in every
-- document is mapped.
--
-- The states these columns separate, and what each one says about the money:
--
--   ignored_at   The user does not want to be asked again. The value stays withheld from every
--                total and stays disclosed, because it is still genuinely absent from net worth.
--   mapped_at    The user has named the instrument, so the alias is learned and the next statement
--                resolves without asking. The rows this import withheld are still not in the
--                ledger, so the value stays disclosed until a document carrying them is imported.
--   resolved_at  The rows actually landed. Only now does the disclosure stop, because the money is
--                in the totals rather than merely accounted for.
--
-- `resolved_at` therefore keeps its exact meaning — not "the user dealt with it" but "it is no
-- longer missing" — which is what every consumer of it already assumes.

ALTER TABLE unresolved_instrument ADD COLUMN ignored_at TEXT;
ALTER TABLE unresolved_instrument ADD COLUMN mapped_at TEXT;

-- Which document last withheld rows for this identifier, so an import report can list what *this*
-- file could not identify even when the open entry was first raised by an earlier one. Without it,
-- the single-open-row rule below would silently hand the second statement an empty review queue.
-- ON DELETE SET NULL rather than CASCADE: the entry outlives any one sighting of it.
ALTER TABLE unresolved_instrument ADD COLUMN last_seen_at TEXT;
ALTER TABLE unresolved_instrument
  ADD COLUMN last_seen_document_id TEXT REFERENCES source_document(id) ON DELETE SET NULL;

UPDATE unresolved_instrument
   SET last_seen_at = first_seen_at,
       last_seen_document_id = source_document_id
 WHERE last_seen_at IS NULL;

-- ---------------------------------------------------------------------------
-- One open entry per identifier per account
-- ---------------------------------------------------------------------------
--
-- The ingestion path inserted an unresolved row unconditionally, so importing a monthly statement
-- carrying the same unmapped ISIN reported twelve instruments and twelve times the rupees for one
-- holding. The exchange path (`sync.rs::record_unresolved`) has always guarded its identical insert
-- on exactly this key; the index makes the rule structural rather than a convention two call sites
-- have to remember.
--
-- Databases written before this migration can already hold those duplicates, so they are collapsed
-- first: the earliest sighting is kept, because `first_seen_at` is what the queue orders by, and it
-- inherits the most recent sighting's observed value, which is the figure a fresh import would have
-- written. The duplicates are deleted rather than summed — twelve statements did not withhold
-- twelve holdings, they withheld one holding twelve times.

DROP TABLE IF EXISTS temp.unresolved_open_dedupe;

CREATE TEMP TABLE unresolved_open_dedupe AS
SELECT (SELECT e.id
          FROM unresolved_instrument e
         WHERE e.resolved_at IS NULL
           AND e.account_id = u.account_id
           AND e.raw_identifier = u.raw_identifier
         ORDER BY e.first_seen_at ASC, e.id ASC
         LIMIT 1) AS keep_id,
       (SELECT l.id
          FROM unresolved_instrument l
         WHERE l.resolved_at IS NULL
           AND l.account_id = u.account_id
           AND l.raw_identifier = u.raw_identifier
         ORDER BY l.first_seen_at DESC, l.id DESC
         LIMIT 1) AS latest_id
  FROM unresolved_instrument u
 WHERE u.resolved_at IS NULL
 GROUP BY u.account_id, u.raw_identifier;

UPDATE unresolved_instrument
   SET observed_value_minor = coalesce(
         (SELECT l.observed_value_minor
            FROM unresolved_instrument l
            JOIN unresolved_open_dedupe d ON d.latest_id = l.id
           WHERE d.keep_id = unresolved_instrument.id),
         observed_value_minor),
       observed_quantity = coalesce(
         (SELECT l.observed_quantity
            FROM unresolved_instrument l
            JOIN unresolved_open_dedupe d ON d.latest_id = l.id
           WHERE d.keep_id = unresolved_instrument.id),
         observed_quantity),
       last_seen_at = coalesce(
         (SELECT l.first_seen_at
            FROM unresolved_instrument l
            JOIN unresolved_open_dedupe d ON d.latest_id = l.id
           WHERE d.keep_id = unresolved_instrument.id),
         last_seen_at),
       last_seen_document_id = coalesce(
         (SELECT l.source_document_id
            FROM unresolved_instrument l
            JOIN unresolved_open_dedupe d ON d.latest_id = l.id
           WHERE d.keep_id = unresolved_instrument.id),
         last_seen_document_id)
 WHERE id IN (SELECT keep_id FROM unresolved_open_dedupe);

DELETE FROM unresolved_instrument
 WHERE resolved_at IS NULL
   AND id NOT IN (SELECT keep_id FROM unresolved_open_dedupe);

DROP TABLE temp.unresolved_open_dedupe;

CREATE UNIQUE INDEX idx_unresolved_one_open
  ON unresolved_instrument(account_id, raw_identifier)
  WHERE resolved_at IS NULL;
