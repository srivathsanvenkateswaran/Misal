/**
 * What a refresh would do, and what it did — computed, never guessed.
 *
 * The panel in `RefreshPanel.tsx` renders two things: a statement of what is stale *before* the
 * user commits to a network round trip, and a per-instrument account of what happened afterwards.
 * Both are derived here so they can be tested without a DOM and without a socket.
 *
 * Three decisions shape this module.
 *
 * **The plan is built from the same parts the orchestrator uses.** Coverage is asked of the real
 * providers via `buildProviders` and their own `supports()` predicate; freshness is asked of
 * `priceAge`, the function `PriceService.refresh` consults to decide what is in scope. A second
 * implementation of "is this stale" would eventually disagree with the one that does the fetching,
 * and the screen would then be confidently wrong about work it did not do.
 *
 * **The providers are built with a fetcher that refuses.** Nothing in a plan may reach the network:
 * `supports()` is a pure predicate over instrument metadata, and constructing a provider must not
 * become a reason to open a socket.
 *
 * **A price is never re-derived.** Everything below moves `Dec` strings around and compares them
 * with `compareDec`. No total is computed here, nothing is rounded, and no value is invented for an
 * instrument that failed — a failed fetch is reported as a failure and the stored price stands.
 */

import { compareDec } from '@domain/numeric'
import type { CurrencyCode, Dec } from '@domain/numeric'
import { instantToDate, priceAge } from '@valuation/index'
import type { AssetClass, PricePoint, PriceSource } from '@valuation/index'
import type { PortfolioRows, PriceRow } from '../../data/client'
import {
  BASE_CURRENCY_SETTING,
  DEFAULT_PRICE_TTL_MINUTES,
  LAST_REFRESH_SETTING,
  PRICE_TTL_SETTING,
  buildProviders,
  describeProviderError,
  foreignCurrencies,
  ttlGate,
} from '../../data/refresh'
import type { MarketDataFetcher, RefreshNoteCode, RefreshOutcome } from '../../data/refresh'
import { buildInstruments } from '../../data/portfolio'

/**
 * The fetcher handed to the providers while planning.
 *
 * A plan is a statement about stored rows. If this is ever called it is a defect, and the refusal
 * says so rather than quietly performing the request.
 */
const NEVER_FETCHES: MarketDataFetcher = () =>
  Promise.reject(new Error('the refresh plan never fetches — this fetcher exists to be unused'))

/** Freshness of the stored price, in the terms the valuation engine already uses. */
export type Freshness = 'never_priced' | 'fresh' | 'stale' | 'very_stale'

export interface PlanRow {
  readonly instrumentId: string
  readonly displayName: string
  readonly assetClass: AssetClass
  readonly currency: CurrencyCode
  /** The provider that would be asked, or null when no provider covers this instrument at all. */
  readonly providerId: PriceSource | null
  readonly freshness: Freshness
  /** The date of the newest stored price, or null when there is none. */
  readonly asOf: string | null
  /** Calendar days from `asOf` to the valuation date. Null when never priced. */
  readonly ageDays: number | null
  readonly source: PriceSource | null
  /** A manual price exists for this instrument, so it has a value even with no provider. */
  readonly manuallyPriced: boolean
}

export interface ProviderLoad {
  readonly providerId: PriceSource
  /** Instruments this provider would be asked about in this run. */
  readonly instruments: number
}

export interface RefreshPlan {
  /** The IST date freshness is judged against — the same one `PriceService.refresh` uses. */
  readonly valuationDate: string
  readonly rows: readonly PlanRow[]
  /** Covered and not fresh: the instruments a provider will actually be asked about. */
  readonly targets: readonly PlanRow[]
  /** No provider covers these, whatever their freshness. The manual-price population. */
  readonly uncovered: readonly PlanRow[]
  /** Covered, with no stored price at all. */
  readonly neverPriced: readonly PlanRow[]
  /** Covered, with a price past its publication cadence. */
  readonly stalePriced: readonly PlanRow[]
  /** Covered and fresh, so not asked about. */
  readonly fresh: readonly PlanRow[]
  readonly load: readonly ProviderLoad[]
  readonly gate: { readonly eligible: boolean; readonly nextEligibleAt: string | null }
  readonly lastRefreshAt: string | null
  /** The stored cache lifetime, as text. A count of minutes is never parsed into a float here. */
  readonly ttlMinutes: string
  readonly baseCurrency: string
  /** Foreign currencies held, each of which needs a rate or its holdings leave net worth. */
  readonly foreign: readonly string[]
}

