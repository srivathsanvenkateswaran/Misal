import { describe, expect, it } from 'vitest'
import { recordGolden, serializeGolden } from '../golden'
import { golden, readPdfTextFixture } from '../testing/fixtures'
import {
  camsDetailedDroppedRowPages,
  camsDetailedPages,
  camsDetailedPartialHistoryPages,
  camsSummaryPages,
} from '../testing/corpus'
import { reconstructDocument } from './layout'
import { camsKfinCasPlugin } from './cams-kfin-cas'
import type { DecodedInput, NormalizedAccount, NormalizedTransaction, RawPdfPage } from '../types'

const META = {
  pageCount: 2,
  info: {},
  encrypted: true,
  hasTextLayer: true,
}

function input(pages: RawPdfPage[]): DecodedInput {
  return { kind: 'pdf-text', pages: reconstructDocument(pages), meta: { ...META, pageCount: pages.length } }
}

async function run(pages: RawPdfPage[]) {
  return recordGolden(camsKfinCasPlugin, input(pages))
}

function transactions(records: readonly { kind: string }[]): NormalizedTransaction[] {
  return records.filter((r): r is NormalizedTransaction => r.kind === 'transaction')
}

describe('the Tier-1 corpus is committed and does not drift', () => {
  it('records the detailed statement fixture', () => {
    const actual = `${JSON.stringify(camsDetailedPages(), null, 2)}\n`
    expect(actual).toBe(golden('pdf-text/cams-detailed.json', actual))
  })

  it('parses the committed JSON, not just the in-memory builder', async () => {
    const fromDisk = readPdfTextFixture('pdf-text/cams-detailed.json')
    const { records } = await recordGolden(camsKfinCasPlugin, input(fromDisk))
    // Three purchases (two of them the identical same-day pair), one redemption, one dividend,
    // and the ICICI purchase.
    expect(transactions(records)).toHaveLength(6)
  })
})

describe('cams detailed', () => {
  it('matches its golden file', async () => {
    const actual = serializeGolden(await run(camsDetailedPages()))
    expect(actual).toBe(golden('pdf-text/golden/cams-detailed.json', actual))
  })

  it('detects the family from the generator footer', () => {
    expect(camsKfinCasPlugin.detect(input(camsDetailedPages()))).toBeGreaterThan(0.9)
  })

  it('carries the scheme context across a page break', async () => {
    const { records } = await run(camsDetailedPages())
    const redemption = transactions(records).find((t) => t.txnType === 'sell')
    // The redemption is on page 2, under a repeated column header and no repeated scheme header.
    expect(redemption?.instrument.isin).toBe('INF179K01608')
    expect(redemption?.quantity.value).toBe('-150.000')
    expect(redemption?.amountMinor).toBe('-1000000')
  })

  it('reads an ISIN that was split by a soft hyphen', async () => {
    const { records } = await run(camsDetailedPages())
    const icici = transactions(records).find((t) => t.accountKey.includes('icici'))
    expect(icici?.instrument.isin).toBe('INF109K01BL4')
  })

  it('is not fooled by an overlaid glyph in the date', async () => {
    const { records } = await run(camsDetailedPages())
    const icici = transactions(records).find((t) => t.accountKey.includes('icici'))
    expect(icici?.occurredDate).toBe('2024-01-05')
  })

  it('folds stamp duty into the purchase above it rather than emitting a row', async () => {
    const { records } = await run(camsDetailedPages())
    const sips = transactions(records).filter((t) => t.txnType === 'buy')
    const first = sips[0]
    expect(first?.fees.stampDuty).toBe('25')
    // The printed purchase amount is already net of the levy and is left as printed.
    expect(first?.amountMinor).toBe('499975')
    expect(transactions(records).some((t) => t.origin.raw['description']?.includes('Stamp'))).toBe(false)
  })

  it('keeps two identical same-day SIP instalments as two transactions', async () => {
    const { records } = await run(camsDetailedPages())
    const may = transactions(records).filter((t) => t.occurredDate === '2021-05-15')
    expect(may).toHaveLength(2)
    expect(may[0]?.amountMinor).toBe(may[1]?.amountMinor)
  })

  it('classifies an IDCW payout as a dividend, not a purchase', async () => {
    const { records } = await run(camsDetailedPages())
    const dividend = transactions(records).find((t) => t.txnType === 'dividend')
    expect(dividend?.amountMinor).toBe('29460')
    expect(dividend?.quantity.value).toBe('0')
  })

  it('grants ledger capability when every opening balance is zero and the checksums pass', async () => {
    const { records, issues } = await run(camsDetailedPages())
    const accounts = records.filter((r): r is NormalizedAccount => r.kind === 'account')
    expect(accounts).toHaveLength(2)
    expect(accounts.every((a) => a.capability === 'ledger')).toBe(true)
    expect(issues.filter((i) => i.code === 'W_BALANCE_MISMATCH')).toHaveLength(0)
    expect(accounts.map((a) => a.accountKey).sort()).toEqual([
      'mf-folio:hdfc:12345678/0',
      'mf-folio:icici-prudential:91012424/0',
    ])
  })

  it('downgrades to snapshot when a scheme opens with a non-zero balance', async () => {
    const { records, issues } = await run(camsDetailedPartialHistoryPages())
    const accounts = records.filter((r): r is NormalizedAccount => r.kind === 'account')
    expect(accounts.every((a) => a.capability === 'snapshot')).toBe(true)
    expect(accounts.every((a) => a.downgradedFrom === 'ledger')).toBe(true)
    expect(issues.some((i) => i.code === 'W_INCOMPLETE_HISTORY')).toBe(true)
  })

  it('catches a deleted row through the running balance, and keeps the rest', async () => {
    const { records, issues } = await run(camsDetailedDroppedRowPages())
    const mismatches = issues.filter((i) => i.code === 'W_BALANCE_MISMATCH')
    expect(mismatches.length).toBeGreaterThan(0)
    // Not a crash and not silence: the transactions still commit, the capability does not.
    expect(transactions(records).length).toBeGreaterThan(0)
    const accounts = records.filter((r): r is NormalizedAccount => r.kind === 'account')
    expect(accounts.every((a) => a.capability === 'snapshot')).toBe(true)
  })

  it('emits the closing holding as a position with its market value', async () => {
    const { records } = await run(camsDetailedPages())
    const positions = records.filter((r) => r.kind === 'position')
    expect(positions).toHaveLength(2)
    expect(positions[0]?.kind === 'position' && positions[0].marketValueMinor).toBe('883800')
  })
})

describe('cams summary', () => {
  it('is always a snapshot, and separates a folio glued to its ISIN', async () => {
    const { records } = await run(camsSummaryPages())
    const accounts = records.filter((r): r is NormalizedAccount => r.kind === 'account')
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.accountKey).toBe('mf-folio:hdfc:12345678/0')
    expect(accounts[0]?.capability).toBe('snapshot')
    expect(transactions(records)).toHaveLength(0)
    const position = records.find((r) => r.kind === 'position')
    expect(position?.kind === 'position' && position.quantity.value).toBe('147.300')
  })
})
