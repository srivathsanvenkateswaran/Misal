/**
 * Numeric primitives for Misal.
 *
 * The rule from the core schema spec: no floating-point arithmetic anywhere near money or
 * quantities. This module is how that rule is enforced by the compiler rather than by discipline.
 *
 * Two branded string types cross every boundary:
 *
 *   Minor - an integer count of a currency's smallest unit (paise, cents).
 *   Dec   - an arbitrary-precision decimal, for quantities, prices and rates.
 *
 * Both are branded strings, so `a + b` yields a plain `string` that cannot be assigned back to
 * `Minor` or `Dec`. Accidental JavaScript arithmetic therefore fails `tsc` instead of silently
 * producing a wrong number. All real arithmetic goes through the functions below.
 *
 * Values arrive from the Rust core as strings and stay strings. They are never parsed into
 * `number` except at the pixel boundary in chart geometry, which is the one audited exception.
 */

import Decimal from 'decimal.js'

// 40 significant digits comfortably covers 18-decimal crypto quantities multiplied by prices.
// Decimal.js defaults to 20, which is not enough.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 40 })

declare const MINOR: unique symbol
declare const DEC: unique symbol

/** An integer count of a currency's minor unit. Always paired with a CurrencyCode. */
export type Minor = string & { readonly [MINOR]: true }

/** An arbitrary-precision decimal held as a canonical string. */
export type Dec = string & { readonly [DEC]: true }

export type CurrencyCode = 'INR' | 'USD'

/** Minor units per major unit, by currency. Static data, never inferred from values. */
const CURRENCY_EXPONENT: Record<CurrencyCode, number> = {
  INR: 2,
  USD: 2,
}

export function exponentOf(currency: CurrencyCode): number {
  return CURRENCY_EXPONENT[currency]
}

/**
 * Validate a raw string as a currency code.
 *
 * Currency codes arrive from SQLite as plain strings. This is the one boundary where an unknown
 * code must be rejected; past it, the CurrencyCode type guarantees the exponent table has an
 * entry, so no downstream function needs a defensive check.
 */
export function currencyCode(raw: string): CurrencyCode {
  if (!Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENT, raw)) {
    throw new NumericError(`Unsupported currency: ${JSON.stringify(raw)}`)
  }
  return raw as CurrencyCode
}

export class NumericError extends Error {
  override readonly name = 'NumericError'
}

// Canonical decimal: optional sign, digits, optional single fractional part. No exponent
// notation, no separators, no leading '+'. Trailing zeros are significant and preserved.
const DEC_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/
const MINOR_PATTERN = /^-?(?:0|[1-9]\d*)$/

/**
 * Construct a Minor from a validated integer string or bigint.
 *
 * Deliberately does not accept `number`. A JavaScript number cannot represent every int64, and
 * accepting one here would reopen the hole this module exists to close.
 */
export function minor(raw: string | bigint): Minor {
  const s = typeof raw === 'bigint' ? raw.toString() : raw
  if (!MINOR_PATTERN.test(s)) {
    throw new NumericError(`Not a valid minor-unit integer: ${JSON.stringify(raw)}`)
  }
  return s as Minor
}

/** Construct a Dec from a canonical decimal string. */
export function dec(raw: string): Dec {
  if (!DEC_PATTERN.test(raw)) {
    throw new NumericError(`Not a canonical decimal string: ${JSON.stringify(raw)}`)
  }
  return raw as Dec
}

/** Parse a value that may be absent, returning null rather than throwing. */
export function decOrNull(raw: string | null | undefined): Dec | null {
  if (raw === null || raw === undefined || raw === '') return null
  return dec(raw)
}

export const ZERO_MINOR = minor('0')
export const ZERO_DEC = dec('0')

// ---------------------------------------------------------------------------
// Minor arithmetic. Exact integer maths via bigint; no rounding is ever needed.
// ---------------------------------------------------------------------------

export function addMinor(...values: Minor[]): Minor {
  return minor(values.reduce((acc, v) => acc + BigInt(v), 0n))
}

export function subMinor(a: Minor, b: Minor): Minor {
  return minor(BigInt(a) - BigInt(b))
}

export function negMinor(a: Minor): Minor {
  return minor(-BigInt(a))
}

export function compareMinor(a: Minor, b: Minor): -1 | 0 | 1 {
  const x = BigInt(a)
  const y = BigInt(b)
  return x < y ? -1 : x > y ? 1 : 0
}

export function isZeroMinor(a: Minor): boolean {
  return BigInt(a) === 0n
}

export function isNegativeMinor(a: Minor): boolean {
  return BigInt(a) < 0n
}

/**
 * `value * numerator / denominator` in exact integer arithmetic, truncating toward zero.
 *
 * Pro-rata allocation of an integer amount — a lot's cost split across a partial disposal, a fee
 * apportioned across slices. The multiplication happens before the division and both operands are
 * bigint, so no intermediate value is ever rounded.
 *
 * Callers obtain the residual by subtraction from the original, never by a second call: that is
 * what makes `Σ allocated + residual === original` hold exactly for any sequence of partial
 * allocations.
 */
