import { describe, expect, it } from 'vitest'
import { recordGolden, serializeGolden } from '../golden'
import { golden } from '../testing/fixtures'
import {
  SHARED_FOLIO_SBI_ISIN,
  camsDetailedPages,
  nsdlEcasMissedClaimantPages,
  nsdlEcasOrphanHoldingPages,
  nsdlEcasPages,
  nsdlEcasSharedFolioPages,
  nsdlEcasSharedFolioStrayIsinPages,
  nsdlEcasTwoDematPages,
  nsdlEcasUnreadRosterPages,
} from '../testing/corpus'
import { MemoryStore } from '../memory-store'
import { runImport } from '../pipeline'
import { camsKfinCasPlugin } from './cams-kfin-cas'
import { fakePdfBytes, fakePdfSource } from '../testing/fake-pdf'
import { reconstructDocument } from './layout'
import { nsdlEcasPlugin } from './nsdl-ecas'
import type {
  DecodedInput,
  NormalizedAccount,
  NormalizedPosition,
  RawPdfPage,
} from '../types'

function input(info: Record<string, string> = {}, raw: readonly RawPdfPage[] = nsdlEcasPages()): DecodedInput {
  const pages = reconstructDocument(raw)
  return { kind: 'pdf-text', pages, meta: { pageCount: pages.length, info, encrypted: true, hasTextLayer: true } }
}

async function run() {
  return recordGolden(nsdlEcasPlugin, input())
}

async function runOn(raw: readonly RawPdfPage[]) {
  return recordGolden(nsdlEcasPlugin, input({}, raw))
}

/** Every equity holding, as `<account key> <isin> <quantity>`. */
function holdings(records: readonly NormalizedPosition[]): string[] {
  return records
    .filter((r) => r.instrument.assetClassHint === 'indian_equity')
    .map((r) => `${r.accountKey} ${r.instrument.isin ?? '?'} ${r.quantity.value}`)
    .sort()
}

function positionsOf(records: readonly { kind: string }[]): NormalizedPosition[] {
  return records.filter((r): r is NormalizedPosition => r.kind === 'position')
}

describe('nsdl ecas', () => {
  it('matches its golden file', async () => {
    const actual = serializeGolden(await run())
    expect(actual).toBe(golden('pdf-text/golden/nsdl-ecas.json', actual))
  })

  it('prefers metadata to body text when detecting', () => {
    expect(nsdlEcasPlugin.detect(input({ Title: 'NSDL-Consolidated Account Statement' }))).toBe(0.97)
    expect(nsdlEcasPlugin.detect(input())).toBeGreaterThan(0.9)
  })

  it('is always a snapshot, however many transactions it contains', async () => {
    const { records } = await run()
    const accounts = records.filter((r): r is NormalizedAccount => r.kind === 'account')
    expect(accounts).toHaveLength(2)
    expect(accounts.every((a) => a.capability === 'snapshot')).toBe(true)
    // And never carries a downgrade marker: a one-month file has no opinion about a folio's
    // history, so it must not pull a registrar-sourced ledger down.
    expect(accounts.every((a) => a.downgradedFrom === undefined)).toBe(true)
  })

  it('keys a demat account on DP and client id, and an MF folio on AMC and folio', async () => {
    const { records } = await run()
    const keys = records
      .filter((r): r is NormalizedAccount => r.kind === 'account')
      .map((a) => a.accountKey)
      .sort()
    expect(keys).toEqual(['demat:IN300394-12345678', 'mf-folio:hdfc:12345678/0'])
  })

  it('takes the exchange symbol the ISIN cell gives away for free', async () => {
    const { records } = await run()
    const equity = records.find(
      (r): r is NormalizedPosition => r.kind === 'position' && r.instrument.isin === 'INE009A01021',
    )
    expect(equity?.instrument.symbol).toBe('INFY')
    expect(equity?.instrument.exchange).toBe('NSE')
    expect(equity?.quantity.value).toBe('8.000')
    expect(equity?.marketValueMinor).toBe('1288600')
  })

  it('ingests units and value, and refuses the statement own cost and return figures', async () => {
    const { records } = await run()
    const folio = records.find(
      (r): r is NormalizedPosition => r.kind === 'position' && r.accountKey.startsWith('mf-folio'),
    )
    expect(folio?.quantity.value).toBe('147.300')
    // Two sources of truth for one number is how a net-worth tool starts disagreeing with itself.
    expect(JSON.stringify(folio)).not.toMatch(/annualised|averageCost|totalCost/i)
  })
})

