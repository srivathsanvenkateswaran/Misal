/**
 * Tax classification: the buckets, the regimes, and the two places where a plausible-looking wrong
 * answer is easiest to produce — netting VDA losses, and guessing a mutual fund's regime.
 */

import { describe, expect, it } from 'vitest'
import { type Measured, REASON_TEXT, fullCoverage, measured } from '@domain/measured'
import { type Minor, minor, subMinor } from '@domain/numeric'
import { inrOnlyFx, instrument, instrumentMap, resetIds, txn, usdFx } from './__fixtures__/build'
import { daysBetween, financialYear, isLongTerm } from './calendar'
import { type FoldInput, buildLots } from './fold'
import { ruleFor } from './tax-rules'
import { classifyDisposal, summariseRealised } from './tax'
import type { Disposal, IncomeInput } from './tax'
import type { FxService } from './fx'
import type { InstrumentRef, TxnRow } from './types'

const AS_OF = '2026-08-12T18:30:00+05:30'

function disposalsFor(txns: readonly TxnRow[], inst: InstrumentRef, fx: FxService = inrOnlyFx()): Disposal[] {
  const input: FoldInput = {
    accountId: 'acc-1',
    capability: 'ledger',
    txns,
    snapshots: [],
    instruments: instrumentMap(inst),
    asOf: AS_OF,
  }
  const folded = buildLots(input)
  if (!folded.ok) throw new Error('fold failed')
  const ledger = folded.value.get(inst.id)!
  return ledger.consumptions.map((c) => classifyDisposal(c, inst, fx)).filter((d): d is Disposal => d !== null)
}

/** Income already converted to INR by the portfolio layer, which is what `summariseRealised` takes. */
function income(amounts: {
  dividendIncomeMinor?: string
  interestIncomeMinor?: string
  tdsCreditMinor?: string
}): IncomeInput {
  const inr = (raw: string | undefined): Measured<Minor> => {
    const value = minor(raw ?? '0')
    return measured(value, fullCoverage(value))
  }
  return {
    dividendIncomeMinor: inr(amounts.dividendIncomeMinor),
    interestIncomeMinor: inr(amounts.interestIncomeMinor),
    tdsCreditMinor: inr(amounts.tdsCreditMinor),
  }
}

describe('holding period', () => {
  it('uses completed calendar months, not a 365-day count', () => {
    // A holding spanning 29 February runs 366 days over twelve calendar months, so `days > 365`
    // calls it long-term one day early. Section 2(42A) counts months: sold exactly twelve months
    // after acquisition is *not* "more than" twelve months, and this one is short-term.
    expect(daysBetween('2023-06-15', '2024-06-15')).toBe(366)
    expect(isLongTerm('2023-06-15', '2024-06-15', 12)).toBe(false)
    expect(isLongTerm('2023-06-15', '2024-06-16', 12)).toBe(true)
  })

  it('derives the Indian financial year from the disposal date', () => {
    expect(financialYear('2026-06-20')).toBe('FY2026-27')
    expect(financialYear('2026-03-31')).toBe('FY2025-26')
    expect(financialYear('2026-04-01')).toBe('FY2026-27')
  })
})

describe('rules table', () => {
  it('applies the rule in force on the transfer date, not today’s rule', () => {
    const before = ruleFor('s112a_listed_equity', '2024-07-22')
    const after = ruleFor('s112a_listed_equity', '2024-07-23')
    expect(before?.shortTermRate).toEqual({ kind: 'flat', pct: '15' })
    expect(after?.shortTermRate).toEqual({ kind: 'flat', pct: '20' })
    expect(before?.annualExemptionMinor).toBe('10000000')
    expect(after?.annualExemptionMinor).toBe('12500000')
  })

  it('gives a specified mutual fund no long-term bucket at all', () => {
    const rule = ruleFor('s50aa_specified_mf', '2026-06-20')
    expect(rule?.longTermThresholdMonths).toBeNull()
    expect(rule?.longTermRate).toEqual({ kind: 'not_applicable' })
  })
})