export function mulDivMinor(value: Minor, numerator: bigint, denominator: bigint): Minor {
  if (denominator === 0n) {
    throw new NumericError('mulDivMinor: zero denominator')
  }
  return minor((BigInt(value) * numerator) / denominator)
}

// ---------------------------------------------------------------------------
// Dec arithmetic, via decimal.js.
// ---------------------------------------------------------------------------

function toDecimal(value: Dec): Decimal {
  return new Decimal(value)
}

function fromDecimal(value: Decimal): Dec {
  if (!value.isFinite()) {
    throw new NumericError(`Non-finite result: ${value.toString()}`)
  }
  return dec(value.toFixed())
}

export function addDec(...values: Dec[]): Dec {
  return fromDecimal(values.reduce<Decimal>((acc, v) => acc.plus(toDecimal(v)), new Decimal(0)))
}

export function subDec(a: Dec, b: Dec): Dec {
  return fromDecimal(toDecimal(a).minus(toDecimal(b)))
}

export function mulDec(a: Dec, b: Dec): Dec {
  return fromDecimal(toDecimal(a).times(toDecimal(b)))
}

export function divDec(a: Dec, b: Dec): Dec {
  const divisor = toDecimal(b)
  if (divisor.isZero()) throw new NumericError('Division by zero')
  return fromDecimal(toDecimal(a).dividedBy(divisor))
}

export function negDec(a: Dec): Dec {
  return fromDecimal(toDecimal(a).negated())
}

export function absDec(a: Dec): Dec {
  return fromDecimal(toDecimal(a).abs())
}

export function compareDec(a: Dec, b: Dec): -1 | 0 | 1 {
  return toDecimal(a).comparedTo(toDecimal(b)) as -1 | 0 | 1
}

export function isZeroDec(a: Dec): boolean {
  return toDecimal(a).isZero()
}

export function isNegativeDec(a: Dec): boolean {
  return toDecimal(a).isNegative()
}

export function maxDec(a: Dec, b: Dec): Dec {
  return compareDec(a, b) >= 0 ? a : b
}

export function minDec(a: Dec, b: Dec): Dec {
  return compareDec(a, b) <= 0 ? a : b
}

/**
 * `base ** exponent`, with a fractional exponent, at the configured 40-digit precision.
 *
 * A general numeric operation rather than a valuation one: XIRR discounting reaches for it first,
 * but so does any compounding or index calculation, and a second subsystem needing it must find it
 * here rather than copy it. `fromDecimal` prints in normal notation, so a result far outside the
 * exponential window still comes back as a canonical `Dec` instead of `1e-45`.
 */
export function powDec(base: Dec, exponent: Dec): Dec {
  return fromDecimal(toDecimal(base).pow(toDecimal(exponent)))
}

/**
 * Half-up rounding to a fixed number of decimal places.
 *
 * The only rounding in this module besides `decToMinor`, and like it, deliberate: a caller asking
 * for two places has decided how many places the value is allowed to carry. It is not a display
 * formatter — it returns a `Dec`, so a rounded figure remains a number and never becomes text.
 */
export function roundDec(value: Dec, places: number): Dec {
  return fromDecimal(toDecimal(value).toDecimalPlaces(places, Decimal.ROUND_HALF_UP))
}

// ---------------------------------------------------------------------------
// Conversions between the two representations.
// ---------------------------------------------------------------------------

/**
 * Convert a major-unit decimal to minor units, rounding half-up at the currency's exponent.
 *
 * Rounding here is intentional and is the only place it happens outside display formatting:
 * a computed value such as quantity x price must land on a whole paisa before it can be stored
 * as Minor.
 */
export function decToMinor(value: Dec, currency: CurrencyCode): Minor {
  const scaled = toDecimal(value).times(new Decimal(10).pow(exponentOf(currency)))
  return minor(scaled.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0))
}

/** Convert minor units back to a major-unit decimal. Exact; never rounds. */
export function minorToDec(value: Minor, currency: CurrencyCode): Dec {
  return fromDecimal(new Decimal(value).dividedBy(new Decimal(10).pow(exponentOf(currency))))
}

/** Multiply a quantity by a per-unit price, yielding minor units of the price's currency. */
export function valueOf(quantity: Dec, price: Dec, currency: CurrencyCode): Minor {
  return decToMinor(mulDec(quantity, price), currency)
}

/**
 * Escape hatch to `number`, for SVG pixel geometry only.
 *
 * Every other conversion to `number` is a bug. Chart labels must be rendered from the original
 * Dec or Minor, never from the value this returns. The name is deliberately unpleasant so that
 * its appearance anywhere outside chart layout code is conspicuous in review.
 */
export function unsafeToNumberForPixelGeometryOnly(value: Dec | Minor): number {
  return new Decimal(value).toNumber()
}
