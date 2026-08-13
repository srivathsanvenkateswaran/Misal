/**
 * Re-importing a document whose *own run* says it still owes the ledger rows.
 *
 * `reimport.test.ts` covers the case the review queue can answer for: one file, rows withheld,
 * identifier mapped, file read again. This file covers the two cases the queue cannot answer for at
 * all, both of which ended with `runImport` returning `already-imported` for a file whose rows are
 * not in the ledger, and the screen saying "No changes were made… because nothing happened".
 *
 *   - **A shared entry, released by another statement.** Migration 0006 keeps one open entry per
 *     `(account_id, raw_identifier)`, so January's and February's eCAS naming the same unmapped
 *     ISIN share one. Mapping it and re-importing February lands February's rows and closes the
 *     entry, and `withheldFor` then reports zero for January — whose transactions were never
 *     written and exist nowhere but in that file.
 *   - **A plugin that throws part way through.** Whatever it emitted before the throw is committed,
 *     the `source_document` carrying the content hash is written with it, and the folios it never
 *     reached raised no queue entries — so there is nothing for `withheldFor` to count.
 *
 * The signal both are read from is `import_run.outstanding_reason`, which storage writes about the
 * document's own pass over its own bytes.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore } from './memory-store'
import { runImport, type ImportDeps, type ImportOutcome } from './pipeline'
import { camsKfinCasPlugin } from './pdf/cams-kfin-cas'
import { fakePdfBytes, fakePdfSource } from './testing/fake-pdf'
import { camsDetailedPages } from './testing/corpus'
import type { ExtractPlugin } from './plugin'
import type { RawPdfPage } from './types'

const NOW = '2026-08-12T10:00:00+05:30'

let store: MemoryStore
let counter: number

function deps(pages: readonly RawPdfPage[], extra: Partial<ImportDeps> = {}): ImportDeps {
  return {
    store,
    plugins: [camsKfinCasPlugin],
    now: () => NOW,
    newId: () => `id-${String((counter += 1))}`,
    pdfSource: fakePdfSource(pages),
    ...extra,
  }
}

function completed(outcome: ImportOutcome) {
  if (outcome.status !== 'completed') throw new Error(`expected completion, got ${outcome.status}`)
  return outcome
}

function catalogueLearnsTheFunds(): void {
  store.seedInstrument({
    id: 'i-hdfc',
    assetClass: 'mutual_fund',
    displayName: 'HDFC Flexi Cap Fund',
    isin: 'INF179K01608',
    currency: 'INR',
  })
  store.seedInstrument({
    id: 'i-icici',
    assetClass: 'mutual_fund',
    displayName: 'ICICI Prudential Bluechip Fund',
    isin: 'INF109K01BL4',
    currency: 'INR',
  })
}

/** A plugin that emits one account and then throws, as a layout parser does on a drifted format. */
const crashingPlugin: ExtractPlugin = {
  id: 'crashing',
  providerId: 'cams-cas',
  accepts: 'cas-pdf',
  detect: () => 0.99,
  extract: (_input, sink) => {
    sink.account({
      type: 'account',
      ref: 'p.1',
      raw: {},
      accountKey: 'mf-folio:hdfc:12345678/0',
      label: 'HDFC',
      externalRef: '12345678/0',
      capability: 'snapshot',
      baseCurrency: 'INR',
    })
    throw new Error('boom')
  },
}

beforeEach(() => {
  store = new MemoryStore()
  counter = 0
})

describe('a document whose own run says it still owes rows', () => {
  it('is read again even though the queue reports nothing withheld', async () => {
    const bytes = fakePdfBytes('cams-detailed')

    // January: nothing in the catalogue, so every row is withheld and no transaction is written.
    const january = completed(
      await runImport({ bytes, originalName: 'jan.pdf' }, deps(camsDetailedPages())),
    )
    expect(january.counters.committed).toBe(0)
    expect(january.counters.withheld).toBeGreaterThan(0)

    catalogueLearnsTheFunds()

    // February has landed the rows for that identifier and closed the shared entry, so the queue
    // has nothing left to say about January. This is the state that used to be permanent.
    const again = await runImport(
      { bytes, originalName: 'jan.pdf' },
      deps(camsDetailedPages(), {
        withheldFor: () => Promise.resolve(0),
        outstandingFor: () => Promise.resolve(true),
      }),
    )

    const landed = completed(again)
    expect(landed.reimported).toBe(true)
    expect(landed.documentId).toBe(january.documentId)
    expect(store.snapshot().documents).toHaveLength(1)
    expect(landed.counters.committed).toBeGreaterThan(0)
    expect(store.snapshot().txns.length).toBeGreaterThan(0)
  })

  it('is a no-op again once its own run says it owes nothing', async () => {
    catalogueLearnsTheFunds()
    const bytes = fakePdfBytes('cams-detailed')
    completed(await runImport({ bytes, originalName: 'cas.pdf' }, deps(camsDetailedPages())))

    const second = await runImport(
      { bytes, originalName: 'cas.pdf' },
      deps(camsDetailedPages(), {
        withheldFor: () => Promise.resolve(0),
        outstandingFor: () => Promise.resolve(false),
      }),
    )
    expect(second.status).toBe('already-imported')
    expect(store.snapshot().runs).toHaveLength(1)
  })

  it('is read again after a plugin crash, which withholds nothing to be counted', async () => {
    const bytes = fakePdfBytes('crash')
    const crashed = completed(
      await runImport(
        { bytes, originalName: 'cas.pdf' },
        deps(camsDetailedPages(), { plugins: [crashingPlugin] }),
      ),
    )
    // Nothing was withheld: the folios the parser never reached raised no queue entries.
    expect(crashed.counters.withheld).toBe(0)
    expect(store.snapshot().documents).toHaveLength(1)

    const again = await runImport(
      { bytes, originalName: 'cas.pdf' },
      deps(camsDetailedPages(), {
        withheldFor: () => Promise.resolve(0),
        outstandingFor: () => Promise.resolve(true),
      }),
    )
    expect(again.status).toBe('completed')
  })
})

describe('the audit record a crashed run leaves', () => {
  it('counts the crash as a failure rather than reading as a clean import', async () => {
    const outcome = completed(
      await runImport(
        { bytes: fakePdfBytes('crash'), originalName: 'cas.pdf' },
        deps(camsDetailedPages(), { plugins: [crashingPlugin] }),
      ),
    )

    // The run recorded `rows_failed: 0`, `status: 'completed'` and `read == committed` for a file
    // the parser gave up half way through — an audit record indistinguishable from a whole import.
    expect(outcome.counters.failed).toBeGreaterThan(0)
    expect(outcome.counters.read).toBeGreaterThan(outcome.counters.committed)
    expect(store.snapshot().runs[0]?.rowsFailed).toBe(outcome.counters.failed)

    // And the counters still reconcile, which the import report states out loud.
    const { read, committed, duplicate, skipped, failed } = outcome.counters
    expect(read).toBe(committed + duplicate + skipped + failed)
    expect(outcome.issues.some((issue) => issue.code === 'E_PLUGIN_CRASH')).toBe(true)
  })
})