describe('unknown tax regime', () => {
  it('withholds a mutual fund’s realised gain rather than guessing which regime applies', () => {
    resetIds()
    // asset_class = 'mutual_fund' cannot say whether the scheme is equity-oriented, a specified
    // mutual fund, or something else, and those have different holding periods and rates.
    const fund = instrument({ assetClass: 'mutual_fund' })
    const disposals = disposalsFor(
      [
        txn({ type: 'buy', date: '2020-01-10', quantity: '100', amount: '1000000' }),
        txn({ type: 'sell', date: '2026-01-10', quantity: '100', amount: '1500000' }),
      ],
      fund,
    )
    expect(disposals[0]!.bucket).toEqual({ kind: 'unavailable', reason: 'UNKNOWN_TAX_REGIME' })
    expect(disposals[0]!.gain.measured).toBe(false)
    if (disposals[0]!.gain.measured) return
    expect(disposals[0]!.gain.reason).toBe('unknown_tax_regime')
  })

  it('classifies the same fund once the user has told us which regime it is', () => {
    resetIds()
    const fund = instrument({ assetClass: 'mutual_fund', taxRegime: 'other_mf_unlisted' })
    const disposals = disposalsFor(
      [
        txn({ type: 'buy', date: '2020-01-10', quantity: '100', amount: '1000000' }),
        txn({ type: 'sell', date: '2026-01-10', quantity: '100', amount: '1500000' }),
      ],
      fund,
    )
    expect(disposals[0]!.bucket).toEqual({ kind: 'ltcg', regime: 'other_mf_unlisted' })
    expect(disposals[0]!.gain.measured && disposals[0]!.gain.value).toBe('500000')
  })
})

describe('blocked grandfathering', () => {
  it('names the missing 31-Jan-2018 value rather than blaming the tax regime', () => {
    resetIds()
    // The regime is known — listed Indian equity, section 112A, grandfather-eligible — and the lot
    // predates the cutoff. Exactly one input is missing, and it is one the user can supply.
    const equity = instrument()
    const disposals = disposalsFor(
      [
        txn({ type: 'buy', date: '2015-06-10', quantity: '100', amount: '1000000' }),
        txn({ type: 'sell', date: '2026-01-10', quantity: '100', amount: '5000000' }),
      ],
      equity,
    )
    expect(disposals[0]!.bucket).toEqual({ kind: 'unavailable', reason: 'GRANDFATHER_FMV_UNAVAILABLE' })
    expect(disposals[0]!.gain.measured).toBe(false)
    if (disposals[0]!.gain.measured) return
    expect(disposals[0]!.gain.reason).toBe('no_grandfathering_fmv')
    expect(disposals[0]!.deemedCost.measured).toBe(false)
    expect(REASON_TEXT[disposals[0]!.gain.reason]).toBe('no 31 January 2018 market value on record')
  })

  it('measures the same disposal once the fair market value is on record', () => {
    resetIds()
    const equity = instrument({ fmv: '250.00' })
    const disposals = disposalsFor(
      [
        txn({ type: 'buy', date: '2015-06-10', quantity: '100', amount: '1000000' }),
        txn({ type: 'sell', date: '2026-01-10', quantity: '100', amount: '5000000' }),
      ],
      equity,
    )
    expect(disposals[0]!.grandfathered).toBe(true)
    // Deemed cost is ₹250 a share against an actual ₹100, so the gain is ₹250 rather than ₹400.
    expect(disposals[0]!.gain.measured && disposals[0]!.gain.value).toBe('2500000')
  })
})

