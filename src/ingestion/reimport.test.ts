/**
 * Re-importing a document that is still withholding rows.
 *
 * The content hash makes an import idempotent, which is right for a file whose rows all landed and
 * wrong for one whose rows did not. An import that could not identify its instruments writes zero
 * `txn` rows and a `source_document` carrying the hash. The review queue then asks the user to map
 * the identifier — and mapping writes an alias, not transactions. The rows exist nowhere but in the
 * file, Misal never copies the file, and `import_issue.raw_payload` cannot reconstruct them: a CAS
 * transaction's payload is `{date, description, amount, units, price, balance}`, which names
 * neither the folio nor the ISIN, so nothing can say which account or instrument the row belonged
 * to. Reading the file again is therefore the only path those rows have, and the hash used to
 * refuse it forever.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore } from './memory-store'
import { runImport, type ImportDeps, type ImportOutcome } from './pipeline'
import { camsKfinCasPlugin } from './pdf/cams-kfin-cas'
import { fakePdfBytes, fakePdfSource } from './testing/fake-pdf'
import { camsDetailedPages } from './testing/corpus'
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

/** What the user's mapping amounts to: the catalogue now holds the instrument under that ISIN. */
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

beforeEach(() => {
  store = new MemoryStore()
  counter = 0
})

describe('a document that is still withholding rows', () => {
  it('is still a no-op while nothing can say rows are withheld', async () => {
    // The behaviour a caller with no way to ask must keep getting: idempotent on the hash alone.
    catalogueLearnsTheFunds()
    const bytes = fakePdfBytes('cams-detailed')
    completed(await runImport({ bytes, originalName: 'cas.pdf' }, deps(camsDetailedPages())))

    const second = await runImport({ bytes, originalName: 'cas.pdf' }, deps(camsDetailedPages()))
    expect(second.status).toBe('already-imported')
    expect(store.snapshot().runs).toHaveLength(1)
  })

  it('is read again once its identifiers are mapped, into the document it already has', async () => {
    const bytes = fakePdfBytes('cams-detailed')

    // Nothing in the catalogue, so every row is withheld and no transaction is written.
    const first = completed(
      await runImport({ bytes, originalName: 'cas.pdf' }, deps(camsDetailedPages())),
    )
    expect(first.reimported).toBe(false)
    expect(first.counters.withheld).toBeGreaterThan(0)
    expect(first.counters.committed).toBe(0)
    expect(store.snapshot().txns).toHaveLength(0)
    expect(store.snapshot().documents).toHaveLength(1)

    // The defect: the hash refuses the only file those rows exist in.
    const refused = await runImport({ bytes, originalName: 'cas.pdf' }, deps(camsDetailedPages()))
    expect(refused.status).toBe('already-imported')

    catalogueLearnsTheFunds()
    const again = completed(
      await runImport(
        { bytes, originalName: 'cas.pdf' },
        deps(camsDetailedPages(), {
          withheldFor: () => Promise.resolve(first.counters.withheld),
        }),
      ),
    )

    expect(again.reimported).toBe(true)
    // The same document, not a second one: the bytes were imported once and are still one file.
    expect(again.documentId).toBe(first.documentId)
    expect(store.snapshot().documents).toHaveLength(1)
    expect(store.snapshot().runs).toHaveLength(2)

    // And the money the first import withheld is now in the ledger.
    expect(again.counters.committed).toBeGreaterThan(0)
    expect(again.counters.withheld).toBe(0)
    expect(store.snapshot().txns.length).toBeGreaterThan(0)
    expect(store.snapshot().positions.length).toBeGreaterThan(0)
  })

  it('does not re-import a file whose withheld rows have all been dealt with', async () => {
    catalogueLearnsTheFunds()
    const bytes = fakePdfBytes('cams-detailed')
    completed(await runImport({ bytes, originalName: 'cas.pdf' }, deps(camsDetailedPages())))

    // Nothing withheld — a dismissed entry reports zero here too, because the user asked not to be
    // chased about it.
    const second = await runImport(
      { bytes, originalName: 'cas.pdf' },
      deps(camsDetailedPages(), { withheldFor: () => Promise.resolve(0) }),
    )
    expect(second.status).toBe('already-imported')
    expect(store.snapshot().runs).toHaveLength(1)
  })
})
