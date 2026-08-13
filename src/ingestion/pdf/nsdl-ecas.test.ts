import { describe, expect, it } from 'vitest'
import { recordGolden, serializeGolden } from '../golden'
import { golden } from '../testing/fixtures'
import {
  nsdlEcasOrphanHoldingPages,
  nsdlEcasPages,
  nsdlEcasTwoDematPages,
} from '../testing/corpus'
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

function strip(pages: readonly RawPdfPage[], pattern: RegExp): RawPdfPage[] {
  return pages.map((page) => ({ ...page, items: page.items.filter((i) => !pattern.test(i.text)) }))
}
