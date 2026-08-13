/**
 * The scaling and counting helpers the valuation engine needs on top of `@domain/numeric`.
 *
 * What remains here is deliberately narrow: turning a decimal quantity into the integer form the
 * FIFO allocation works in, and building the `Dec` constants the engine's day counts and display
 * tolerances need. The general numeric operations that used to live here — `powDec`, `roundDec`
 * and `mulDivMinor` — are in `@domain/numeric`, where the float ban exempts the module and the
 * numeric tests are concentrated; a second subsystem needing them must not have to reach across
 * into the valuation engine to find them.
 *
 * This is still the only module in the subsystem that touches `decimal.js` directly. Everything
 * above it works in `Dec` and `Minor`.
 *
 * No value here is ever converted to `number`: `Decimal` results come back through `dec()`, so a
 * result that is not a canonical decimal string throws instead of silently degrading.
 */

import Decimal from 'decimal.js'
import { type Dec, dec } from '@domain/numeric'
import { ValuationAssertionError } from './types'

/**
 * decimal.js prints in exponential notation outside the configured `toExpNeg`/`toExpPos` window,
 * and `dec()` rejects exponent notation. Expanding it here by string surgery keeps the value exact
 * — a numeric round-trip through `Number` to "fix" the format would defeat the entire module.
 */
function expandExponential(raw: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(raw)
  if (match === null) return raw
  const sign = match[1] ?? ''
  let intPart = match[2] ?? '0'
  let fracPart = match[3] ?? ''
  const exponentText = match[4] ?? '0'
  const movingLeft = exponentText.startsWith('-')
  // The exponent is counted in bigint and consumed one digit-shift at a time, because converting
  // it to `number` to index a string is exactly the conversion this module exists to avoid.
  let steps = BigInt(exponentText.replace('+', '').replace('-', ''))
  while (steps > 0n) {
    if (movingLeft) {
      const last = intPart.length > 0 ? intPart.slice(-1) : '0'
      fracPart = last + fracPart
      intPart = intPart.length > 0 ? intPart.slice(0, -1) : ''
    } else {
      const first = fracPart.length > 0 ? fracPart.slice(0, 1) : '0'
      intPart += first
      fracPart = fracPart.slice(1)
    }
    steps -= 1n
  }
  const normalisedInt = intPart.replace(/^0+(?=\d)/, '')
  const whole = normalisedInt === '' ? '0' : normalisedInt
  return fracPart === '' ? `${sign}${whole}` : `${sign}${whole}.${fracPart}`
}

function toDec(value: Decimal): Dec {
  if (!value.isFinite()) {
    throw new ValuationAssertionError(`Non-finite result: ${value.toString()}`)
  }
  return dec(expandExponential(value.toString()))
}

function fromDec(value: Dec): Decimal {
  return new Decimal(value)
}

/** Truncation toward zero at a fixed number of decimal places. */
export function truncDec(value: Dec, places: number): Dec {
  return toDec(fromDec(value).toDecimalPlaces(places, Decimal.ROUND_DOWN))
}

/** Number of digits after the decimal point, as written. Pure string inspection. */
export function decimalPlaces(value: Dec): number {
  const dot = value.indexOf('.')
  return dot < 0 ? 0 : value.length - dot - 1
}

/** The spec's cap on the common scaling exponent used for integer lot allocation. */
export const MAX_SCALE = 18

/**
 * Scale a decimal to an integer by `10^k`, truncating anything beyond `k` places.
 *
 * Truncation only bites above 18 decimal places, which is the deepest quantity any supported asset
 * class carries (wei). Beyond that the residue is far below one minor unit of value.
 */
export function scaleToInteger(value: Dec, k: number): bigint {
  const negative = value.startsWith('-')
  const body = negative ? value.slice(1) : value
  const dot = body.indexOf('.')
  const intPart = dot < 0 ? body : body.slice(0, dot)
  const fracPart = dot < 0 ? '' : body.slice(dot + 1)
  const padded = (fracPart + '0'.repeat(k)).slice(0, k)
  const magnitude = BigInt(intPart + padded)
  return negative ? -magnitude : magnitude
}

/** The common scaling exponent for a set of quantities, capped at `MAX_SCALE`. */
export function commonScale(...values: Dec[]): number {
  let k = 0
  for (const v of values) {
    const dp = decimalPlaces(v)
    if (dp > k) k = dp
  }
  return k > MAX_SCALE ? MAX_SCALE : k
}

/** A `Dec` from an integer count (days, iterations). Never used for money or quantities. */
export function decFromCount(count: number): Dec {
  if (!Number.isInteger(count)) {
    throw new ValuationAssertionError(`Not an integer count: ${String(count)}`)
  }
  return dec(count.toString())
}

/** Ten raised to a non-negative integer power, as a `Dec`. */
export function tenPow(exponent: number): Dec {
  if (!Number.isInteger(exponent) || exponent < 0) {
    throw new ValuationAssertionError(`tenPow needs a non-negative integer: ${String(exponent)}`)
  }
  return dec(`1${'0'.repeat(exponent)}`)
}

/** `10^-exponent`, as a `Dec`. Used for the reconciliation tolerance of one display step. */
export function tenPowNegative(exponent: number): Dec {
  if (!Number.isInteger(exponent) || exponent < 0) {
    throw new ValuationAssertionError(`tenPowNegative needs a non-negative integer`)
  }
  if (exponent === 0) return dec('1')
  return dec(`0.${'0'.repeat(exponent - 1)}1`)
}