/** The newest stored row for an instrument, manual winning a tie on the same date. */
function newestPrice(rows: readonly PriceRow[]): PriceRow | null {
  let best: PriceRow | null = null
  for (const row of rows) {
    if (best === null || row.asOf > best.asOf) {
      best = row
      continue
    }
    if (row.asOf === best.asOf && row.source === 'manual') best = row
  }
  return best
}

function asPoint(row: PriceRow): PricePoint {
  // Cast rather than validated, exactly as the orchestrator seeds its store. A malformed decimal is
  // a defect the mapping boundary reports; a freshness readout is not the place to throw over one.
  return {
    instrumentId: row.instrumentId,
    asOf: row.asOf,
    close: row.close as Dec,
    currency: row.currency as CurrencyCode,
    source: row.source,
    fetchedAt: row.fetchedAt,
  }
}

/**
 * What a refresh would do, given the rows on disk and the clock.
 *
 * `now` is an ISO instant. The valuation date is derived from it the same way
 * `PriceService.refresh` derives its own, so a price this screen calls stale is a price the service
 * will also call stale.
 */
export function buildPlan(rows: PortfolioRows, now: string): RefreshPlan {
  const instruments = buildInstruments(rows, rows.aliases)
  const valuationDate = instantToDate(now)
  const providers = buildProviders(NEVER_FETCHES, null).providers

  const pricesByInstrument = new Map<string, PriceRow[]>()
  for (const price of rows.prices) {
    const bucket = pricesByInstrument.get(price.instrumentId)
    if (bucket === undefined) pricesByInstrument.set(price.instrumentId, [price])
    else bucket.push(price)
  }

  const planRows: PlanRow[] = []
  for (const instrument of instruments.values()) {
    const stored = pricesByInstrument.get(instrument.id) ?? []
    const latest = newestPrice(stored)
    const provider = providers.find((candidate) => candidate.supports(instrument)) ?? null

    let freshness: Freshness = 'never_priced'
    let ageDays: number | null = null
    if (latest !== null) {
      const { age } = priceAge({
        point: asPoint(latest),
        assetClass: instrument.assetClass,
        valuationDate,
      })
      freshness = age.staleness
      ageDays = age.ageDays
    }

    planRows.push({
      instrumentId: instrument.id,
      displayName: instrument.displayName,
      assetClass: instrument.assetClass,
      currency: instrument.currency,
      providerId: provider === null ? null : provider.id,
      freshness,
      asOf: latest === null ? null : latest.asOf,
      ageDays,
      source: latest === null ? null : latest.source,
      manuallyPriced: stored.some((row) => row.source === 'manual'),
    })
  }

  planRows.sort((a, b) => a.displayName.localeCompare(b.displayName))

  const covered = planRows.filter((row) => row.providerId !== null)
  const targets = covered.filter((row) => row.freshness !== 'fresh')

  const load = new Map<PriceSource, number>()
  for (const row of targets) {
    if (row.providerId === null) continue
    load.set(row.providerId, (load.get(row.providerId) ?? 0) + 1)
  }

  const settings = rows.settings
  const base = settings.get(BASE_CURRENCY_SETTING) ?? 'INR'
  const storedTtl = settings.get(PRICE_TTL_SETTING)

  return {
    valuationDate,
    rows: planRows,
    targets,
    uncovered: planRows.filter((row) => row.providerId === null),
    neverPriced: covered.filter((row) => row.freshness === 'never_priced'),
    stalePriced: covered.filter((row) => row.freshness === 'stale' || row.freshness === 'very_stale'),
    fresh: covered.filter((row) => row.freshness === 'fresh'),
    load: [...load].map(([providerId, instruments_]) => ({
      providerId,
      instruments: instruments_,
    })),
    gate: ttlGate(settings, now),
    lastRefreshAt: settings.get(LAST_REFRESH_SETTING) ?? null,
    ttlMinutes:
      storedTtl === undefined || !/^\d{1,7}$/.test(storedTtl.trim())
        ? DEFAULT_PRICE_TTL_MINUTES.toString()
        : storedTtl.trim(),
    baseCurrency: base,
    foreign: foreignCurrencies(instruments, rows, base),
  }
}

