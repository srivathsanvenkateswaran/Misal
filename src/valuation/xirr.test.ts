/**
 * XIRR: the golden example from the spec, the failure modes, and the bounds properties.
 *
 * The golden figure was independently re-derived by pure bisection at 60 digits before being
 * written down here, so it is evidence rather than a snapshot of whatever the solver did first.
 */

import { describe, expect, it } from 'vitest'
import { type Dec, addDec, compareDec, dec, divDec, mulDec, subDec } from '@domain/numeric'
import { powDec, roundDec } from './arithmetic'
import { resetIds, txn } from './__fixtures__/build'
import { type Cashflow, buildCashflows, classifySigns, xirr } from './xirr'

function flow(date: string, amountMinor: string): Cashflow {
  return {
    date,
    amountMinor: amountMinor as Cashflow['amountMinor'],
    fxRate: dec('1'),
    fxSource: 'txn',
    origin: 'txn',
  }
}

// ₹1,00,000 in on 2024-04-01, ₹50,000 in on 2025-04-01, ₹1,80,000 of value on 2026-08-12.
const GOLDEN: readonly Cashflow[] = [
  flow('2024-04-01', '-10000000'),
  flow('2025-04-01', '-5000000'),
  { ...flow('2026-08-12', '18000000'), origin: 'terminal' },
]

describe('xirr golden example', () => {
  it('returns 0.0934468613876180… with a unique root', () => {
    const result = xirr(GOLDEN)
    if (!result.ok) throw new Error(`expected a rate, got ${result.error.code}`)
    expect(result.value.rate.startsWith('0.09344686138761808')).toBe(true)
    expect(roundDec(result.value.rate, 10)).toBe('0.0934468614')
    expect(result.value.uniquenessGuaranteed).toBe(true)
    expect(result.value.horizonDays).toBe(863)
    expect(result.value.unstable).toBe(false)
    expect(result.value.cashflowCount).toBe(3)
  })

  it('converges in at most five iterations, so a regression in the bracketing is visible', () => {
    const result = xirr(GOLDEN)
    if (!result.ok) throw new Error('expected a rate')
    expect(result.value.iterations).toBeLessThanOrEqual(5)
  })

  it('beats the naive annualisation, which is the whole point of using XIRR', () => {
    // 20% over 2.36 years annualises to about 8.0%; the true figure is higher because half the
    // money arrived a year late.
    const result = xirr(GOLDEN)
    if (!result.ok) throw new Error('expected a rate')
    expect(compareDec(result.value.rate, dec('0.08'))).toBe(1)
    expect(compareDec(result.value.rate, dec('0.20'))).toBe(-1)
  })
})

describe('cashflow construction', () => {
  it('maps each transaction type with the sign convention from the spec', () => {
    resetIds()
    const built = buildCashflows({
      txns: [
        txn({ type: 'buy', date: '2024-04-01', quantity: '10', amount: '10000000', fees: '1000' }),
        txn({ type: 'dividend', date: '2024-09-01', quantity: '0', amount: '50000' }),
        txn({ type: 'split', date: '2024-10-01', quantity: '2' }),
        txn({ type: 'tds', date: '2024-11-01', quantity: '0', amount: '2000' }),
        txn({ type: 'sell', date: '2025-04-01', quantity: '5', amount: '6000000', fees: '900' }),
      ],
      terminal: { date: '2026-08-12', amountMinor: '7000000' as Cashflow['amountMinor'] },
      fxOn: () => null,
    })
    if (!built.ok) throw new Error(`unexpected ${built.error.code}`)
    expect(built.value.map((f) => [f.date, f.amountMinor, f.origin])).toEqual([
      ['2024-04-01', '-10001000', 'txn'],
      ['2024-09-01', '50000', 'txn'],
      // A split moves no money, so it produces no cashflow at all.
      ['2024-11-01', '-2000', 'txn'],
      ['2025-04-01', '5999100', 'txn'],
      ['2026-08-12', '7000000', 'terminal'],
    ])
  })

  it('uses the rate stored on each transaction, not one rate for the series', () => {
    resetIds()
    const built = buildCashflows({
      txns: [
        txn({ type: 'buy', date: '2019-05-01', quantity: '10', amount: '100000', currency: 'USD', fxRate: '68.00' }),
        txn({ type: 'sell', date: '2026-05-01', quantity: '10', amount: '200000', currency: 'USD', fxRate: '88.00' }),
      ],
      terminal: null,
      fxOn: () => null,
    })
    if (!built.ok) throw new Error(`unexpected ${built.error.code}`)
    // $1,000 at ₹68 out, $2,000 at ₹88 in. Converting both at one rate would erase the currency
    // return, which is real money.
    expect(built.value.map((f) => f.amountMinor)).toEqual(['-6800000', '17600000'])
    expect(built.value.every((f) => f.fxSource === 'txn')).toBe(true)
  })

  it('falls back to the daily fx table with a flag, and fails rather than using today’s rate', () => {
    resetIds()
    const withTable = buildCashflows({
      txns: [txn({ type: 'buy', date: '2019-05-01', quantity: '10', amount: '100000', currency: 'USD' })],
      terminal: null,
      fxOn: () => dec('70.50'),
    })
    if (!withTable.ok) throw new Error('expected flows')
    expect(withTable.value[0]!.fxSource).toBe('daily_table')

    const withoutTable = buildCashflows({
      txns: [txn({ type: 'buy', date: '2019-05-01', quantity: '10', amount: '100000', currency: 'USD' })],
      terminal: null,
      fxOn: () => null,
    })
    expect(withoutTable.ok).toBe(false)
    if (withoutTable.ok) return
    expect(withoutTable.error.code).toBe('MISSING_FX')
  })

  it('blocks the scope when a transfer_in has no acquisition cost', () => {
    resetIds()
    const built = buildCashflows({
      txns: [txn({ type: 'transfer_in', date: '2022-04-01', quantity: '40' })],
      terminal: null,
      fxOn: () => null,
    })
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.error.code).toBe('MISSING_ACQUISITION_COST')
  })
})

