/**
 * Measured<T> - the product's honesty promise, encoded in the type system.
 *
 * Some accounts give full transaction history; others give only a snapshot of what is held today.
 * Metrics that need history - XIRR, realised P&L, cost basis - are real for the first kind and
 * genuinely unknowable for the second.
 *
 * The failure this type prevents is the most damaging one Misal could ship: rendering a zero, a
 * blank or a dash for a metric that could not be computed, which a reader interprets as "no gain"
 * rather than "not known". Because the `measured: false` branch has no `value` field at all,
 * reaching for one without narrowing is a compile error, not a code-review catch.
 *
 * Nothing in this module rounds, formats or defaults. A metric is either measured or it is not.
 */

import { type Minor, ZERO_MINOR, compareMinor, isZeroMinor, subMinor } from './numeric'

/** Why a metric could not be computed. Rendered to the user verbatim, so these are exhaustive. */
export type NotMeasuredReason =
  | 'no_transaction_history'
  | 'no_price'
  | 'no_fx_rate'
  | 'no_convergence'
  | 'unknown_tax_regime'
  | 'unresolved_instrument'

/** Human-readable text for each reason. The UI must never invent its own wording. */
export const REASON_TEXT: Record<NotMeasuredReason, string> = {
  no_transaction_history: 'no transaction history',
  no_price: 'no price available',
  no_fx_rate: 'no exchange rate for this date',
  no_convergence: 'could not be calculated',
  unknown_tax_regime: 'tax treatment unknown',
  unresolved_instrument: 'instrument not yet identified',
}

/**
 * How much of the portfolio a metric actually accounts for.
 *
 * `covered` and `total` are absolute values rather than a percentage because the UI shows both
 * the fraction and the excluded rupee amount, and deriving one from a rounded percentage would
 * misstate the other.
 */
export interface Coverage {
  readonly covered: Minor
  readonly total: Minor
  /** Account ids excluded from this metric, so the UI can name them rather than say "some". */
  readonly excludedAccounts: readonly string[]
}

export type Measured<T> =
  | {
      readonly measured: true
      readonly value: T
      readonly coverage: Coverage
    }
  | {
      readonly measured: false
      readonly reason: NotMeasuredReason
      /** Portfolio value this metric cannot speak for. Displayed, so it must be exact. */
      readonly excluded: Minor
    }

export function measured<T>(value: T, coverage: Coverage): Measured<T> {
  return { measured: true, value, coverage }
}

export function notMeasured<T>(reason: NotMeasuredReason, excluded: Minor): Measured<T> {
  return { measured: false, reason, excluded }
}

/** Coverage over the whole portfolio, with nothing excluded. */
export function fullCoverage(total: Minor): Coverage {
  return { covered: total, total, excludedAccounts: [] }
}

export function partialCoverage(
  covered: Minor,
  total: Minor,
  excludedAccounts: readonly string[],
): Coverage {
  if (compareMinor(covered, total) > 0) {
    throw new Error(`Coverage exceeds total: ${covered} of ${total}`)
  }
  return { covered, total, excludedAccounts }
}

/** True when a metric accounts for the entire portfolio. */
export function isComplete(coverage: Coverage): boolean {
  return compareMinor(coverage.covered, coverage.total) === 0
}

/** Value the metric does not speak for. */
export function excludedValue(coverage: Coverage): Minor {
  return subMinor(coverage.total, coverage.covered)
}

/**
 * Coverage as a percentage string with one decimal place, for display.
 *
 * Returns a string rather than a number so it cannot be fed back into arithmetic, and so the
 * caller cannot re-round an already-rounded figure.
 *
 * Truncates rather than rounds, deliberately. Rounding would let 99.96% coverage display as
 * "100.0%", which asserts completeness the data does not support. Under truncation, "100.0%"
 * appears only when a metric genuinely spans the entire portfolio, and the figure never
 * overstates how much is actually measured. The cost is that the approved mockup's "71.9%"
 * renders here as "71.8%" - the conservative direction, which is the right way to be wrong
 * about a trust indicator.
 */
export function coveragePercent(coverage: Coverage): string {
  if (isZeroMinor(coverage.total)) return '0.0'
  const covered = BigInt(coverage.covered)
  const total = BigInt(coverage.total)
  // Scale by 1000 for one decimal place, using integer maths throughout.
  const tenths = (covered * 1000n) / total
  const whole = tenths / 10n
  const frac = tenths % 10n
  return `${whole}.${frac}`
}

/**
 * Map over a measured value, preserving the not-measured branch.
 *
 * Deliberately has no `orElse` or `getOrDefault` counterpart. Supplying a default for an
 * unmeasurable metric is precisely the bug this module exists to make impossible, so the only way
 * to read a value is to handle both branches.
 */
export function mapMeasured<A, B>(m: Measured<A>, f: (a: A) => B): Measured<B> {
  return m.measured ? measured(f(m.value), m.coverage) : m
}

/** Combine two measured values. The result is measured only when both inputs are. */
export function zipMeasured<A, B, C>(
  a: Measured<A>,
  b: Measured<B>,
  f: (a: A, b: B) => C,
): Measured<C> {
  if (!a.measured) return a
  if (!b.measured) return b
  const covered = compareMinor(a.coverage.covered, b.coverage.covered) <= 0
    ? a.coverage.covered
    : b.coverage.covered
  const total = compareMinor(a.coverage.total, b.coverage.total) >= 0
    ? a.coverage.total
    : b.coverage.total
  const excludedAccounts = [
    ...new Set([...a.coverage.excludedAccounts, ...b.coverage.excludedAccounts]),
  ]
  return measured(f(a.value, b.value), { covered, total, excludedAccounts })
}

export const NOTHING_EXCLUDED = ZERO_MINOR