describe('virtual digital assets', () => {
  it('reports gross gains and gross losses separately and never nets them', () => {
    resetIds()
    // Section 115BBH allows no set-off of losses, even against other VDA gains. A single netted
    // figure would understate the taxable base, here to a third of the truth.
    const btc = instrument({ assetClass: 'crypto', id: 'inst-1' })
    const disposals = disposalsFor(
      [
        txn({ type: 'buy', date: '2025-01-10', quantity: '1', amount: '5000000' }),
        txn({ type: 'buy', date: '2025-02-10', quantity: '1', amount: '9000000' }),
        txn({ type: 'sell', date: '2025-06-10', quantity: '1', amount: '8000000' }),
        txn({ type: 'sell', date: '2025-07-10', quantity: '1', amount: '7000000' }),
      ],
      btc,
    )
    expect(disposals.map((d) => d.bucket.kind)).toEqual(['vda', 'vda'])

    const summary = summariseRealised(
      disposals,
      income({ tdsCreditMinor: '5000' }),
      'FY2025-26',
    )
    expect(summary.vda.grossGainMinor).toBe('3000000')
    expect(summary.vda.grossLossMinor).toBe('2000000')
    expect(summary.vda.disposalCount).toBe(2)
    // TDS under section 194S is a prepayment of tax, not an expense of transfer.
    expect(summary.tdsCreditMinor.measured && summary.tdsCreditMinor.value).toBe('5000')
    expect(summary.byRegime.size).toBe(0)
  })
})

describe('realised summary', () => {
  it('nets losses within a regime and reports the 112A exemption as informational', () => {
    resetIds()
    const equity = instrument({ fmv: '100.00' })
    const disposals = disposalsFor(
      [
        txn({ type: 'buy', date: '2023-01-10', quantity: '100', amount: '1000000' }),
        txn({ type: 'buy', date: '2023-02-10', quantity: '100', amount: '2000000' }),
        txn({ type: 'sell', date: '2026-01-10', quantity: '100', amount: '1500000' }),
        txn({ type: 'sell', date: '2026-02-10', quantity: '100', amount: '1800000' }),
      ],
      equity,
    )
    const summary = summariseRealised(
      disposals,
      income({ dividendIncomeMinor: '12500' }),
      'FY2025-26',
    )
    const s112a = summary.byRegime.get('s112a_listed_equity')!
    // +₹5,000 on the first lot and −₹2,000 on the second, netted within the regime.
    expect(s112a.ltcgMinor).toBe('300000')
    expect(s112a.exemptionAppliedMinor).toBe('300000')
    expect(summary.dividendIncomeMinor.measured && summary.dividendIncomeMinor.value).toBe('12500')
  })

  it('lists disposals it could not classify instead of dropping them', () => {
    resetIds()
    const fund = instrument({ assetClass: 'mutual_fund' })
    const disposals = disposalsFor(
      [
        txn({ type: 'buy', date: '2024-01-10', quantity: '10', amount: '100000' }),
        txn({ type: 'sell', date: '2025-06-10', quantity: '10', amount: '150000' }),
      ],
      fund,
    )
    const summary = summariseRealised(
      disposals,
      income({}),
      'FY2025-26',
    )
    expect(summary.unavailableDisposals).toHaveLength(1)
    expect(summary.unavailableDisposals[0]!.reason).toBe('UNKNOWN_TAX_REGIME')
    expect(summary.byRegime.size).toBe(0)
  })
})

