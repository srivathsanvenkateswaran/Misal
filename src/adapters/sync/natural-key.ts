/**
 * The transaction natural key for exchange fills.
 *
 * A thin adapter over `@domain/natural-key`, which is the single definition shared with statement
 * ingestion. This file used to carry its own copy, and the two disagreed on four things at once -
 * the field separator, the date basis, quantity trimming, and the external id - so the same trade
 * arriving from a CSV export and from the API deduplicated against nothing and the holding was
 * counted twice. Nothing failed when they drifted, because nothing compared them.
 *
 * Everything here is now about one decision the shared function deliberately refuses to make for
 * its callers: which calendar date this fill happened on.
 */

import {
  type NaturalKeyParts as CanonicalParts,
  assignOccurrences,
  naturalKeyInput,
} from '@domain/natural-key'
import { sha256Hex } from '../wire'

export { assignOccurrences }

export interface NaturalKeyParts extends Omit<CanonicalParts, 'occurredDate' | 'quantity'> {
  /** UTC ISO-8601 instant, as both exchanges report it. */
  readonly occurredAt: string
  readonly quantity: string
}

/**
 * The calendar date an exchange fill is keyed on.
 *
 * Exchanges timestamp in UTC and their CSV exports do the same, so for this source the UTC date
 * *is* the local date and slicing the instant is correct. That is the opposite of the statement
 * path, where using the UTC date would shift every late-evening Indian trade by a day.
 *
 * Written as a named function rather than an inline slice so the choice is visible and reviewable.
 * The shared key function takes a date and refuses an instant precisely so this decision cannot be
 * made by accident in either direction.
 */
export function exchangeLocalDate(occurredAt: string): string {
  return occurredAt.slice(0, 10)
}

export function naturalKey(parts: NaturalKeyParts): Promise<string> {
  return sha256Hex(
    naturalKeyInput({
      accountId: parts.accountId,
      instrumentId: parts.instrumentId,
      type: parts.type,
      occurredDate: exchangeLocalDate(parts.occurredAt),
      quantity: parts.quantity as CanonicalParts['quantity'],
      amountMinor: parts.amountMinor,
      externalId: parts.externalId,
    }),
  )
}
