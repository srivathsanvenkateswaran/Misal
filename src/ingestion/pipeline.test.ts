import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore } from './memory-store'
import { runImport, type ImportDeps, type ImportOutcome } from './pipeline'
import { camsKfinCasPlugin } from './pdf/cams-kfin-cas'
import { nsdlEcasPlugin } from './pdf/nsdl-ecas'
import { csvDescriptorPlugin } from './csv/csv-plugin'
import { builtinDescriptor, readFixtureBytes } from './testing/fixtures'
import { fakePdfBytes, fakePdfSource } from './testing/fake-pdf'
import {
  camsDetailedPages,
  camsSummaryPages,
  nsdlEcasPages,
  scannedPages,
} from './testing/corpus'
import { buildPages } from './testing/pdf-builder'
import type { PasswordPrompt } from './pdf/source'
import type { ExtractPlugin } from './plugin'
import type { RawPdfPage } from './types'

const NOW = '2026-08-12T10:00:00+05:30'

let store: MemoryStore
let counter: number

const plugins = (): ExtractPlugin[] => [
  camsKfinCasPlugin,
  nsdlEcasPlugin,
  csvDescriptorPlugin(builtinDescriptor('zerodha-console-tradebook')),
  csvDescriptorPlugin(builtinDescriptor('mybroker-account-statement')),
]

function deps(pages?: readonly RawPdfPage[], extra: Partial<ImportDeps> = {}): ImportDeps {
  return {
    store,
    plugins: plugins(),
    now: () => NOW,
    newId: () => `id-${String((counter += 1))}`,
    ...(pages !== undefined ? { pdfSource: fakePdfSource(pages) } : {}),
    ...extra,
  }
}