describe('failure modes', () => {
  it('never returns a rate of zero on failure', () => {
    const insufficient = xirr([flow('2024-01-01', '-100')])
    expect(insufficient.ok).toBe(false)
    if (insufficient.ok) return
    expect(insufficient.error.code).toBe('INSUFFICIENT_CASHFLOWS')
    expect('rate' in insufficient.error).toBe(false)
    // Serialised across IPC, the error still carries no rate field.
    expect(JSON.parse(JSON.stringify(insufficient))).not.toHaveProperty('value')
  })

  it('reports a missing terminal value as NO_SIGN_CHANGE rather than a numerical failure', () => {
    const result = xirr([flow('2024-01-01', '-100000'), flow('2025-01-01', '-50000')])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('NO_SIGN_CHANGE')
  })

  it('flags a series with several sign changes as not guaranteed unique', () => {
    const flows = [
      flow('2020-01-01', '-100000'),
      flow('2021-01-01', '300000'),
      flow('2022-01-01', '-250000'),
      flow('2023-01-01', '90000'),
    ]
    expect(classifySigns(flows)).toBe('multiple_changes')
    const result = xirr(flows)
    if (!result.ok) {
      expect(result.error.code).toBe('NO_BRACKET')
      return
    }
    expect(result.value.uniquenessGuaranteed).toBe(false)
  })

  it('flags a short horizon as unstable rather than hiding the number', () => {
    const result = xirr([flow('2026-06-01', '-100000'), flow('2026-06-21', '110000')])
    if (!result.ok) throw new Error('expected a rate')
    expect(result.value.unstable).toBe(true)
    expect(result.value.horizonDays).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

function npvAt(flows: readonly Cashflow[], rate: Dec): Dec {
  const base = flows[0]!.date
  let total = dec('0')
  for (const f of flows) {
    const years = divDec(dec(daysBetweenTest(base, f.date).toString()), dec('365'))
    total = addDec(total, divDec(dec(f.amountMinor), powDec(addDec(dec('1'), rate), years)))
  }
  return total
}

function daysBetweenTest(from: string, to: string): number {
  const a = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  )
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)))
  return (b - a) / 86_400_000
}

function shiftDate(date: string, days: number): string {
  const base = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  )
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10)
}

function lcg(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}

/** Random single-sign-change series: contributions, then one terminal value. */
function generateSeries(random: () => number): Cashflow[] {
  const contributions = 2 + Math.floor(random() * 6)
  const flows: Cashflow[] = []
  let start = '2018-01-15'
  let invested = 0
  for (let i = 0; i < contributions; i++) {
    const amount = 10_000 + Math.floor(random() * 500_000)
    invested += amount
    flows.push(flow(start, (-amount).toString()))
    start = shiftDate(start, 30 + Math.floor(random() * 400))
  }
  const terminal = Math.floor(invested * (0.3 + random() * 2.5))
  flows.push({ ...flow(shiftDate(start, 60 + Math.floor(random() * 900)), terminal.toString()), origin: 'terminal' })
  return flows
}