/**
 * Two demat accounts under one PAN.
 *
 * Every assertion here fails against the parser as it was, which attributed every holding in the
 * file to `accounts.values().find(a => a.key.startsWith('demat:'))` — the first demat account the
 * roster declared. The single-account fixture could not tell that apart from correct.
 */
describe('a statement with more than one demat account', () => {
  it('matches its golden file', async () => {
    const actual = serializeGolden(await runOn(nsdlEcasTwoDematPages()))
    expect(actual).toBe(golden('pdf-text/golden/nsdl-ecas-two-demat.json', actual))
  })

  it('declares both demat accounts, including the CDSL one an NSDL CAS carries', async () => {
    const { records } = await runOn(nsdlEcasTwoDematPages())
    const keys = records
      .filter((r): r is NormalizedAccount => r.kind === 'account')
      .map((a) => a.accountKey)
      .sort()
    expect(keys).toEqual([
      'demat:12081600-87654321',
      'demat:IN300394-12345678',
      'mf-folio:hdfc:12345678/0',
    ])
  })

  it('attributes each holding to the account it is printed under', async () => {
    const { records } = await runOn(nsdlEcasTwoDematPages())
    expect(holdings(positionsOf(records))).toEqual([
      'demat:12081600-87654321 INE009A01021 12.000',
      'demat:12081600-87654321 INE467B01029 7.000',
      'demat:IN300394-12345678 INE009A01021 8.000',
      'demat:IN300394-12345678 INE467B01029 3.000',
    ])
  })

  /**
   * The whole reason this is a data-loss bug rather than a reporting one.
   *
   * `position` carries `UNIQUE (account_id, instrument_id, as_of)`. One ISIN held in two accounts,
   * attributed to one account, is two rows on one key: the second restates the first and the units
   * of one of them are gone — no error, no warning, a smaller number.
   */
  it('never emits two holdings of one ISIN against one account on one date', async () => {
    const { records } = await runOn(nsdlEcasTwoDematPages())
    const keys = positionsOf(records).map(
      (p) => `${p.accountKey}|${p.instrument.isin ?? '?'}|${p.asOf}`,
    )
    expect(new Set(keys).size).toBe(keys.length)
    // And the ISIN genuinely held twice is present twice, under different accounts.
    const infy = positionsOf(records).filter((p) => p.instrument.isin === 'INE009A01021')
    expect(infy.map((p) => p.quantity.value).sort()).toEqual(['12.000', '8.000'])
  })

  it('reports no issues when every holding has an account header above it', async () => {
    const { issues } = await runOn(nsdlEcasTwoDematPages())
    expect(issues).toEqual([])
  })
})

describe('a holding whose account cannot be determined', () => {
  it('fails the row with a stated reason rather than attaching it to the first account', async () => {
    const { records, issues } = await runOn(nsdlEcasOrphanHoldingPages())

    // The orphaned rows are not silently attributed to the account that follows them.
    expect(holdings(positionsOf(records))).toEqual([
      'demat:12081600-87654321 INE009A01021 12.000',
      'demat:12081600-87654321 INE467B01029 7.000',
    ])

    const failed = issues.filter((i) => i.code === 'E_MISSING_REQUIRED_FIELD')
    expect(failed).toHaveLength(2)
    expect(failed.every((i) => i.severity === 'error')).toBe(true)
    expect(failed[0]?.message).toMatch(/cannot be decided/)
    // Replayable: the import report has to be able to show the user the row it dropped.
    expect(failed.every((i) => i.raw !== undefined)).toBe(true)
  })

  it('still attributes the holdings of a statement that declares one demat account and no header', async () => {
    // A document naming exactly one demat account and printing no per-account header at all leaves
    // only one account a holding can belong to. That is a deduction, not a guess, and it is the
    // one case where the absence of a header is not a hole in the parse.
    const { records, issues } = await runOn(strip(nsdlEcasPages(), /^(NSDL Demat Account|DP ID : |Client ID : )/))
    expect(issues).toEqual([])
    expect(holdings(positionsOf(records))).toEqual(['demat:IN300394-12345678 INE009A01021 8.000'])
  })
})

/**
 * One folio *number*, two fund houses.
 *
 * Folio numbers are issued per registrar, so the same number under HDFC and under SBI is two
 * accounts, and every assertion here fails against the parser as it was: it kept a
 * `folio number → fund house` map, last-writer-wins, so the second roster line overwrote the first.
 * One account was emitted where two were owed, both houses' schemes were filed into one evidence
 * bucket, and the surviving account was handed to whichever ISIN issuer prefix printed first.
 */