/** The instrument catalogue Subsystem D seeds. Ingestion never creates one of these. */
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
  store.seedInstrument({
    id: 'i-tcs',
    assetClass: 'indian_equity',
    displayName: 'TCS',
    isin: 'INE467B01029',
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

describe('document-level idempotency', () => {
  it('re-importing the same file changes nothing and creates no run', async () => {
    seedCatalogue()
    const bytes = fakePdfBytes('cams-detailed')
    const first = completed(await runImport({ bytes, originalName: 'cas.pdf' }, deps(camsDetailedPages())))
    const before = store.snapshot()

    const second = await runImport({ bytes, originalName: 'cas.pdf' }, deps(camsDetailedPages()))
    expect(second.status).toBe('already-imported')
    expect(store.snapshot().txns).toHaveLength(before.txns.length)
    expect(store.snapshot().runs).toHaveLength(1)
    expect(first.counters.committed).toBeGreaterThan(0)
  })

  it('the same statement re-downloaded hashes differently, and the natural key catches it', async () => {
    seedCatalogue()
    completed(
      await runImport(
        { bytes: fakePdfBytes('download-1'), originalName: 'cas.pdf' },
        deps(camsDetailedPages()),
      ),
    )
    const txnsAfterFirst = store.snapshot().txns.length

    const second = completed(
      await runImport(
        { bytes: fakePdfBytes('download-2'), originalName: 'cas.pdf' },
        deps(camsDetailedPages()),
      ),
    )
    expect(store.snapshot().txns).toHaveLength(txnsAfterFirst)
    expect(second.counters.committed).toBe(0)
    // Every transaction and every holding: a second source_document with nothing new in it.
    expect(second.counters.duplicate).toBe(txnsAfterFirst + store.snapshot().positions.length)
  })

  it('keeps both of two identical same-day SIP instalments, on both imports', async () => {
    seedCatalogue()
    await runImport({ bytes: fakePdfBytes('a'), originalName: 'cas.pdf' }, deps(camsDetailedPages()))
    const may = store
      .snapshot()
      .txns.filter((t) => t.occurredAt.startsWith('2021-05-15'))
    expect(may).toHaveLength(2)
    // Same natural key, different occurrence: that is the whole mechanism.
    expect(new Set(may.map((t) => t.naturalKey)).size).toBe(1)
    expect(may.map((t) => t.occurrence).sort()).toEqual([0, 1])

    await runImport({ bytes: fakePdfBytes('b'), originalName: 'cas.pdf' }, deps(camsDetailedPages()))
    expect(store.snapshot().txns.filter((t) => t.occurredAt.startsWith('2021-05-15'))).toHaveLength(2)
  })
})

describe('account identity across providers', () => {
  it('resolves one folio arriving from CAMS and from NSDL to a single account', async () => {
    seedCatalogue()
    await runImport({ bytes: fakePdfBytes('cams'), originalName: 'cas.pdf' }, deps(camsDetailedPages()))
    const afterCams = store.snapshot().accounts.length

    await runImport({ bytes: fakePdfBytes('nsdl'), originalName: 'ecas.pdf' }, deps(nsdlEcasPages()))
    const accounts = store.snapshot().accounts
    const hdfc = accounts.filter((a) => a.identityKey === 'mf-folio:hdfc:12345678/0')

    // The failure this guards against doubles the user's net worth, and it is the worst failure
    // available to this product.
    expect(hdfc).toHaveLength(1)
    // NSDL adds exactly one new account: the demat one.
    expect(accounts).toHaveLength(afterCams + 1)
    expect(accounts.some((a) => a.identityKey === 'demat:IN300394-12345678')).toBe(true)
    // The provider recorded is whichever document created the row first.
    expect(hdfc[0]?.providerId).toBe('cams-cas')
  })

  it('does not let a snapshot source downgrade a ledger account', async () => {
    seedCatalogue()
    await runImport({ bytes: fakePdfBytes('cams'), originalName: 'cas.pdf' }, deps(camsDetailedPages()))
    await runImport({ bytes: fakePdfBytes('nsdl'), originalName: 'ecas.pdf' }, deps(nsdlEcasPages()))
    const hdfc = store.snapshot().accounts.find((a) => a.identityKey?.includes('hdfc'))
    expect(hdfc?.capability).toBe('ledger')
  })

  it('upgrades a folio first seen in a Summary and later in a Detailed statement', async () => {
    seedCatalogue()
    await runImport({ bytes: fakePdfBytes('summary'), originalName: 'summary.pdf' }, deps(camsSummaryPages()))
    expect(store.snapshot().accounts[0]?.capability).toBe('snapshot')

    await runImport({ bytes: fakePdfBytes('detailed'), originalName: 'cas.pdf' }, deps(camsDetailedPages()))
    const hdfc = store.snapshot().accounts.find((a) => a.identityKey?.includes('hdfc'))
    expect(hdfc?.capability).toBe('ledger')
    expect(store.snapshot().accounts.filter((a) => a.identityKey?.includes('hdfc'))).toHaveLength(1)
  })

  it('restates a position rather than duplicating it, and says so', async () => {
    seedCatalogue()
    await runImport({ bytes: fakePdfBytes('nsdl-1'), originalName: 'ecas.pdf' }, deps(nsdlEcasPages()))
    const restated = restatedPages()
    const second = completed(
      await runImport({ bytes: fakePdfBytes('nsdl-2'), originalName: 'ecas.pdf' }, deps(restated)),
    )
    const infy = store.snapshot().positions.filter((p) => p.instrumentId === 'i-infy')
    expect(infy).toHaveLength(1)
    expect(infy[0]?.quantity).toBe('9.000')
    expect(second.issues.some((i) => i.code === 'W_POSITION_RESTATED')).toBe(true)
  })
})

describe('instrument resolution and the review queue', () => {
  it('withholds every row of a file with no resolvable instrument, and completes', async () => {
    const outcome = completed(
      await runImport(
        {
          bytes: readFixtureBytes('csv/mybroker-account-statement.csv'),
          originalName: 'mybroker.csv',
        },
        deps(),
      ),
    )

    expect(store.snapshot().txns).toHaveLength(0)
    const queue = store.snapshot().unresolved
    expect(queue).toHaveLength(1)
    expect(queue[0]?.rawIdentifier).toBe('provider-local:532540')
    expect(queue[0]?.rawName).toBe('TCS LTD')
    expect(queue[0]?.assetClassHint).toBe('indian_equity')
    // 38,505.00 in, 16,480.00 back out: what the user has at stake in a thing Misal cannot name.
    expect(queue[0]?.observedValueMinor).toBe('2202500')
    expect(outcome.counters.withheld).toBe(3)
    expect(outcome.issues.filter((i) => i.code === 'W_UNRESOLVED_INSTRUMENT')).toHaveLength(3)
  })

  it('commits every row once the alias exists', async () => {
    store.seedInstrument({
      id: 'i-tcs',
      assetClass: 'indian_equity',
      displayName: 'TCS',
      isin: 'INE467B01029',
      currency: 'INR',
    })
    store.seedAlias({ instrumentId: 'i-tcs', scheme: 'provider-local', value: '532540', providerId: 'mybroker' })

    completed(
      await runImport(
        {
          bytes: readFixtureBytes('csv/mybroker-account-statement.csv'),
          originalName: 'mybroker.csv',
        },
        deps(),
      ),
    )
    expect(store.snapshot().txns).toHaveLength(3)
    expect(store.snapshot().unresolved).toHaveLength(0)
  })

  it('never invents an instrument', async () => {
    await runImport(
      { bytes: readFixtureBytes('csv/mybroker-account-statement.csv'), originalName: 'mybroker.csv' },
      deps(),
    )
    expect(store.snapshot().instruments).toHaveLength(0)
  })
})

describe('partial imports', () => {
  it('fails only the bad rows, completes the run, and keeps a replayable payload', async () => {
    seedCatalogue()
    const outcome = completed(
      await runImport(
        {
          bytes: readFixtureBytes('csv/zerodha-console-tradebook-damaged.csv'),
          originalName: 'tradebook.csv',
        },
        deps(),
      ),
    )

    const run = store.snapshot().runs[0]
    expect(run?.status).toBe('completed')
    expect(run?.rowsFailed).toBe(3)
    expect(run?.rowsCommitted).toBe(2)
    // The counters are the import report, and they have to reconcile.
    expect(run?.rowsRead).toBe(
      (run?.rowsCommitted ?? 0) + (run?.rowsDuplicate ?? 0) + (run?.rowsSkipped ?? 0) + (run?.rowsFailed ?? 0),
    )
    expect(store.snapshot().txns).toHaveLength(2)

    const failures = store.snapshot().issues.filter((i) => i.severity === 'error')
    expect(failures).toHaveLength(3)
    for (const issue of failures) {
      expect(issue.rawPayload).not.toBeNull()
      expect(JSON.parse(issue.rawPayload ?? '{}')).toHaveProperty('symbol')
      expect(issue.resolution).toBe('open')
    }
    expect(outcome.counters.failed).toBe(3)
  })
})

describe('document-level failures', () => {
  it('asks for a password, and writes nothing when it is not given', async () => {
    const outcome = await runImport(
      { bytes: fakePdfBytes('locked'), originalName: 'cas.pdf' },
      deps(undefined, { pdfSource: fakePdfSource(camsDetailedPages(), { password: 'test-password' }) }),
    )
    expect(outcome.status).toBe('failed')
    expect(outcome.status === 'failed' && outcome.code).toBe('E_PASSWORD_REQUIRED')
    // Writing a source_document here would burn the content hash and permanently block the file.
    expect(store.snapshot().documents).toHaveLength(0)
    expect(store.snapshot().runs).toHaveLength(0)
  })

  it('opens the file when the prompt supplies the password', async () => {
    seedCatalogue()
    const prompt: PasswordPrompt = () => Promise.resolve('test-password')
    const outcome = await runImport(
      { bytes: fakePdfBytes('locked'), originalName: 'cas.pdf', password: prompt },
      deps(undefined, {
        pdfSource: fakePdfSource(camsDetailedPages(), { password: 'test-password' }),
      }),
    )
    expect(outcome.status).toBe('completed')
  })

  it('gives up after three rounds', async () => {
    let rounds = 0
    const prompt: PasswordPrompt = () => {
      rounds += 1
      return Promise.resolve('wrong')
    }
    const outcome = await runImport(
      { bytes: fakePdfBytes('locked'), originalName: 'cas.pdf', password: prompt },
      deps(undefined, { pdfSource: fakePdfSource(camsDetailedPages(), { password: 'right' }) }),
    )
    expect(rounds).toBe(3)
    expect(outcome.status === 'failed' && outcome.code).toBe('E_PASSWORD_INCORRECT')
  })

  it('refuses a scan with a message that offers a remedy', async () => {
    const outcome = await runImport(
      { bytes: fakePdfBytes('scan'), originalName: 'cas.pdf' },
      deps(undefined, { pdfSource: fakePdfSource(scannedPages(), { hasImages: true }) }),
    )
    expect(outcome.status === 'failed' && outcome.code).toBe('E_SCANNED_PDF')
    expect(outcome.status === 'failed' && outcome.message).toMatch(/registrar|CSV/)
  })

  it('does not call a sparse but genuinely textual page a scan', async () => {
    const outcome = await runImport(
      { bytes: fakePdfBytes('sparse'), originalName: 'cas.pdf' },
      deps(undefined, { pdfSource: fakePdfSource(scannedPages(), { hasImages: false }) }),
    )
    // Not E_SCANNED_PDF: it is refused for what it actually is, an unrecognised format.
    expect(outcome.status === 'failed' && outcome.code).toBe('E_UNKNOWN_FORMAT')
  })

  it('refuses a DP transaction statement by name', async () => {
    const pages = buildPages([
      {
        rows: [
          'TRANSACTION STATEMENT',
          'Statement of transactions for the period',
          'ISIN Security Settlement No Settlement Type',
          '~~~End of Statement~~~',
        ],
      },
    ])
    const outcome = await runImport(
      { bytes: fakePdfBytes('dp'), originalName: 'dp.pdf' },
      deps(undefined, { pdfSource: fakePdfSource(pages) }),
    )
    expect(outcome.status === 'failed' && outcome.code).toBe('E_DP_STATEMENT')
  })

  it('refuses an MF Central statement by name', async () => {
    const pages = buildPages([
      { rows: ['SUMMARY OF HOLDINGS AS ON 31-Mar-2025', 'TRANSACTION DETAILS', 'LOAD STRUCTURES'] },
    ])
    const outcome = await runImport(
      { bytes: fakePdfBytes('mfcentral'), originalName: 'mfc.pdf' },
      deps(undefined, { pdfSource: fakePdfSource(pages) }),
    )
    expect(outcome.status === 'failed' && outcome.code).toBe('E_MFCENTRAL_UNSUPPORTED')
  })

  it('fails loudly when two plugins claim the same file', async () => {
    const twin: ExtractPlugin = { ...camsKfinCasPlugin, id: 'cams-kfin-cas-twin' }
    const outcome = await runImport(
      { bytes: fakePdfBytes('twins'), originalName: 'cas.pdf' },
      {
        store,
        plugins: [camsKfinCasPlugin, twin],
        now: () => NOW,
        newId: () => `id-${String((counter += 1))}`,
        pdfSource: fakePdfSource(camsDetailedPages()),
      },
    )
    expect(outcome.status === 'failed' && outcome.code).toBe('E_AMBIGUOUS_FORMAT')
  })

  it('keeps what a crashing plugin emitted before it threw', async () => {
    seedCatalogue()
    const crashing: ExtractPlugin = {
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
    const outcome = completed(
      await runImport(
        { bytes: fakePdfBytes('crash'), originalName: 'cas.pdf' },
        {
          store,
          plugins: [crashing],
          now: () => NOW,
          newId: () => `id-${String((counter += 1))}`,
          pdfSource: fakePdfSource(camsDetailedPages()),
        },
      ),
    )
    expect(outcome.issues.some((i) => i.code === 'E_PLUGIN_CRASH')).toBe(true)
    expect(store.snapshot().accounts).toHaveLength(1)
  })
})

describe('provenance', () => {
  it('records the document, the run and the period, and attributes rows to accounts', async () => {
    seedCatalogue()
    const outcome = completed(
      await runImport({ bytes: fakePdfBytes('cams'), originalName: 'cas.pdf' }, deps(camsDetailedPages())),
    )
    const document = store.snapshot().documents[0]
    expect(document?.kind).toBe('cas-pdf')
    expect(document?.originalName).toBe('cas.pdf')
    expect(document?.pageRef).toBe('p.1-2')
    expect(document?.periodStart).toBe('1990-04-01T00:00:00+05:30')
    // Two accounts in one document, so the attribution lives on the rows, not on the document.
    expect(document?.accountId).toBeNull()
    for (const txn of store.snapshot().txns) {
      expect(txn.sourceDocumentId).toBe(document?.id)
      expect(outcome.accountIds).toContain(txn.accountId)
    }
  })
})

/** The NSDL fixture with one holding restated: 8 shares became 9. */
function restatedPages(): RawPdfPage[] {
  return nsdlEcasPages().map((page) => ({
    ...page,
    items: page.items.map((item) => (item.text === '8.000' ? { ...item, text: '9.000' } : item)),
  }))
}
