/**
 * The transaction natural key — the single definition, used by every ingestion path.
 *
 * This exists because there were two. Statement ingestion and the exchange adapters each grew
 * their own, and they disagreed on four things at once: the field separator, whether the date was
 * the local calendar date or the UTC date, whether trailing zeros were trimmed from the quantity,
 * and whether an external id took part. Any one of those produces a different hash, so the same
 * trade arriving from a CSV export and from the exchange API deduplicated against nothing.
 *
 * The consequence was not subtle. Both copies land, and the user's net worth is overstated by the
 * value of every doubled holding — the same failure `account.identity_key` exists to prevent for
 * folios. Nothing failed when the two drifted, because nothing compared them.
 *
 * So: one function, one field list, and a conformance test that computes a key through both
 * subsystems' call paths and asserts they match.
 */

import { type Dec } from './numeric'

/** Field separator. ASCII unit separator, which cannot occur in any component. */
const SEP = ''

export interface NaturalKeyParts {
  readonly accountId: string
  readonly instrumentId: string
  /** Transaction type, e.g. 'buy'. */
  readonly type: string
  /**
   * The **local calendar date**, `YYYY-MM-DD`.
   *
   * Deliberately not an instant, and deliberately not derived here from one. A CSV export states
   * a date; an API states a millisecond. Keying on the instant would make a CSV row and its API
   * twin two different transactions.
   *
   * It must be the date in the source's own timezone, never the UTC date. A trade at 02:00 IST is
   * the 6th locally and the 5th in UTC, so slicing a UTC instant silently shifts every
   * late-evening Indian trade by a day and breaks deduplication against a statement of the same
   * trade. Callers therefore pass a date they computed on purpose — the type will not let them
   * hand over an instant by accident.
   */
  readonly occurredDate: string
  readonly quantity: Dec
  /**
   * Gross consideration in minor units, or null.
   *
   * Null serialises as an empty field rather than as '0'. A bonus of 10 units carries no amount;
   * a zero-value transfer of 10 units carries an amount of zero. They are different events and
   * must not collide.
   */
  readonly amountMinor: string | null
  /**
   * The source's own transaction id, where it has one.
   *
   * Exchanges do; statements do not, and pass nothing. Without it, two genuinely distinct rows
   * that differ in nothing else collide: the same commission, in the same asset, on the same day,
   * from two different pages of one API response is two real fees. `occurrence` cannot separate
   * them, because it counts within a document while the unique index spans all of them.
   *
   * Both supported exchanges' CSV exports carry the same ids as their APIs, so including it does
   * not cost the CSV-then-API deduplication this key exists for.
   */
  readonly externalId?: string | undefined
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export class NaturalKeyError extends Error {
  override readonly name = 'NaturalKeyError'
}

/**
 * `10.000` -> `10`, `10.500` -> `10.5`, `10` -> `10`.
 *
 * Identity only. Storage keeps the scale as written, because a fund statement printing four
 * decimals is asserting that precision. But a source printing `10.000` and another printing `10`
 * describe the same trade, so the key must not distinguish them.
 */
export function trimTrailingZeros(value: Dec): string {
  if (!value.includes('.')) return value
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '')
  return trimmed === '-0' || trimmed === '' ? '0' : trimmed
}

/**
 * The exact string that gets hashed.
 *
 * Exposed separately from the hash so tests and debugging can see what was keyed, and so a
 * mismatch between two call paths is legible rather than two unequal hex strings.
 */
export function naturalKeyInput(parts: NaturalKeyParts): string {
  if (!DATE_PATTERN.test(parts.occurredDate)) {
    // Catches the exact mistake this module was written to fix: an ISO instant sliced, or passed
    // whole, where a local calendar date was required.
    throw new NaturalKeyError(
      `occurredDate must be a local calendar date as YYYY-MM-DD, received ${JSON.stringify(
        parts.occurredDate,
      )}`,
    )
  }

  return [
    parts.accountId,
    parts.instrumentId,
    parts.type,
    parts.occurredDate,
    trimTrailingZeros(parts.quantity),
    parts.amountMinor ?? '',
    parts.externalId ?? '',
  ].join(SEP)
}

/**
 * Assign `occurrence` within one document or one fetched page.
 *
 * Two genuinely distinct transactions can be identical in every keyed field — a doubled SIP
 * instalment, or two fills of the same size at the same price in the same second. Counting
 * identical keys within a batch keeps them distinct, while re-importing that batch reproduces
 * exactly the same numbering, so the re-import is entirely duplicates.
 */
export function assignOccurrences(keys: readonly string[]): number[] {
  const seen = new Map<string, number>()
  return keys.map((key) => {
    const next = seen.get(key) ?? 0
    seen.set(key, next + 1)
    return next
  })
}
