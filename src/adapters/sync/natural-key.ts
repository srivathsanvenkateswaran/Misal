/**
 * The transaction natural key.
 *
 * Deliberately computed from the same fields as a statement transaction - account, instrument,
 * type, the calendar date, quantity and gross amount - so a trade ingested from an exchange CSV
 * and the same trade from the API deduplicate against each other. That case is not hypothetical:
 * users import a CSV first and connect the key later.
 *
 * The date rather than the instant is used on purpose. A CSV export states a date; the API states
 * a millisecond. Keying on the instant would make every CSV row and its API twin two different
 * transactions.
 *
 * When the statement ingestion subsystem lands, this function moves into shared core code and
 * both callers use it. Until then it is here, and the field list must not drift.
 */

import { sha256Hex } from '../wire'

export interface NaturalKeyParts {
  readonly accountId: string
  readonly instrumentId: string
  readonly type: string
  /** UTC ISO-8601 instant; only the date part contributes. */
  readonly occurredAt: string
  readonly quantity: string
  readonly amountMinor: string | null
  /**
   * The exchange's own trade id, where the source has one.
   *
   * A deliberate addition to the core spec's field list, which was written for statements - and
   * statements have no ids, so they pass nothing here and behave exactly as specified.
   *
   * Without it, two genuinely distinct rows that differ in nothing else collide: the same
   * commission, in the same asset, on the same day, from two different pages is two real fees,
   * and `occurrence` cannot separate them because it counts within one document while the unique
   * index spans all of them. One of the two would be silently discarded as a duplicate.
   *
   * Both exchanges' CSV exports carry the same trade ids as their APIs, so including it does not
   * cost the CSV-then-API deduplication the shared key exists for.
   */
  readonly externalId?: string
}

export function naturalKey(parts: NaturalKeyParts): Promise<string> {
  return sha256Hex(
    [
      parts.accountId,
      parts.instrumentId,
      parts.type,
      parts.occurredAt.slice(0, 10),
      parts.quantity,
      parts.amountMinor ?? '',
      parts.externalId ?? '',
    ].join('|'),
  )
}

/**
 * Assign `occurrence` within one document.
 *
 * Two genuinely distinct transactions can be identical in every keyed field - a doubled SIP
 * instalment, or two fills of the same size at the same price in the same second. Counting
 * identical keys within a document keeps them distinct while a re-import of that document
 * reproduces exactly the same numbering.
 */
export function assignOccurrences(keys: readonly string[]): number[] {
  const seen = new Map<string, number>()
  return keys.map((key) => {
    const next = seen.get(key) ?? 0
    seen.set(key, next + 1)
    return next
  })
}
