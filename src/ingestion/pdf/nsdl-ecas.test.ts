import { describe, expect, it } from 'vitest'
import { recordGolden, serializeGolden } from '../golden'
import { golden } from '../testing/fixtures'
import { nsdlEcasPages } from '../testing/corpus'
import { reconstructDocument } from './layout'
import { nsdlEcasPlugin } from './nsdl-ecas'
import type { DecodedInput, NormalizedAccount, NormalizedPosition } from '../types'

function input(info: Record<string, string> = {}): DecodedInput {
  const pages = reconstructDocument(nsdlEcasPages())
  return { kind: 'pdf-text', pages, meta: { pageCount: pages.length, info, encrypted: true, hasTextLayer: true } }
}

async function run() {
  return recordGolden(nsdlEcasPlugin, input())
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
    expect(keys).toEqual(['demat:IN300394-12345678', 'mf-folio:hdfc-mutual-fund:12345678/0'])
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