describe('one folio number claimed by two fund houses', () => {
  it('matches its golden file', async () => {
    const actual = serializeGolden(await runOn(nsdlEcasSharedFolioPages()))
    expect(actual).toBe(golden('pdf-text/golden/nsdl-ecas-shared-folio.json', actual))
  })

  it('emits one account per fund house, not one per folio number', async () => {
    const { records } = await runOn(nsdlEcasSharedFolioPages())
    const keys = records
      .filter((r): r is NormalizedAccount => r.kind === 'account')
      .map((a) => a.accountKey)
      .sort()
    // The old parser emitted `mf-folio:hdfc:12345678/0` alone: the SBI folio got no account at
    // all, and its units were reported against HDFC.
    expect(keys).toEqual([
      'demat:IN300394-12345678',
      'mf-folio:hdfc:12345678/0',
      'mf-folio:sbi:12345678/0',
    ])
  })

  it('files each scheme under the house that issued its ISIN', async () => {
    const { records } = await runOn(nsdlEcasSharedFolioPages())
    const folios = positionsOf(records)
      .filter((p) => p.accountKey.startsWith('mf-folio'))
      .map((p) => `${p.accountKey} ${p.instrument.isin ?? '?'} ${p.quantity.value}`)
      .sort()
    expect(folios).toEqual([
      'mf-folio:hdfc:12345678/0 INF179K01608 147.300',
      `mf-folio:sbi:12345678/0 ${SHARED_FOLIO_SBI_ISIN} 310.400`,
    ])
  })

  it('reports the shared number itself, not a name/ISIN mismatch on one house', async () => {
    const { issues } = await runOn(nsdlEcasSharedFolioPages())
    const shared = issues.filter((i) => i.code === 'W_FOLIO_NUMBER_SHARED')
    expect(shared).toHaveLength(1)
    expect(shared[0]?.severity).toBe('warning')
    expect(shared[0]?.message).toMatch(/SBI Mutual Fund/)
    expect(shared[0]?.message).toMatch(/per registrar/)
    // The old parser's only signal was this, and it described the wrong thing: the houses did not
    // disagree about a name, the parser had merged two folios.
    expect(issues.filter((i) => i.code === 'W_AMC_NAME_CONFLICT')).toHaveLength(0)
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0)
  })

  it('fails a scheme neither claimant issued rather than picking one', async () => {
    const { records, issues } = await runOn(nsdlEcasSharedFolioStrayIsinPages())

    // An Axis ISIN under a number claimed by HDFC and SBI belongs to neither, and no reading of
    // the document says which account holds it.
    const folios = positionsOf(records).filter((p) => p.accountKey.startsWith('mf-folio'))
    expect(folios.map((p) => p.instrument.isin)).toEqual(['INF179K01608'])

    const failed = issues.filter((i) => i.code === 'E_MISSING_REQUIRED_FIELD')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.severity).toBe('error')
    expect(failed[0]?.message).toMatch(/does not identify which of them issued it/)
    // Replayable: the import report has to be able to show the user the row it dropped.
    expect(failed[0]?.raw).toBeDefined()

    // And the house whose scheme went missing still has its account, so the gap is visible rather
    // than silent.
    const keys = records
      .filter((r): r is NormalizedAccount => r.kind === 'account')
      .map((a) => a.accountKey)
    expect(keys).toContain('mf-folio:sbi:12345678/0')
  })
})

/**
 * One folio number, two fund houses, and a roster that names **one** of them.
 *
 * The residual the shared-folio fix left open. With a single claimant there is nothing to
 * overwrite, so scoping the roster's claims on (house, number) does not help: both houses' schemes
 * attach to the one claimant, and `resolveAmc` hands the account to whichever issuer prefix printed
 * first. Every assertion here fails against that parser, which emits one account and files 310.400
 * SBI units into it.
 *
 * The evidence is on the rows: every scheme in a folio belongs to one house, so two issuers under
 * one number is two folios whatever the roster printed.
 */