// ---------------------------------------------------------------------------
// What happened
// ---------------------------------------------------------------------------

/** A row as it crossed the boundary to `save_prices`. Decimal text, never a number. */
export interface SavedPriceRow {
  readonly instrumentId: string
  readonly asOf: string
  readonly close: string
  readonly currency: string
  readonly source: string
  readonly fetchedAt: string
}

/**
 * One run, as observed at the two seams the orchestrator already has.
 *
 * `saved`, `heldByManual` and `unknown` are captured by wrapping the invoker rather than by adding
 * a reporting channel to `refreshPrices`: the rows it hands to `save_prices` *are* the rows that
 * were fetched and accepted, and the outcome it gets back already names what the write refused.
 */
export interface RefreshRun {
  readonly outcome: RefreshOutcome
  readonly saved: readonly SavedPriceRow[]
  /** `"<instrumentId> <asOf>"` keys, exactly as `save_prices` returns them. */
  readonly heldByManual: readonly string[]
  readonly unknown: readonly string[]
  /** The user stopped it. Everything not yet fetched is reported as unreachable. */
  readonly cancelled: boolean
}

export type ReportStatus = 'refreshed' | 'unchanged' | 'held' | 'failed' | 'no_result'

export interface ReportRow {
  readonly instrumentId: string
  readonly displayName: string
  readonly status: ReportStatus
  /** A sentence naming what happened to this instrument. */
  readonly detail: string
  readonly asOf: string | null
  /** The fetched close, digit for digit. Null unless something was written. */
  readonly close: string | null
  readonly currency: string | null
  readonly source: string | null
  readonly code: RefreshNoteCode | null
}

const STATUS_ORDER: Record<ReportStatus, number> = {
  failed: 0,
  held: 1,
  no_result: 2,
  refreshed: 3,
  unchanged: 4,
}

export const STATUS_LABEL: Record<ReportStatus, string> = {
  refreshed: 'Refreshed',
  unchanged: 'Unchanged',
  held: 'Held by your manual price',
  failed: 'Failed',
  no_result: 'No result',
}

/** `"<instrumentId> <asOf>"`, the key `save_prices` reports refusals and unknowns with. */
function splitKey(key: string): { instrumentId: string; asOf: string | null } {
  const gap = key.lastIndexOf(' ')
  if (gap === -1) return { instrumentId: key, asOf: null }
  return { instrumentId: key.slice(0, gap), asOf: key.slice(gap + 1) }
}

/** The stored close for that instrument on or before `asOf`, which is what `updated` compares to. */
function storedAt(stored: readonly PriceRow[], instrumentId: string, asOf: string): PriceRow | null {
  let best: PriceRow | null = null
  for (const row of stored) {
    if (row.instrumentId !== instrumentId || row.asOf > asOf) continue
    if (best === null || row.asOf > best.asOf) best = row
  }
  return best
}

/**
 * What happened to each instrument, in the four terms a user can act on.
 *
 * The order of resolution matters and is not arbitrary:
 *
 *  1. **Failed** first, from the orchestrator's own per-instrument failures. A failure is the only
 *     outcome that costs the user something, so nothing may mask it.
 *  2. **Held** next, from `save_prices`'s `heldByManual`. A row can be both sent and refused, and
 *     calling that "refreshed" because it was sent would report the opposite of what happened.
 *  3. **Refreshed / unchanged**, by comparing the written close against the stored one with
 *     `compareDec`. Same rule as `PriceService.refresh` applies to its own counters.
 *  4. **Held, invisibly.** A fetched row for a day a manual price already covers is refused inside
 *     the app before `save_prices` is called, so it appears in neither list. Reporting it as
 *     "no result" would be alarming and wrong; it is the manual override doing its job.
 *
 * `stored` must be the prices as they were *before* the run, or every write reads as unchanged.
 */
