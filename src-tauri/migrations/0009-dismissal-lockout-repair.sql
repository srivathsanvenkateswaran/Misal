-- 0009 — repair the statements a standing dismissal answered for.
--
-- `record_outstanding_rows` derived the 'withheld' half of `import_run.outstanding_reason` from
-- `ingest.rs::withheld_for_document`, which filters `ignored_at IS NULL`. Migration 0006 permits
-- one open entry per (account, identifier), and `record_unresolved` advances that entry's
-- `last_seen_document_id` on anything not yet `resolved_at` — a dismissed entry included. So every
-- statement imported *after* a dismissal had its sighting absorbed by the dismissed entry, raised
-- nothing the count could see, and committed saying it owed the ledger nothing:
--
--   Import January's eCAS, which cannot name a fund. Press "Dismiss for now". Import February and
--   March. All three runs record NULL, `runImport` answers `already-imported` for all three, and
--   February's and March's rows can never be landed — not by mapping the identifier, which never
--   touches `import_run`, and not by "Put back", which re-stamps only the two documents the entry
--   names. Twelve monthly statements lose the ten in the middle.
--
-- Fixed at the call site: the commit-time count is now blind to `ignored_at`, because a dismissal
-- is an answer about being asked and never about the rows. That fix cannot reach a database the
-- defect has already run in — the flag is gone, nothing else recomputes it, and the transactions
-- exist nowhere but in the PDFs, since `import_issue.raw_payload` cannot reconstruct a CAS row and
-- Misal never copies the file.
--
-- The rule below is migration 0008's, with one clause changed. 0008 refused to flag a run whose
-- document is named on a dismissed entry, which is right for the statement the dismissal was made
-- *about* and wrong for every statement imported after it. The two are told apart by when the
-- dismissal happened: a dismissal that came after a run settled that run, and a dismissal that came
-- before it cannot have spoken about rows it had not yet seen.
--
-- Conservative in one direction only, exactly as 0008 is. A flag set where the document owes
-- nothing costs one re-import, which recomputes the reason from the batch and clears it; a flag
-- missing where rows are owed costs the statement.

UPDATE import_run
   SET outstanding_reason = 'withheld'
 WHERE outstanding_reason IS NULL
   -- Only documents that came from a file. An `api-response` document is a page of an exchange
   -- sync, never re-read through the import pipeline, so flagging one would mean nothing to anybody.
   AND EXISTS (SELECT 1 FROM source_document d
                WHERE d.id = import_run.source_document_id
                  AND d.kind IN ('cas-pdf', 'csv'))
   -- Only the newest run for a document speaks for it, which is 0007's rule.
   AND NOT EXISTS (SELECT 1 FROM import_run later
                    WHERE later.source_document_id = import_run.source_document_id
                      AND (later.started_at > import_run.started_at
                        OR (later.started_at = import_run.started_at AND later.id > import_run.id)))
   AND (
     -- The ordinary case, unchanged from 0008: the document is still named on an open,
     -- un-dismissed entry.
     EXISTS (SELECT 1 FROM unresolved_instrument u
              WHERE (u.source_document_id = import_run.source_document_id
                  OR u.last_seen_document_id = import_run.source_document_id)
                AND u.resolved_at IS NULL AND u.ignored_at IS NULL)
     -- And the case this migration is for: the run held rows back for want of an identifier, and
     -- no dismissal made *after* it has answered for it. A dismissal that came first cannot have
     -- spoken about rows it had not yet seen — that is the whole defect — while one that came
     -- after is the user asking not to be chased about this very statement, which is the one thing
     -- that legitimately returns a file to being idempotent and stays honoured here.
     OR (
       EXISTS (SELECT 1 FROM import_issue i
                WHERE i.import_run_id = import_run.id
                  AND i.code = 'W_UNRESOLVED_INSTRUMENT')
       AND NOT EXISTS (SELECT 1 FROM unresolved_instrument u
                        WHERE (u.source_document_id = import_run.source_document_id
                            OR u.last_seen_document_id = import_run.source_document_id)
                          AND u.resolved_at IS NULL
                          AND u.ignored_at IS NOT NULL
                          AND u.ignored_at >= import_run.started_at)
     )
   );
