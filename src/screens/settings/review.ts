/**
 * What the review queue withholds, counted rather than described.
 *
 * The queue's whole purpose is a rupee figure. "Some holdings unresolved" is not something a user
 * can act on; "₹11,86,400 withheld from every total" is, and it is the number migration 0006 exists
 * to stop a dismissal silently zeroing.
 *
 * Three rules, all of them the same rule:
 *
 *   **Nothing here is a float.** Minor units arrive as strings and are added with `addMinor`, which
 *   is BigInt arithmetic. Formatting happens once, at the display boundary, in `formatWithheld`.
 *
 *   **A total is per currency, never mixed.** Adding a USD holding's minor units to an INR total
 *   would produce a number that is not money in any currency. Each is carried separately and the
 *   screen states both.
 *
 *   **An amount that cannot be computed is counted, not coerced.** An entry whose source printed no
 *   value, and an entry in a currency this build has no formatting rule for, are each counted and
 *   named. Neither is folded in as a zero — a zero reads as "worth nothing" for a holding whose
 *   value is merely unknown, which is the exact lie the queue exists to prevent.
 */

import type { CurrencyCode, Minor } from '@domain/numeric'
import { ZERO_MINOR, addMinor, minor } from '@domain/numeric'
import { formatMoney, money } from '@ui/format'
import type { ReviewEntryState, ReviewQueueEntry } from '../../data/settings'

/** Currencies `formatMoney` has a grouping rule for. Anything else is reported, never guessed. */
const FORMATTABLE: readonly CurrencyCode[] = ['INR', 'USD']

function currencyOf(raw: string | null): CurrencyCode | null {
  return FORMATTABLE.find((code) => code === raw) ?? null
}

export interface WithheldTotal {
  readonly currency: CurrencyCode
  readonly minor: Minor
  readonly entries: number
}

export interface WithheldSummary {
  /** One per currency seen, in the order the currencies first appear. Never summed together. */
  readonly totals: readonly WithheldTotal[]
  /** Entries whose source stated no value at all. */
  readonly unstated: number
  /** Entries carrying a currency this build cannot format, or a value it cannot parse. */
  readonly unquantifiable: number
  readonly entries: number
}

export const EMPTY_SUMMARY: WithheldSummary = {
  totals: [],
  unstated: 0,
  unquantifiable: 0,
  entries: 0,
}

/**
 * Add up what a set of entries is holding out of net worth.
 *
 * Every entry passed in is withheld, whatever its state: that is the point of the split between
 * `ignored_at` and `resolved_at`. A dismissed entry counts here exactly as an open one does.
 */
export function summariseWithheld(entries: readonly ReviewQueueEntry[]): WithheldSummary {
  const byCurrency = new Map<CurrencyCode, { minor: Minor; entries: number }>()
  let unstated = 0
  let unquantifiable = 0

  for (const entry of entries) {
    const raw = entry.observedValueMinor
    if (raw === null || raw === '') {
      unstated += 1
      continue
    }
    const currency = currencyOf(entry.currency)
    if (currency === null) {
      unquantifiable += 1
      continue
    }
    let parsed: Minor
    try {
      parsed = minor(raw)
    } catch {
      // A half-parsed figure is the one thing that must not become a plausible total.
      unquantifiable += 1
      continue
    }
    const running = byCurrency.get(currency) ?? { minor: ZERO_MINOR, entries: 0 }
    byCurrency.set(currency, {
      minor: addMinor(running.minor, parsed),
      entries: running.entries + 1,
    })
  }

  return {
    totals: [...byCurrency].map(([currency, running]) => ({
      currency,
      minor: running.minor,
      entries: running.entries,
    })),
    unstated,
    unquantifiable,
    entries: entries.length,
  }
}

/**
 * The withheld figure as text, or the reason there is no figure.
 *
 * Never returns a zero standing in for an unknown. When nothing is quantifiable the caller gets a
 * sentence saying so, which is what goes on screen in place of the number.
 */
