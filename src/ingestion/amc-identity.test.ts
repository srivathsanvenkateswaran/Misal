/**
 * One folio, one account — whichever document names the fund house, and however it spells it.
 *
 * This is the test the old corpus could not contain. Both fixtures printed "HDFC Mutual Fund", so
 * the two slugs agreed by accident and the folio-doubling bug passed a full suite. Here the CAMS
 * statement and the NSDL eCAS are generated with *every* pairing of three real spellings, and the
 * assertion is the one that matters to a user: one account, one set of units, no doubled net
 * worth.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore } from './memory-store'
import { runImport, type ImportDeps, type ImportOutcome } from './pipeline'
import { camsKfinCasPlugin } from './pdf/cams-kfin-cas'
import { nsdlEcasPlugin } from './pdf/nsdl-ecas'
import { fakePdfBytes, fakePdfSource } from './testing/fake-pdf'
import { AMC_SPELLINGS, camsDetailedPages, camsSummaryPages, nsdlEcasPages } from './testing/corpus'
import { findByPrintedName } from './amc/registry'
import { PROVISIONAL_MARKER } from './amc/identity'
import type { RawPdfPage } from './types'

const NOW = '2026-08-12T10:00:00+05:30'
const FOLIO = '12345678/0'

let store: MemoryStore
let counter: number

function deps(pages: readonly RawPdfPage[]): ImportDeps {
  return {
    store,
    plugins: [camsKfinCasPlugin, nsdlEcasPlugin],
    now: () => NOW,
    newId: () => `id-${String((counter += 1))}`,
    pdfSource: fakePdfSource(pages),
  }
}

function seedCatalogue(): void {
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
  store.seedInstrument({
    id: 'i-infy',
    assetClass: 'indian_equity',
    displayName: 'Infosys',
    isin: 'INE009A01021',
    currency: 'INR',
  })
}

function completed(outcome: ImportOutcome) {
  if (outcome.status !== 'completed') throw new Error(`expected completion, got ${outcome.status}`)
  return outcome
}

beforeEach(() => {
  store = new MemoryStore()
  counter = 0
})

const HDFC_ID = findByPrintedName('HDFC Mutual Fund')?.id ?? 'unresolved'
const EXPECTED_KEY = `mf-folio:${HDFC_ID}:${FOLIO}`

describe('one folio, one account, whatever the documents call the AMC', () => {
  for (const camsName of AMC_SPELLINGS.hdfc) {
    for (const nsdlName of AMC_SPELLINGS.hdfc) {
      it(`CAMS "${camsName}" and NSDL "${nsdlName}"`, async () => {
        seedCatalogue()
        await runImport(
          { bytes: fakePdfBytes('cams'), originalName: 'cas.pdf' },
          deps(camsDetailedPages({ hdfc: camsName })),
        )
        const afterCams = store.snapshot().accounts.length

        await runImport(
          { bytes: fakePdfBytes('nsdl'), originalName: 'ecas.pdf' },
          deps(nsdlEcasPages({ hdfc: nsdlName })),
        )

        const accounts = store.snapshot().accounts
        expect(accounts.filter((a) => a.identityKey === EXPECTED_KEY)).toHaveLength(1)
        expect(accounts.filter((a) => a.identityKey?.includes(FOLIO))).toHaveLength(1)
        // The eCAS adds exactly one account: the demat one it also carries.
        expect(accounts).toHaveLength(afterCams + 1)

        // And the holding is stated once, not twice.
        const held = store.snapshot().positions.filter((p) => p.instrumentId === 'i-hdfc')
        expect(new Set(held.map((p) => p.accountId)).size).toBe(1)
      })
    }
  }

  it('agrees with the Summary template too', async () => {
    seedCatalogue()
    await runImport(
      { bytes: fakePdfBytes('summary'), originalName: 'summary.pdf' },
      deps(camsSummaryPages({ hdfc: AMC_SPELLINGS.hdfc[2] })),
    )
    await runImport(
      { bytes: fakePdfBytes('detailed'), originalName: 'cas.pdf' },
      deps(camsDetailedPages({ hdfc: AMC_SPELLINGS.hdfc[0] })),
    )
    const hdfc = store.snapshot().accounts.filter((a) => a.identityKey === EXPECTED_KEY)
    expect(hdfc).toHaveLength(1)
    // Capability is still monotonic upward across the two spellings.
    expect(hdfc[0]?.capability).toBe('ledger')
  })

  it('labels the account from the registry, not from whichever document arrived first', async () => {
    seedCatalogue()
    const outcome = completed(
      await runImport(
        { bytes: fakePdfBytes('cams'), originalName: 'cas.pdf' },
        deps(camsDetailedPages({ hdfc: AMC_SPELLINGS.hdfc[2] })),
      ),
    )
    expect(outcome.status).toBe('completed')
    const hdfc = store.snapshot().accounts.find((a) => a.identityKey === EXPECTED_KEY)
    expect(hdfc?.label).toBe(`${findByPrintedName('HDFC Mutual Fund')?.canonicalName ?? ''} · ${FOLIO}`)
  })
})

describe('an AMC the registry does not know', () => {
  /** The same statement, printed by a fund house Misal has never catalogued. */
  function unknownHousePages(name: string): RawPdfPage[] {
    return camsDetailedPages({ hdfc: name, hdfcIsin: 'INF999Z01019' })
  }

  it('never coins an identity key that looks canonical', async () => {
    const outcome = completed(
      await runImport(
        { bytes: fakePdfBytes('unknown'), originalName: 'cas.pdf' },
        deps(unknownHousePages('Novus Capital Mutual Fund')),
      ),
    )
    const account = store.snapshot().accounts.find((a) => a.identityKey?.includes(FOLIO))
    expect(account?.identityKey).toContain(PROVISIONAL_MARKER)
    expect(outcome.issues.filter((i) => i.code === 'W_AMC_UNRECOGNISED')).toHaveLength(1)
  })

  it('still lands one account when the two documents spell the unknown house differently', async () => {
    // Because both printed the same ISIN, which is the identifier that does not vary.
    await runImport(
      { bytes: fakePdfBytes('a'), originalName: 'a.pdf' },
      deps(unknownHousePages('Novus Capital Mutual Fund')),
    )
    await runImport(
      { bytes: fakePdfBytes('b'), originalName: 'b.pdf' },
      deps(unknownHousePages('Novus Capital Asset Management Company Limited')),
    )
    expect(store.snapshot().accounts.filter((a) => a.identityKey?.includes(FOLIO))).toHaveLength(1)
  })
})
