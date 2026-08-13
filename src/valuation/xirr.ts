/**
 * XIRR — the internal rate of return over irregularly dated cashflows.
 *
 * It is the only return figure that is honest about SIPs, top-ups and partial redemptions, and it
 * is computed only for scopes that are fully measured: a cashflow series with a hole in it produces
 * a number that looks fine and is wrong.
 *
 * Every failure mode returns an `Err`. None returns zero. A displayed XIRR of 0.00% is
 * indistinguishable from a genuinely flat portfolio, and that ambiguity is unacceptable in the one
 * metric users quote at each other.
 */

import {
  type CurrencyCode,
  type Dec,
  type Minor,
  ZERO_DEC,
  ZERO_MINOR,
  absDec,
  addDec,
  addMinor,
  compareDec,
  dec,
  decToMinor,
  divDec,
  isNegativeMinor,
  isZeroMinor,
  minorToDec,
  mulDec,
  negMinor,
  powDec,
  subDec,
  subMinor,
} from '@domain/numeric'
import { decFromCount } from './arithmetic'
import { daysBetween, localDate } from './calendar'
import type { IsoDate, PairRef, TxnRow } from './types'

export type FxSource = 'txn' | 'daily_table'

export interface Cashflow {
  readonly date: IsoDate
  /** INR minor units, signed: negative is money into the investment, positive is money returned. */
  readonly amountMinor: Minor
  readonly fxRate: Dec
  readonly fxSource: FxSource
  readonly origin: 'txn' | 'terminal'
  readonly txnId?: string
}

export type XirrError =
  | { readonly code: 'INSUFFICIENT_CASHFLOWS'; readonly count: number }
  | { readonly code: 'NO_SIGN_CHANGE' }
  | { readonly code: 'NO_BRACKET'; readonly probed: readonly string[] }
  | { readonly code: 'NOT_CONVERGED'; readonly lastRate: string; readonly residual: string }
  | { readonly code: 'MISSING_FX'; readonly txnIds: readonly string[] }
  | { readonly code: 'MISSING_PRICE'; readonly instrumentIds: readonly string[] }
  | { readonly code: 'MISSING_ACQUISITION_COST'; readonly txnIds: readonly string[] }
  | { readonly code: 'SCOPE_NOT_MEASURED'; readonly pairs: readonly PairRef[] }

export type XirrResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: XirrError }

function okResult<T>(value: T): XirrResult<T> {
  return { ok: true, value }
}

function errResult<T>(error: XirrError): XirrResult<T> {
  return { ok: false, error }
}

export interface XirrInput {
  readonly txns: readonly TxnRow[]
  /** Market value of the open position at the valuation date, at the current FX rate. */
  readonly terminal: { readonly date: IsoDate; readonly amountMinor: Minor } | null
  /** Daily `fx_rate` table lookup, used only when `txn.fx_rate` is absent. */
  readonly fxOn: (currency: CurrencyCode, date: IsoDate) => Dec | null
  /** Price lookup for a `transfer_out`, which leaves the scope at its market value that day. */
  readonly priceOn?: (instrumentId: string, date: IsoDate) => Dec | null
}

const INR: CurrencyCode = 'INR'

function toInrMinor(amountMinor: Minor, currency: CurrencyCode, fxRate: Dec): Minor {
  if (currency === INR) return amountMinor
  return decToMinor(mulDec(minorToDec(amountMinor, currency), fxRate), INR)
}

/**
 * Build the cashflow series.
 *
 * Each cashflow uses the `fx_rate` stored on its own transaction — the reason that column exists. A
 * user who vested RSUs at ₹68/USD in 2019 and holds them at ₹88/USD today has earned a real
 * currency return; converting the whole series at today's rate erases it, and converting at the
 * average rate invents one.
 */