export function buildReport(
  plan: RefreshPlan,
  run: RefreshRun,
  stored: readonly PriceRow[],
): readonly ReportRow[] {
  const byId = new Map(plan.rows.map((row) => [row.instrumentId, row]))
  const failures = new Map(
    (run.outcome.prices?.failures ?? []).map((failure) => [failure.instrumentId, failure.error]),
  )
  const saved = new Map(run.saved.map((row) => [row.instrumentId, row]))
  const held = new Map(run.heldByManual.map((key) => [splitKey(key).instrumentId, splitKey(key)]))
  const unknown = new Map(run.unknown.map((key) => [splitKey(key).instrumentId, splitKey(key)]))

  const ids = new Set<string>()
  for (const row of plan.targets) ids.add(row.instrumentId)
  for (const row of plan.uncovered) if (row.freshness !== 'fresh') ids.add(row.instrumentId)
  for (const id of failures.keys()) ids.add(id)
  for (const id of saved.keys()) ids.add(id)
  for (const id of held.keys()) ids.add(id)
  for (const id of unknown.keys()) ids.add(id)

  const report: ReportRow[] = []
  for (const instrumentId of ids) {
    const planRow = byId.get(instrumentId)
    const displayName = planRow?.displayName ?? instrumentId
    const base = { instrumentId, displayName }

    const failure = failures.get(instrumentId)
    if (failure !== undefined) {
      const described = describeProviderError(failure)
      report.push({
        ...base,
        status: 'failed',
        detail: described.message,
        asOf: null,
        close: null,
        currency: null,
        source: null,
        code: described.code,
      })
      continue
    }

    const unknownKey = unknown.get(instrumentId)
    if (unknownKey !== undefined) {
      report.push({
        ...base,
        status: 'failed',
        detail:
          'A price came back but had nowhere to go — the instrument no longer exists. This is a defect in Misal, not in your data.',
        asOf: unknownKey.asOf,
        close: null,
        currency: null,
        source: null,
        code: 'UNKNOWN_INSTRUMENT',
      })
      continue
    }

    const heldKey = held.get(instrumentId)
    if (heldKey !== undefined) {
      report.push({
        ...base,
        status: 'held',
        detail: `A price you entered for ${heldKey.asOf ?? 'that day'} was kept in preference to the fetched one. A refresh never overwrites a manual price.`,
        asOf: heldKey.asOf,
        close: null,
        currency: null,
        source: null,
        code: 'MANUAL_OVERRIDE_HELD',
      })
      continue
    }

    const written = saved.get(instrumentId)
    if (written !== undefined) {
      const previous = storedAt(stored, instrumentId, written.asOf)
      const same =
        previous !== null &&
        previous.asOf === written.asOf &&
        compareDec(previous.close as Dec, written.close as Dec) === 0
      report.push({
        ...base,
        status: same ? 'unchanged' : 'refreshed',
        detail: same
          ? 'The provider returned the price already stored. Nothing moved, and the row was rewritten only to record that it was checked just now.'
          : 'A new price was stored.',
        asOf: written.asOf,
        close: written.close,
        currency: written.currency,
        source: written.source,
        code: null,
      })
      continue
    }

    if (planRow?.manuallyPriced === true) {
      report.push({
        ...base,
        status: 'held',
        detail:
          'A manual price already covers the day the provider quoted, so the fetched row was refused before it left the app. Your price stands.',
        asOf: planRow.asOf,
        close: null,
        currency: null,
        source: 'manual',
        code: 'MANUAL_OVERRIDE_HELD',
      })
      continue
    }

    report.push({
      ...base,
      status: 'no_result',
      detail: run.cancelled
        ? 'The run was stopped before this instrument was reached. Nothing about it was changed.'
        : 'Nothing came back and nothing failed, which should not be possible. Please report it.',
      asOf: null,
      close: null,
      currency: null,
      source: null,
      code: null,
    })
  }

  report.sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    return byStatus === 0 ? a.displayName.localeCompare(b.displayName) : byStatus
  })
  return report
}

/** How many instruments landed in each outcome. Counts, and nothing derived from money. */
export function countByStatus(report: readonly ReportRow[]): Record<ReportStatus, number> {
  const counts: Record<ReportStatus, number> = {
    refreshed: 0,
    unchanged: 0,
    held: 0,
    failed: 0,
    no_result: 0,
  }
  for (const row of report) counts[row.status] += 1
  return counts
}