export function formatWithheld(summary: WithheldSummary): string {
  if (summary.totals.length === 0) {
    if (summary.entries === 0) return 'nothing withheld'
    if (summary.unquantifiable > 0) {
      return 'amount unknown — the values are in a currency Misal cannot total'
    }
    return 'amount unknown — the source stated no value'
  }
  return summary.totals
    .map((total) => formatMoney(money(total.minor, total.currency)))
    .join(' + ')
}

/**
 * The caveat that has to travel beside the figure, or null when there is none.
 *
 * Kept separate from `formatWithheld` so a total is never printed as if it covered entries it does
 * not cover. "₹1,18,640 withheld" beside two entries with no stated value is a smaller number than
 * the truth, and saying so is the difference between a total and an estimate.
 */
export function withheldCaveat(summary: WithheldSummary): string | null {
  const parts: string[] = []
  if (summary.unstated > 0) {
    parts.push(
      summary.unstated === 1
        ? '1 entry whose source stated no value'
        : `${String(summary.unstated)} entries whose source stated no value`,
    )
  }
  if (summary.unquantifiable > 0) {
    parts.push(
      summary.unquantifiable === 1
        ? '1 entry in a currency Misal cannot total'
        : `${String(summary.unquantifiable)} entries in a currency Misal cannot total`,
    )
  }
  if (parts.length === 0) return null
  return `Excludes ${parts.join(' and ')}; the amount those withhold is unknown, not zero.`
}

/** Fixed copy per state. A component may not invent its own wording for what a state means. */
export const STATE_LABEL: Record<ReviewEntryState, string> = {
  open: 'Open',
  dismissed: 'Dismissed',
  mapped: 'Mapped — waiting for a statement',
}

export const STATE_MEANING: Record<ReviewEntryState, string> = {
  open: 'Nobody has named this instrument yet, so its value is held out of every total.',
  dismissed:
    'You asked not to be asked again. The value is still held out of every total, because it is still genuinely missing from net worth — dismissing stopped the question, not the withholding.',
  mapped:
    'The instrument is named, so the next statement carrying it resolves without asking. The rows this import withheld are still not in the ledger, so the value stays withheld until a document carrying them is imported.',
}

export const STATE_ORDER: readonly ReviewEntryState[] = ['open', 'mapped', 'dismissed']

export function entriesInState(
  entries: readonly ReviewQueueEntry[],
  state: ReviewEntryState,
): readonly ReviewQueueEntry[] {
  return entries.filter((entry) => entry.state === state)
}

/** `isin:INF179K01YV8` → `Unrecognised ISIN`. The prefix is what the parser could read. */
export function identifierLabel(rawIdentifier: string): string {
  const prefix = rawIdentifier.split(':')[0] ?? ''
  switch (prefix) {
    case 'isin':
      return 'Unrecognised ISIN'
    case 'amfi':
      return 'Unrecognised AMFI scheme code'
    case 'nse':
    case 'bse':
      return `Unrecognised ${prefix.toUpperCase()} symbol`
    case 'nasdaq':
    case 'nyse':
      return `Unrecognised ${prefix.toUpperCase()} ticker`
    case 'provider-local':
      return 'Unrecognised broker or exchange code'
    case 'name':
      return 'Unrecognised name — the source printed no identifier'
    default:
      return 'Unrecognised identifier'
  }
}

export function identifierValue(rawIdentifier: string): string {
  const at = rawIdentifier.indexOf(':')
  return at === -1 ? rawIdentifier : rawIdentifier.slice(at + 1)
}

/** One entry's withheld amount, or null when there is nothing honest to print. */
export function entryWithheld(entry: ReviewQueueEntry): string | null {
  const summary = summariseWithheld([entry])
  const total = summary.totals[0]
  return total === undefined ? null : formatMoney(money(total.minor, total.currency))
}
