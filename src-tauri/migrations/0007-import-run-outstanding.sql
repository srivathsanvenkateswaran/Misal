-- 0007 — a document's own record of the rows it still owes the ledger.
--
-- Re-importability was inferred rather than recorded. `ingest.rs::withheld_for_document` was the
-- only thing that let a file back past the content-hash short-circuit, and it inferred "this
-- document still has rows that never landed" from `unresolved_instrument`, which does not record
-- that. Two ways that inference is wrong, both ending with a file whose rows are not in the ledger
-- being answered `already-imported`:
--
--   A shared entry, released by one document on behalf of all. Migration 0006 permits one open
--   entry per (account_id, raw_identifier), and it carries a single `last_seen_document_id`. Two
--   monthly statements naming the same unmapped ISIN share one entry; mapping it and re-importing
--   February lands February's rows and stamps `resolved_at`, and January — whose rows were never
--   written — is refused forever. With more statements it is worse: only the first and the last
--   sighting are named by the entry at all, so the middle ones could never have been let back in.
--
--   A plugin that throws mid-document. Everything read before the throw is committed, and the
--   `source_document` carrying the content hash is written with it, so the file is closed. The
--   folios the parser never reached raised no unresolved rows, so nothing was ever withheld and the
--   inference reports zero for a statement that was read half way.
--
-- In both cases the only recovery was deleting every account the import created.
--
-- The column below stops inferring. Each run records whether *that pass over that document* left
-- rows outstanding, so a release by some other document cannot speak for it:
--
--   'withheld'  rows were held back for want of an identifier and are still open. Set at commit
--               from `withheld_for_document` — which counts only entries this document is named on
--               and which are neither landed nor dismissed — and cleared when a dismissal makes
--               that count zero, so a file the user asked not to be chased about stays idempotent.
--   'crashed'   the plugin threw part way through the document. Nothing knows what was not read,
--               so the file must stay readable once the parser is fixed.
--   NULL        the document owes the ledger nothing.
--
-- Only the newest run for a document speaks for it: `commit_batch` clears the column on that
-- document's earlier runs, because the pass that just finished is the current statement of what the
-- document still owes.

ALTER TABLE import_run ADD COLUMN outstanding_reason TEXT
  CHECK (outstanding_reason IS NULL OR outstanding_reason IN ('withheld', 'crashed'));

CREATE INDEX idx_import_run_outstanding
  ON import_run(source_document_id)
  WHERE outstanding_reason IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
--
-- Databases written before this migration already hold the locked-out documents the column exists
-- to release, and a defaulted NULL would leave them locked out. Only the newest run for each
-- document is considered, matching the rule from here on, and only documents that came from a file:
-- an `api-response` document is a page of an exchange sync, never re-read through the import
-- pipeline, and flagging one would mean nothing to anybody.
--
-- A run is marked 'withheld' when its document is still named on an open, un-dismissed entry — the
-- ordinary case — or when it recorded `W_UNRESOLVED_INSTRUMENT` issues and the entries it raised
-- are gone from the open set without the user having dismissed them. That second clause is January:
-- its rows never landed, and the entry it was withholding was closed by February.

UPDATE import_run
   SET outstanding_reason = 'withheld'
 WHERE EXISTS (SELECT 1 FROM source_document d
                WHERE d.id = import_run.source_document_id
                  AND d.kind IN ('cas-pdf', 'csv'))
   AND NOT EXISTS (SELECT 1 FROM import_run later
                    WHERE later.source_document_id = import_run.source_document_id
                      AND (later.started_at > import_run.started_at
                        OR (later.started_at = import_run.started_at AND later.id > import_run.id)))
   AND (
     EXISTS (SELECT 1 FROM unresolved_instrument u
              WHERE (u.source_document_id = import_run.source_document_id
                  OR u.last_seen_document_id = import_run.source_document_id)
                AND u.resolved_at IS NULL AND u.ignored_at IS NULL)
     OR (
       EXISTS (SELECT 1 FROM import_issue i
                WHERE i.import_run_id = import_run.id
                  AND i.code = 'W_UNRESOLVED_INSTRUMENT')
       AND NOT EXISTS (SELECT 1 FROM unresolved_instrument u
                        WHERE (u.source_document_id = import_run.source_document_id
                            OR u.last_seen_document_id = import_run.source_document_id)
                          AND u.resolved_at IS NULL AND u.ignored_at IS NOT NULL)
     )
   );

-- A crash outranks a withholding: the run knows which rows it held back, and knows nothing at all
-- about the pages it never reached.

UPDATE import_run
   SET outstanding_reason = 'crashed'
 WHERE EXISTS (SELECT 1 FROM source_document d
                WHERE d.id = import_run.source_document_id
                  AND d.kind IN ('cas-pdf', 'csv'))
   AND NOT EXISTS (SELECT 1 FROM import_run later
                    WHERE later.source_document_id = import_run.source_document_id
                      AND (later.started_at > import_run.started_at
                        OR (later.started_at = import_run.started_at AND later.id > import_run.id)))
   AND EXISTS (SELECT 1 FROM import_issue i
                WHERE i.import_run_id = import_run.id
                  AND i.code = 'E_PLUGIN_CRASH');