describe('one folio number whose roster names only one of its houses', () => {
  it('matches its golden file', async () => {
    const actual = serializeGolden(await runOn(nsdlEcasMissedClaimantPages()))
    expect(actual).toBe(golden('pdf-text/golden/nsdl-ecas-missed-claimant.json', actual))
  })

  it('splits the number into one account per issuing house', async () => {
    const { records } = await runOn(nsdlEcasMissedClaimantPages())
    const keys = records
      .filter((r): r is NormalizedAccount => r.kind === 'account')
      .map((a) => a.accountKey)
      .sort()
    // The roster names HDFC alone; `mf-folio:sbi:12345678/0` is deduced from the SBI scheme's ISIN.
    expect(keys).toEqual([
      'demat:IN300394-12345678',
      'mf-folio:hdfc:12345678/0',
      'mf-folio:sbi:12345678/0',
    ])
  })

  it('files each scheme under the house that issued its ISIN', async () => {
    const { records } = await runOn(nsdlEcasMissedClaimantPages())
    const folios = positionsOf(records)
      .filter((p) => p.accountKey.startsWith('mf-folio'))
      .map((p) => `${p.accountKey} ${p.instrument.isin ?? '?'} ${p.quantity.value}`)
      .sort()
    expect(folios).toEqual([
      'mf-folio:hdfc:12345678/0 INF179K01608 147.300',
      `mf-folio:sbi:12345678/0 ${SHARED_FOLIO_SBI_ISIN} 310.400`,
    ])
  })

  it('reports the folio the roster did not name, and fails nothing', async () => {
    const { issues } = await runOn(nsdlEcasMissedClaimantPages())
    const shared = issues.filter((i) => i.code === 'W_FOLIO_NUMBER_SHARED')
    expect(shared).toHaveLength(1)
    expect(shared[0]?.severity).toBe('warning')
    expect(shared[0]?.message).toMatch(/listed once/)
    expect(shared[0]?.message).toMatch(/SBI Mutual Fund/)
    // A deduced folio is stated as a deduction, not as something the document said.
    expect(shared[0]?.message).toMatch(/the roster named only one of them/)
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
  })

  /**
   * The other half of the decision, and the reason it needed making.
   *
   * A single claimant whose printed name disagrees with its ISIN is a folio the roster *misnamed*,
   * not a folio it missed: one house, one folio, one account, corrected by the ISIN and reported as
   * `W_AMC_NAME_CONFLICT`. Splitting that would fork one folio into two accounts, which is the bug
   * the AMC registry exists to prevent. What separates the two cases is how many houses the
   * *schemes'* ISINs name — a misnaming is a name disagreeing with an ISIN, and one folio's schemes
   * still name one house.
   */
  it('still merges a folio whose roster misnames its house', async () => {
    const { records, issues } = await runOn(nsdlEcasPages({ hdfc: 'SBI Mutual Fund' }))
    const folios = records
      .filter((r): r is NormalizedAccount => r.kind === 'account')
      .map((a) => a.accountKey)
      .filter((key) => key.startsWith('mf-folio'))
    expect(folios).toEqual(['mf-folio:hdfc:12345678/0'])

    const conflict = issues.filter((i) => i.code === 'W_AMC_NAME_CONFLICT')
    expect(conflict).toHaveLength(1)
    expect(issues.filter((i) => i.code === 'W_FOLIO_NUMBER_SHARED')).toEqual([])
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
  })
})

/**
 * A roster that names no fund house at all.
 *
 * The shared-folio fix turned a scheme row with no roster claim from a silent drop into a visible
 * error, which is right for one stray row and wrong for a whole file: a real eCAS whose roster
 * geometry this parser reads differently would fail *every* mutual fund row, though each row
 * carries a folio number and an ISIN and the pair is a complete identity.
 */
describe('a statement whose roster claims no folio at all', () => {
  it('matches its golden file', async () => {
    const actual = serializeGolden(await runOn(nsdlEcasUnreadRosterPages()))
    expect(actual).toBe(golden('pdf-text/golden/nsdl-ecas-unread-roster.json', actual))
  })

  it('identifies each folio by its schemes ISIN issuer instead of failing every row', async () => {
    const { records, issues } = await runOn(nsdlEcasUnreadRosterPages())
    const folios = positionsOf(records)
      .filter((p) => p.accountKey.startsWith('mf-folio'))
      .map((p) => `${p.accountKey} ${p.quantity.value}`)
      .sort()
    expect(folios).toEqual([
      'mf-folio:hdfc:12345678/0 147.300',
      `mf-folio:sbi:12345678/0 310.400`,
    ])
    // The identity is the one a parsed roster would have produced — `resolveAmc` prefers the ISIN
    // to the printed name anyway — so nothing forks and nothing is counted twice.
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
  })

  it('says the roster was not read, once for the document', async () => {
    const { issues } = await runOn(nsdlEcasUnreadRosterPages())
    const unrostered = issues.filter((i) => i.code === 'W_FOLIO_NOT_IN_ROSTER')
    expect(unrostered).toHaveLength(1)
    expect(unrostered[0]?.severity).toBe('warning')
    expect(unrostered[0]?.message).toMatch(/12345678\/0/)
    expect(unrostered[0]?.message).toMatch(/identified/)
  })

  /**
   * The fallback is gated on the roster having claimed *nothing*, exactly as `emitDematPositions`
   * is gated on `sawAnyHeader`. A roster that demonstrably parsed and simply does not mention a
   * number is different evidence: the likeliest reading is a misread folio cell, and minting an
   * account from that would double the units the moment the correctly numbered statement arrives.
   */
  it('still fails a row whose number a working roster never mentions', async () => {
    const { records, issues } = await runOn(
      renumber(nsdlEcasPages(), '12345678 / 0', '99887766 / 0'),
    )
    expect(positionsOf(records).filter((p) => p.accountKey.startsWith('mf-folio'))).toEqual([])
    const failed = issues.filter((i) => i.code === 'E_MISSING_REQUIRED_FIELD')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.message).toMatch(/though the roster named others/)
  })
})

