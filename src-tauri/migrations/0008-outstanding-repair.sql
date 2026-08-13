-- 0008 — repair the flags the unscoped dismissal swept away.
--
-- Migration 0007 gave each document its own record of what it still owes the ledger, so that a
-- release earned by one statement could not answer for another. Two holes in the code around it
-- put that record back in the hands of the shared queue it was written to escape:
--
--   `ingest.rs::ignore_unresolved` cleared `outstanding_reason` with an UPDATE that named neither
--   the dismissed entry nor its document. Every dismissal re-derived the flag for every run in the
--   database, from the same shared queue that cannot answer for one document — so dismissing an
--   entry in one account, for one fund, cleared the flag on any other document whose own withheld
--   rows happened to have been released by some third statement.
--
--   `accounts.rs::restore_entry` cleared `ignored_at` and stopped. Nothing else in the system ever
--   writes `outstanding_reason` except `record_outstanding_rows`, at commit time, so "Put back"
--   restored the question and left the documents that raised it answered `already-imported`.
--
-- Both are fixed at their call sites. Neither fix can reach a database where the sweep has already
-- run: the flag is gone, and the rows those documents were withholding exist nowhere but in the
-- PDFs — `import_issue.raw_payload` cannot reconstruct a CAS row and Misal never copies the file.
-- So the flag is derived once more here, by exactly the rule 0007's backfill states.
--
-- Conservative in one direction only. A flag set where the document in fact owes nothing costs a
-- single re-import, which recomputes `outstanding_reason` from the batch and clears it; a flag left
-- clear where the document does owe rows costs the statement. Runs already carrying a reason are
-- therefore left alone rather than recomputed — the only reason they can be carrying is 'crashed',
-- which outranks a withholding, and this migration knows nothing about pages a parser never read.

UPDATE import_run
   SET outstanding_reason = 'withheld'
 WHERE outstanding_reason IS NULL
   -- Only documents that came from a file. An `api-response` document is a page of an exchange
   -- sync, never re-read through the import pipeline, so flagging one would mean nothing to anybody.
   AND EXISTS (SELECT 1 FROM source_document d
                WHERE d.id = import_run.source_document_id
                  AND d.kind IN ('cas-pdf', 'csv'))
   -- Only the newest run for a document speaks for it, which is 0007's rule and the one
   -- `record_outstanding_rows` maintains from here on.
   AND NOT EXISTS (SELECT 1 FROM import_run later
                    WHERE later.source_document_id = import_run.source_document_id
                      AND (later.started_at > import_run.started_at
                        OR (later.started_at = import_run.started_at AND later.id > import_run.id)))
   AND (
     -- The ordinary case: the document is still named on an open, un-dismissed entry.
     EXISTS (SELECT 1 FROM unresolved_instrument u
              WHERE (u.source_document_id = import_run.source_document_id
                  OR u.last_seen_document_id = import_run.source_document_id)
                AND u.resolved_at IS NULL AND u.ignored_at IS NULL)
     -- And the case the sweep created: the run withheld rows, the entry it was withholding was
     -- closed by some other document landing its own, and no dismissal ever spoke about this
     -- document. That last clause is what keeps a file the user asked not to be chased about
     -- idempotent, which is the whole point of the dismissal path.
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