describe('a disposal in a foreign currency', () => {
  // `us_equity` maps to `foreign_equity` with no user classification at all, so this fires for
  // anyone holding a US share — no opt-in, no warning, nothing to misconfigure.
  const aapl = instrument({ id: 'inst-1', assetClass: 'us_equity', currency: 'USD' })
  const trades = [
    txn({ type: 'buy', date: '2024-01-10', quantity: '20', amount: '200000', currency: 'USD' }),
    txn({ type: 'sell', date: '2026-01-12', quantity: '10', amount: '200000', currency: 'USD' }),
  ]
  // ₹87 to the dollar on the day of the sale.
  const fx = usdFx(['2024-01-10', '83.00'], ['2026-01-12', '87.00'])

  it('converts the gain at the disposal-date rate instead of reporting cents as paise', () => {
    resetIds()
    const [disposal] = disposalsFor(trades, aapl, fx)
    // 20 bought at $100, 10 sold at $200: a $1,000 gain, which is ₹87,000 — not the ₹1,000 that
    // 100,000 *cents* rendered as when it landed in a rupee total.
    expect(disposal!.gain.measured && disposal!.gain.value).toBe('8700000')
    expect(disposal!.grossConsiderationMinor).toBe('17400000')
    expect(disposal!.costMinor).toBe('8700000')
    expect(disposal!.currency).toBe('INR')
    expect(disposal!.fxRate).toBe('87.00')
    expect(disposal!.bucket).toEqual({ kind: 'ltcg', regime: 'foreign_equity' })
  })

  it('keeps gain === gross − expenses − deemed cost in the units it reports', () => {
    resetIds()
    const [disposal] = disposalsFor(trades, aapl, fx)
    if (!disposal!.deemedCost.measured || !disposal!.gain.measured) throw new Error('expected figures')
    expect(
      subMinor(
        subMinor(disposal!.grossConsiderationMinor, disposal!.transferExpensesMinor),
        disposal!.deemedCost.value,
      ),
    ).toBe(disposal!.gain.value)
  })

  it('withholds the disposal entirely when no rate covers the day it happened', () => {
    resetIds()
    // A rate five weeks stale is past `MAX_FX_BACKFILL_DAYS`, so there is no rate for this date.
    const stale = usdFx(['2024-01-10', '83.00'])
    const [disposal] = disposalsFor(trades, aapl, stale)
    expect(disposal!.bucket).toEqual({ kind: 'unavailable', reason: 'NO_FX_RATE' })
    expect(disposal!.gain.measured).toBe(false)
    if (disposal!.gain.measured) return
    expect(disposal!.gain.reason).toBe('no_fx_rate')
    // Nothing is emitted in the transaction's own currency as a consolation figure: an unconverted
    // 200000 here would be read as ₹2,000 by everything downstream.
    expect(disposal!.grossConsiderationMinor).toBe('0')
    expect(disposal!.costMinor).toBe('0')
    expect(disposal!.fxRate).toBeNull()
  })

  it('is not netted into a rupee regime total when it cannot be converted', () => {
    resetIds()
    const disposals = disposalsFor(trades, aapl, usdFx(['2024-01-10', '83.00']))
    const summary = summariseRealised(disposals, income({}), 'FY2025-26')
    expect(summary.byRegime.size).toBe(0)
    expect(summary.unavailableDisposals[0]!.reason).toBe('NO_FX_RATE')
    expect(summary.currency).toBe('INR')
  })
})

describe('transfers out', () => {
  it('consumes inventory without inventing a taxable disposal', () => {
    resetIds()
    const equity = instrument({ fmv: '100.00' })
    const input: FoldInput = {
      accountId: 'acc-1',
      capability: 'ledger',
      txns: [
        txn({ type: 'buy', date: '2024-01-10', quantity: '10', amount: '100000' }),
        txn({ type: 'transfer_out', date: '2025-01-10', quantity: '4', amount: '80000' }),
      ],
      snapshots: [],
      instruments: instrumentMap(equity),
      asOf: AS_OF,
    }
    const folded = buildLots(input)
    if (!folded.ok) throw new Error('fold failed')
    const ledger = folded.value.get('inst-1')!
    expect(ledger.quantity).toBe('6')
    expect(ledger.consumptions).toHaveLength(1)
    // Moving units between demat accounts is not a transfer for capital-gains purposes.
    expect(classifyDisposal(ledger.consumptions[0]!, equity, inrOnlyFx())).toBeNull()
  })
})
