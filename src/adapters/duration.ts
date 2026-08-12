/* eslint-disable no-restricted-syntax -- see the module comment */
/**
 * The one place an adapter converts an exact integer to a JavaScript `number`.
 *
 * Durations are timer delays, not money and not quantities: `setTimeout` takes a `number` and
 * there is no way around that. Isolating the conversion here keeps the float ban meaningful
 * everywhere else, and makes any other appearance of `Number(` under src/adapters an obvious
 * review flag rather than one of many.
 *
 * Values are bounded before conversion, so no caller can hand a bigint that a double would
 * round.
 */

/** One hour. Long enough for any exchange cooldown a background tracker should honour inline. */
const MAX_DELAY_MS = 3_600_000n

export function delayMillis(value: bigint): number {
  const bounded = value < 0n ? 0n : value > MAX_DELAY_MS ? MAX_DELAY_MS : value
  return Number(bounded)
}