/**
 * The compounding case, and the reason this is a money bug rather than a labelling one.
 *
 * The eCAS misfiles SBI's units into HDFC's account; the registrar's own CAS for SBI then arrives
 * and correctly creates `mf-folio:sbi:…`. `derivePositions` is per `(accountId, instrumentId)`, so
 * one holding is now stated against two accounts and counted twice — no error, no warning, a
 * bigger number. Nothing in either parser can notice it, because each document is internally
 * consistent.
 */
describe('the same folio arriving again from its registrar', () => {
  const NOW = '2026-08-12T10:00:00+05:30'

  function deps(store: MemoryStore, pages: readonly RawPdfPage[]) {
    let counter = 0
    return {
      store,
      plugins: [camsKfinCasPlugin, nsdlEcasPlugin],
      now: () => NOW,
      newId: () => `id-${String((counter += 1))}`,
      pdfSource: fakePdfSource(pages),
    }
  }

  // Both doors to the same defect: a roster that names both houses, and one that names only HDFC
  // and leaves the SBI folio to be deduced from its scheme's ISIN. The second is the residual the
  // first fix left open, and it doubles the units in exactly the same way.
  for (const [door, pages] of [
    ['the roster names both houses', nsdlEcasSharedFolioPages()],
    ['the roster names one house', nsdlEcasMissedClaimantPages()],
  ] as const) {
    it(`states the units once, against one account, when ${door}`, async () => {
      const store = new MemoryStore()
      for (const [id, isin, name] of [
        ['i-hdfc', 'INF179K01608', 'HDFC Flexi Cap Fund'],
        ['i-sbi', SHARED_FOLIO_SBI_ISIN, 'SBI Bluechip Fund'],
        ['i-icici', 'INF109K01BL4', 'ICICI Prudential Bluechip Fund'],
      ] as const) {
        store.seedInstrument({
          id,
          assetClass: 'mutual_fund',
          displayName: name,
          isin,
          currency: 'INR',
        })
      }

      await runImport({ bytes: fakePdfBytes('nsdl'), originalName: 'ecas.pdf' }, deps(store, pages))
      // The registrar's own statement for the *SBI* folio: same number, its own house. Only the
      // folio, the house and the ISIN identify anything here; the scheme name the CAMS fixture
      // prints is immaterial to which account the units land in.
      await runImport(
        { bytes: fakePdfBytes('cams'), originalName: 'cas.pdf' },
        deps(store, camsDetailedPages({ hdfc: 'SBI Mutual Fund', hdfcIsin: SHARED_FOLIO_SBI_ISIN })),
      )

      const held = store.snapshot().positions.filter((p) => p.instrumentId === 'i-sbi')
      expect(held.length).toBeGreaterThan(0)
      // Two account ids here is the doubled net worth: the eCAS copy under HDFC and the registrar's
      // under SBI, both counted.
      expect(new Set(held.map((p) => p.accountId)).size).toBe(1)
      const accounts = store.snapshot().accounts
      expect(accounts.filter((a) => a.identityKey === 'mf-folio:sbi:12345678/0')).toHaveLength(1)
    })
  }
})

function strip(pages: readonly RawPdfPage[], pattern: RegExp): RawPdfPage[] {
  return pages.map((page) => ({ ...page, items: page.items.filter((i) => !pattern.test(i.text)) }))
}

/**
 * Renumber the **last** occurrence of a folio number, which is the holdings table's rather than
 * the roster's: a scheme row carrying a number the roster does not mention.
 */
function renumber(pages: readonly RawPdfPage[], from: string, to: string): RawPdfPage[] {
  let remaining = pages.flatMap((page) => page.items).filter((item) => item.text === from).length
  return pages.map((page) => ({
    ...page,
    items: page.items.map((item) => {
      if (item.text !== from) return item
      remaining -= 1
      return remaining === 0 ? { ...item, text: to } : item
    }),
  }))
}