export function buildCashflows(input: XirrInput): XirrResult<readonly Cashflow[]> {
  const flows: Cashflow[] = []
  const missingFx: string[] = []
  const missingCost: string[] = []
  const missingPrice: string[] = []

  for (const txn of input.txns) {
    const date = localDate(txn.occurredAt, txn.occurredTz)
    const gross = txn.amountMinor
    let amountMinor: Minor
    switch (txn.type) {
      case 'buy':
        if (gross === null) {
          missingCost.push(txn.id)
          continue
        }
        amountMinor = negMinor(addMinor(gross, txn.feesMinor))
        break
      case 'sell':
        if (gross === null) {
          missingPrice.push(txn.instrumentId)
          continue
        }
        amountMinor = subMinor(gross, txn.feesMinor)
        break
      case 'dividend':
      case 'interest':
        amountMinor = gross ?? ZERO_MINOR
        break
      case 'fee':
        amountMinor = negMinor(gross ?? txn.feesMinor)
        break
      case 'tds':
        // The cash left the account, so it is a cashflow; it is still not an expense of transfer
        // and never reduces a gain.
        amountMinor = negMinor(gross ?? ZERO_MINOR)
        break
      case 'transfer_in': {
        if (gross !== null) {
          amountMinor = negMinor(addMinor(gross, txn.feesMinor))
          break
        }
        if (txn.price === null) {
          missingCost.push(txn.id)
          continue
        }
        amountMinor = negMinor(
          addMinor(decToMinor(mulDec(txn.quantity, txn.price), txn.currency), txn.feesMinor),
        )
        break
      }
      case 'transfer_out': {
        const unitPrice = txn.price ?? input.priceOn?.(txn.instrumentId, date) ?? null
        if (gross !== null) {
          amountMinor = subMinor(gross, txn.feesMinor)
          break
        }
        if (unitPrice === null) {
          missingPrice.push(txn.instrumentId)
          continue
        }
        amountMinor = subMinor(
          decToMinor(mulDec(txn.quantity, unitPrice), txn.currency),
          txn.feesMinor,
        )
        break
      }
      case 'split':
      case 'bonus':
        // No money moves, so there is no cashflow.
        continue
    }

    let fxRate: Dec
    let fxSource: FxSource
    if (txn.currency === INR) {
      fxRate = dec('1')
      fxSource = 'txn'
    } else if (txn.fxRate !== null) {
      fxRate = txn.fxRate
      fxSource = 'txn'
    } else {
      const imputed = input.fxOn(txn.currency, date)
      if (imputed === null) {
        // No fallback to the current rate: that would erase the currency return the series exists
        // to capture.
        missingFx.push(txn.id)
        continue
      }
      fxRate = imputed
      fxSource = 'daily_table'
    }

    flows.push({
      date,
      amountMinor: toInrMinor(amountMinor, txn.currency, fxRate),
      fxRate,
      fxSource,
      origin: 'txn',
      txnId: txn.id,
    })
  }

  if (missingFx.length > 0) return errResult({ code: 'MISSING_FX', txnIds: missingFx })
  if (missingCost.length > 0) {
    return errResult({ code: 'MISSING_ACQUISITION_COST', txnIds: missingCost })
  }
  if (missingPrice.length > 0) {
    return errResult({ code: 'MISSING_PRICE', instrumentIds: [...new Set(missingPrice)] })
  }

  if (input.terminal !== null) {
    flows.push({
      date: input.terminal.date,
      amountMinor: input.terminal.amountMinor,
      fxRate: dec('1'),
      fxSource: 'txn',
      origin: 'terminal',
    })
  }

  flows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return okResult(flows)
}

export type SignPattern = 'single_change' | 'multiple_changes' | 'all_same_sign' | 'empty'

/**
 * Norström's criterion, in the form the engine actually needs: how many times the date-ordered
 * series changes sign. Exactly one change guarantees a unique root on (−1, ∞).
 */