describe('xirr properties', () => {
  const random = lcg(20260812)
  const series = Array.from({ length: 24 }, () => generateSeries(random))

  it('verifies the root: |NPV(rate)| / Σ|cf| < 10^-12 for every returned rate', () => {
    for (const flows of series) {
      const result = xirr(flows)
      if (!result.ok) throw new Error(`unexpected ${result.error.code}`)
      expect(compareDec(result.value.residual, dec('0.000000000001'))).toBe(-1)
    }
  })

  it('gets the sign right: more back than went in means a positive rate, and less means negative', () => {
    for (const flows of series) {
      const result = xirr(flows)
      if (!result.ok) throw new Error('expected a rate')
      const total = flows.reduce<Dec>((acc, f) => addDec(acc, dec(f.amountMinor)), dec('0'))
      const rateSign = compareDec(result.value.rate, dec('0'))
      expect(rateSign).toBe(compareDec(total, dec('0')))
    }
  })

  it('is scale invariant to ten decimal places', () => {
    for (const flows of series.slice(0, 12)) {
      const base = xirr(flows)
      const scaled = xirr(
        flows.map((f) => ({ ...f, amountMinor: mulDec(dec(f.amountMinor), dec('7')) as unknown as Cashflow['amountMinor'] })),
      )
      if (!base.ok || !scaled.ok) throw new Error('expected rates')
      expect(roundDec(scaled.value.rate, 10)).toBe(roundDec(base.value.rate, 10))
    }
  })

  it('is invariant to shifting every date by the same number of days', () => {
    for (const flows of series.slice(0, 12)) {
      const base = xirr(flows)
      const shifted = xirr(flows.map((f) => ({ ...f, date: shiftDate(f.date, 97) })))
      if (!base.ok || !shifted.ok) throw new Error('expected rates')
      expect(roundDec(shifted.value.rate, 10)).toBe(roundDec(base.value.rate, 10))
    }
  })

  /**
   * The spec claims NPV is *strictly monotonic* on (−1, ∞) for a single-sign-change series. That is
   * too strong and the generator finds counterexamples: past the point where the terminal inflow has
   * been discounted away, the intermediate contributions — negative, at short horizons — pull NPV
   * back up, so it rises again at large r. What actually holds, and what uniqueness rests on, is
   * that NPV crosses zero exactly once. That is what is asserted.
   */
  it('crosses zero exactly once across 200 sampled rates in (−0.99, 10)', () => {
    for (const flows of series.slice(0, 8)) {
      expect(classifySigns(flows)).toBe('single_change')
      let crossings = 0
      let previous: Dec | null = null
      for (let i = 0; i < 200; i++) {
        const rate = addDec(dec('-0.99'), mulDec(dec(i.toString()), dec('0.055')))
        const value = npvAt(flows, rate)
        if (previous !== null && compareDec(value, dec('0')) * compareDec(previous, dec('0')) < 0) {
          crossings += 1
        }
        previous = value
      }
      expect(crossings).toBe(1)
    }
  })

  it('has a strictly decreasing NPV in the neighbourhood of the root', () => {
    for (const flows of series.slice(0, 8)) {
      const result = xirr(flows)
      if (!result.ok) throw new Error('expected a rate')
      let previous: Dec | null = null
      for (let i = -5; i <= 5; i++) {
        const rate = addDec(result.value.rate, mulDec(dec(i.toString()), dec('0.01')))
        const value = npvAt(flows, rate)
        if (previous !== null) expect(compareDec(value, previous)).toBe(-1)
        previous = value
      }
    }
  })

  it('always terminates within the iteration cap and always returns a Result', () => {
    for (const flows of series) {
      const result = xirr(flows)
      expect(typeof result.ok).toBe('boolean')
      if (result.ok) expect(result.value.iterations).toBeLessThanOrEqual(100)
    }
  })

  it('brackets the root before iterating', () => {
    for (const flows of series.slice(0, 10)) {
      const result = xirr(flows)
      if (!result.ok) throw new Error('expected a rate')
      const below = npvAt(flows, subDec(result.value.rate, dec('0.01')))
      const above = npvAt(flows, addDec(result.value.rate, dec('0.01')))
      expect(compareDec(below, dec('0'))).toBe(1)
      expect(compareDec(above, dec('0'))).toBe(-1)
    }
  })
})
