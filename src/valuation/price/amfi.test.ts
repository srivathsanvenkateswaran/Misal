/**
 * AMFI parser goldens.
 *
 * The excerpts are redacted-but-real in shape: category headings, fund-house lines, blank lines, a
 * `-` ISIN placeholder, and the discontinued scheme whose NAV date is years old. Both layouts are
 * exercised, because the historical report has eight columns in a different order and a parser that
 * assumes the daily layout fails silently rather than loudly.
 */

import { describe, expect, it } from 'vitest'
import { AmfiProvider, parseAmfi } from './amfi'
import { instrument } from '../__fixtures__/build'

const DAILY = `Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date

Open Ended Schemes(Debt Scheme - Banking and PSU Fund)

Aditya Birla Sun Life Mutual Fund

119551;INF209KA12Z1;INF209KA13Z9;Aditya Birla Sun Life Banking & PSU Debt Fund - DIRECT - IDCW;107.1766;11-Aug-2026
128952;INF846K01NF8;-;Axis Banking & PSU Debt Fund - Direct Plan - Bonus Option;1532.8272;14-Jun-2017

Open Ended Schemes(Equity Scheme - Large Cap Fund)

120503;INF209K01YM2;INF209K01YN0;Aditya Birla Sun Life Frontline Equity Fund - Growth;412.3456;11-Aug-2026
999999;-;-;Scheme With No NAV Published Today;N.A.;11-Aug-2026
`

const HISTORY = `Scheme Code;Scheme Name;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Net Asset Value;Repurchase Price;Sale Price;Date

Aditya Birla Sun Life Mutual Fund

120503;Aditya Birla Sun Life Frontline Equity Fund - Growth;INF209K01YM2;INF209K01YN0;410.1234;410.1234;410.1234;03-Aug-2026
120503;Aditya Birla Sun Life Frontline Equity Fund - Growth;INF209K01YM2;INF209K01YN0;411.5678;411.5678;411.5678;04-Aug-2026
`

describe('daily NAV file', () => {
  const parsed = parseAmfi(DAILY)

  it('reads only the lines that match the header, skipping headings and blanks', () => {
    expect(parsed.rows.map((r) => r.schemeCode)).toEqual(['119551', '128952', '120503'])
    expect(parsed.columns[0]).toBe('Scheme Code')
  })

  it('keeps the NAV as a decimal string, never a float', () => {
    expect(parsed.rows[2]!.nav).toBe('412.3456')
  })

  it('treats a dash as an absent ISIN rather than a value', () => {
    expect(parsed.rows[1]!.isins).toEqual(['INF846K01NF8'])
    expect(parsed.rows[0]!.isins).toEqual(['INF209KA12Z1', 'INF209KA13Z9'])
  })

  it('keeps a discontinued scheme’s years-old date, because staleness is per row', () => {
    expect(parsed.rows[1]!.asOf).toBe('2017-06-14')
    expect(parsed.rows[0]!.asOf).toBe('2026-08-11')
  })

  it('reports an unparseable NAV instead of coercing it', () => {
    expect(parsed.skipped).toHaveLength(1)
    expect(parsed.skipped[0]!.reason).toContain('N.A.')
  })
})

describe('historical NAV report', () => {
  it('maps columns from the header it actually read, not from the URL it requested', () => {
    const parsed = parseAmfi(HISTORY)
    expect(parsed.rows).toHaveLength(2)
    // Under the daily layout, position 1 is an ISIN; here it is the scheme name. Reading the header
    // is the only thing that keeps the two apart.
    expect(parsed.rows[0]!.isins).toEqual(['INF209K01YM2', 'INF209K01YN0'])
    expect(parsed.rows[0]!.schemeName).toContain('Frontline Equity')
    expect(parsed.rows.map((r) => [r.asOf, r.nav])).toEqual([
      ['2026-08-03', '410.1234'],
      ['2026-08-04', '411.5678'],
    ])
  })

  it('fails loudly under a hard-coded daily layout, proving the header is what drives it', () => {
    // Feeding the historical body without its header leaves the parser with no mapping at all,
    // which is a visible failure rather than a silent mismatch.
    const bodyOnly = HISTORY.split('\n').slice(1).join('\n')
    expect(parseAmfi(bodyOnly).rows).toHaveLength(0)
  })
})

describe('AmfiProvider', () => {
  const fund = instrument({
    id: 'fund',
    assetClass: 'mutual_fund',
    aliases: [{ scheme: 'isin', value: 'INF209K01YM2', providerId: null }],
  })

  it('supports only mutual funds it can identify', () => {
    const provider = new AmfiProvider(() => Promise.resolve(DAILY))
    expect(provider.supports(fund)).toBe(true)
    expect(provider.supports(instrument({ assetClass: 'indian_equity' }))).toBe(false)
    expect(provider.supports(instrument({ assetClass: 'mutual_fund' }))).toBe(false)
  })

  it('matches by ISIN and returns the NAV with its own date', async () => {
    const provider = new AmfiProvider(() => Promise.resolve(DAILY))
    const [quote] = await provider.fetchLatest([fund], new AbortController().signal)
    if (quote === undefined || !quote.ok) throw new Error('expected a quote')
    expect(quote.price.value).toBe('412.3456')
    expect(quote.asOf).toBe('2026-08-11')
    // The daily file carries no previous close, so day change is null rather than a fabricated 0%.
    expect(quote.previousClose).toBeNull()
  })

  it('matches by AMFI scheme code when no ISIN is on file', async () => {
    const byCode = instrument({
      id: 'fund',
      assetClass: 'mutual_fund',
      aliases: [{ scheme: 'amfi', value: '119551', providerId: null }],
    })
    const provider = new AmfiProvider(() => Promise.resolve(DAILY))
    const [quote] = await provider.fetchLatest([byCode], new AbortController().signal)
    if (quote === undefined || !quote.ok) throw new Error('expected a quote')
    expect(quote.price.value).toBe('107.1766')
  })

  it('reports NOT_FOUND for a fund the file does not cover, without losing the others', async () => {
    const missing = instrument({
      id: 'missing',
      assetClass: 'mutual_fund',
      aliases: [{ scheme: 'isin', value: 'INF000X00XX0', providerId: null }],
    })
    const provider = new AmfiProvider(() => Promise.resolve(DAILY))
    const quotes = await provider.fetchLatest([fund, missing], new AbortController().signal)
    expect(quotes.map((q) => (q.ok ? 'ok' : q.error.code))).toEqual(['ok', 'NOT_FOUND'])
  })

  it('reports OFFLINE rather than throwing when the fetch fails', async () => {
    const provider = new AmfiProvider(() => Promise.reject(new Error('network down')))
    const [quote] = await provider.fetchLatest([fund], new AbortController().signal)
    if (quote === undefined || quote.ok) throw new Error('expected a failure')
    expect(quote.error.code).toBe('OFFLINE')
  })

  it('parses the historical report through the same header-driven path', async () => {
    const provider = new AmfiProvider(() => Promise.resolve(HISTORY))
    const history = await provider.fetchHistory(
      fund,
      '2026-08-03',
      '2026-08-04',
      new AbortController().signal,
    )
    if (!history.ok) throw new Error('expected history')
    expect(history.value.map((c) => c.close)).toEqual(['410.1234', '411.5678'])
  })
})