export function classifySigns(flows: readonly Cashflow[]): SignPattern {
  if (flows.length === 0) return 'empty'
  let changes = 0
  let previous: -1 | 1 | null = null
  for (const flow of flows) {
    if (isZeroMinor(flow.amountMinor)) continue
    const sign = isNegativeMinor(flow.amountMinor) ? -1 : 1
    if (previous !== null && sign !== previous) changes += 1
    previous = sign
  }
  if (previous === null) return 'empty'
  if (changes === 0) return 'all_same_sign'
  return changes === 1 ? 'single_change' : 'multiple_changes'
}

export interface XirrOutcome {
  /** Annualised, as a fraction: 0.0934 is 9.34%. */
  readonly rate: Dec
  readonly iterations: number
  /** |NPV| at the root, scaled by the gross cashflow magnitude. */
  readonly residual: Dec
  readonly uniquenessGuaranteed: boolean
  readonly horizonDays: number
  /** Arithmetically correct but meaningless to display without a caveat. */
  readonly unstable: boolean
  readonly cashflowCount: number
}

export interface XirrOptions {
  readonly maxIterations?: number
  readonly tolerance?: Dec
}

const DEFAULT_MAX_ITERATIONS = 100
const DEFAULT_TOLERANCE = dec('0.000000000001') // 10^-12
const DERIVATIVE_FLOOR = dec('0.00000000000000000001') // 10^-20
const YEAR_DAYS = dec('365')

/** Probes, in order. Actual/365 fixed, matching Excel's and LibreOffice's XIRR. */
const PROBES: readonly string[] = [
  '-0.9999',
  '-0.9',
  '-0.5',
  '0',
  '0.1',
  '0.5',
  '1',
  '3',
  '10',
  '100',
]
const EXPANDED_PROBE = '10000'

interface Series {
  readonly amounts: readonly Dec[]
  readonly years: readonly Dec[]
  readonly gross: Dec
  readonly horizonDays: number
}

function toSeries(flows: readonly Cashflow[]): Series {
  const base = flows[0]
  if (base === undefined) throw new Error('unreachable: empty series')
  const amounts: Dec[] = []
  const years: Dec[] = []
  let gross = ZERO_DEC
  for (const flow of flows) {
    // Paise, not rupees: the root is invariant under scaling and the integer form is exact.
    const amount = dec(flow.amountMinor)
    amounts.push(amount)
    years.push(divDec(decFromCount(daysBetween(base.date, flow.date)), YEAR_DAYS))
    gross = addDec(gross, absDec(amount))
  }
  const last = flows[flows.length - 1]
  if (last === undefined) throw new Error('unreachable: empty series')
  return { amounts, years, gross, horizonDays: daysBetween(base.date, last.date) }
}

function npv(series: Series, rate: Dec): Dec {
  const onePlusR = addDec(dec('1'), rate)
  let total = ZERO_DEC
  for (let i = 0; i < series.amounts.length; i++) {
    const amount = series.amounts[i]
    const years = series.years[i]
    if (amount === undefined || years === undefined) continue
    total = addDec(total, divDec(amount, powDec(onePlusR, years)))
  }
  return total
}

function npvDerivative(series: Series, rate: Dec): Dec {
  const onePlusR = addDec(dec('1'), rate)
  let total = ZERO_DEC
  for (let i = 0; i < series.amounts.length; i++) {
    const amount = series.amounts[i]
    const years = series.years[i]
    if (amount === undefined || years === undefined) continue
    const term = divDec(mulDec(amount, years), powDec(onePlusR, addDec(years, dec('1'))))
    total = subDec(total, term)
  }
  return total
}

function signOf(value: Dec): -1 | 0 | 1 {
  return compareDec(value, ZERO_DEC)
}

interface Bracket {
  readonly low: Dec
  readonly high: Dec
  readonly npvLow: Dec
  readonly npvHigh: Dec
}

function findBracket(series: Series, probes: readonly string[]): Bracket | null {
  let previous: { rate: Dec; value: Dec } | null = null
  for (const probe of probes) {
    const rate = dec(probe)
    const value = npv(series, rate)
    if (previous !== null && signOf(previous.value) * signOf(value) < 0) {
      return { low: previous.rate, high: rate, npvLow: previous.value, npvHigh: value }
    }
    if (signOf(value) === 0) {
      return { low: rate, high: rate, npvLow: value, npvHigh: value }
    }
    previous = { rate, value }
  }
  return null
}

/**
 * Bracketed Newton with a bisection fallback.
 *
 * Newton alone can leave the domain (`r <= −1`) or oscillate; bisection alone is reliable but slow.
 * Each step takes the Newton update, and falls back to bisection whenever that update leaves the
 * bracket or the derivative is too small to trust.
 */
export function xirr(flows: readonly Cashflow[], opts: XirrOptions = {}): XirrResult<XirrOutcome> {
  if (flows.length < 2) return errResult({ code: 'INSUFFICIENT_CASHFLOWS', count: flows.length })

  const pattern = classifySigns(flows)
  if (pattern === 'empty') return errResult({ code: 'INSUFFICIENT_CASHFLOWS', count: 0 })
  if (pattern === 'all_same_sign') {
    // Not a numerical failure: a portfolio with only purchases and no value means the terminal
    // flow is missing, which is almost always a missing price.
    return errResult({ code: 'NO_SIGN_CHANGE' })
  }

  const ordered = [...flows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const series = toSeries(ordered)
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS

  let bracket = findBracket(series, PROBES)
  if (bracket === null) bracket = findBracket(series, [...PROBES, EXPANDED_PROBE])
  if (bracket === null) return errResult({ code: 'NO_BRACKET', probed: PROBES })

  let low = bracket.low
  let high = bracket.high
  let signLow = signOf(bracket.npvLow)
  let rate = divDec(addDec(low, high), dec('2'))
  let stepped = false
  let iterations = 0

  while (iterations < maxIterations) {
    iterations += 1
    const value = npv(series, rate)
    const residual = compareDec(series.gross, ZERO_DEC) === 0 ? ZERO_DEC : divDec(absDec(value), series.gross)

    const derivative = npvDerivative(series, rate)
    let next: Dec
    if (compareDec(absDec(derivative), DERIVATIVE_FLOOR) < 0) {
      next = divDec(addDec(low, high), dec('2'))
    } else {
      const newton = subDec(rate, divDec(value, derivative))
      next = compareDec(newton, low) <= 0 || compareDec(newton, high) >= 0
        ? divDec(addDec(low, high), dec('2'))
        : newton
    }

    const delta = absDec(subDec(next, rate))
    if (stepped && compareDec(residual, tolerance) < 0 && compareDec(delta, tolerance) < 0) {
      return okResult(buildOutcome(rate, iterations, residual, pattern, series, flows.length))
    }

    if (signOf(value) === 0) {
      return okResult(buildOutcome(rate, iterations, residual, pattern, series, flows.length))
    }
    if (signOf(value) === signLow) {
      low = rate
      signLow = signOf(value)
    } else {
      high = rate
    }
    rate = next
    stepped = true
  }

  const finalResidual = compareDec(series.gross, ZERO_DEC) === 0
    ? ZERO_DEC
    : divDec(absDec(npv(series, rate)), series.gross)
  return errResult({ code: 'NOT_CONVERGED', lastRate: rate, residual: finalResidual })
}

function buildOutcome(
  rate: Dec,
  iterations: number,
  residual: Dec,
  pattern: SignPattern,
  series: Series,
  cashflowCount: number,
): XirrOutcome {
  return {
    rate,
    iterations,
    residual,
    uniquenessGuaranteed: pattern === 'single_change',
    horizonDays: series.horizonDays,
    // Annualising a three-week holding produces figures like 4,000%. The number is returned with
    // the flag rather than hidden; the UI renders the caveat.
    unstable: series.horizonDays < 90 || compareDec(absDec(rate), dec('10')) > 0,
    cashflowCount,
  }
}
