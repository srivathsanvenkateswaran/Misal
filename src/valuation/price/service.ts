/**
 * The price service: a registry of providers, a read that never fetches, and a refresh that only
 * ever runs when the user asks for it.
 *
 * The `price` table *is* the cache. There is no second layer, no in-memory TTL map and no
 * distinction between "cached" and "stored", which keeps offline behaviour identical to online
 * behaviour with a stale price — the behaviour that actually gets tested.
 */

import { compareDec } from '@domain/numeric'
import { daysBetween, instantToDate } from '../calendar'
import type { AssetClass, InstrumentRef, IsoDate, IsoInstant } from '../types'
import { priceAge } from './staleness'
import type {
  PriceError,
  PricePoint,
  PriceProvider,
  PriceSelector,
  ProviderError,
  RefreshReport,
  RefreshScope,
} from './types'

export type PriceReadResult =
  | { readonly ok: true; readonly value: PricePoint }
  | { readonly ok: false; readonly error: PriceError }

export interface PriceStore {
  /** The most recent row at or before `on`. */
  at(instrumentId: string, on: IsoDate): PricePoint | null
  latest(instrumentId: string): PricePoint | null
  /**
   * Upsert with manual precedence. Returns false when the write was refused because a manual
   * override already holds that (instrument, date).
   */
  put(point: PricePoint): boolean
  rows(instrumentId: string): readonly PricePoint[]
}

/**
 * Manual override precedence is enforced on write, because `price`'s primary key
 * `(instrument_id, as_of)` cannot express it on read: a fetched value would simply overwrite the
 * manual one. The rule mirrors the SQL guard in the spec —
 * `WHERE excluded.source = 'manual' OR price.source != 'manual'`.
 */
export class InMemoryPriceStore implements PriceStore {
  private readonly byInstrument = new Map<string, Map<IsoDate, PricePoint>>()

  at(instrumentId: string, on: IsoDate): PricePoint | null {
    const rows = this.byInstrument.get(instrumentId)
    if (rows === undefined) return null
    let best: PricePoint | null = null
    for (const point of rows.values()) {
      if (point.asOf > on) continue
      if (best === null || point.asOf > best.asOf) best = point
    }
    return best
  }

  latest(instrumentId: string): PricePoint | null {
    const rows = this.byInstrument.get(instrumentId)
    if (rows === undefined) return null
    let best: PricePoint | null = null
    for (const point of rows.values()) {
      if (best === null || point.asOf > best.asOf) best = point
    }
    return best
  }

  put(point: PricePoint): boolean {
    const rows = this.byInstrument.get(point.instrumentId) ?? new Map<IsoDate, PricePoint>()
    const existing = rows.get(point.asOf)
    if (existing !== undefined && existing.source === 'manual' && point.source !== 'manual') {
      return false
    }
    rows.set(point.asOf, point)
    this.byInstrument.set(point.instrumentId, rows)
    return true
  }

  rows(instrumentId: string): readonly PricePoint[] {
    return [...(this.byInstrument.get(instrumentId)?.values() ?? [])].sort((a, b) =>
      a.asOf < b.asOf ? -1 : 1,
    )
  }
}

export interface BudgetState {
  readonly istDate: IsoDate
  readonly used: number
}

/**
 * The daily credit counter is persistent, not in-memory: a user restarting the application six
 * times would otherwise burn through the daily quota and get locked out with no explanation.
 */
export interface BudgetStore {
  read(): BudgetState | null
  write(state: BudgetState): void
}

export class InMemoryBudgetStore implements BudgetStore {
  private state: BudgetState | null = null
  read(): BudgetState | null {
    return this.state
  }
  write(state: BudgetState): void {
    this.state = state
  }
}

export class CreditBudget {
  constructor(
    private readonly store: BudgetStore,
    private readonly perDay: number,
  ) {}

  remaining(istDate: IsoDate): number {
    const state = this.store.read()
    if (state === null || state.istDate !== istDate) return this.perDay
    return this.perDay - state.used
  }

  /** All-or-nothing: a partially funded batch would report successes it never fetched. */
  consume(credits: number, istDate: IsoDate): boolean {
    if (credits > this.remaining(istDate)) return false
    const state = this.store.read()
    const used = state === null || state.istDate !== istDate ? credits : state.used + credits
    this.store.write({ istDate, used })
    return true
  }
}

export interface PriceServiceOptions {
  readonly store: PriceStore
  readonly instruments: ReadonlyMap<string, InstrumentRef>
  readonly now: () => IsoInstant
  readonly budget?: CreditBudget
}

export class PriceService {
  private readonly providers: PriceProvider[] = []

  constructor(private readonly options: PriceServiceOptions) {}

  register(provider: PriceProvider): void {
    this.providers.push(provider)
  }

  /** Resolution order for a read is manual → provider → none; there is no fourth option. */
  providerFor(instrument: InstrumentRef): PriceProvider | null {
    return this.providers.find((provider) => provider.supports(instrument)) ?? null
  }

  /**
   * Pure read from the local `price` table. Never fetches.
   *
   * A date selector is answered exactly or not at all. The store still finds the nearest preceding
   * row, but when that row is not *on* the requested date it comes back as `PRICE_NOT_ON_DATE`
   * with the row attached as `lastKnown`, never as `{ ok: true }`. This follows `Measured`: the
   * branch that cannot be trusted has no `value` field to reach for, so substituting a stale price
   * for the requested day's is a compile error rather than a code-review catch. It previously was
   * neither — the caller got `ok: true` and a `close` from days earlier, and the staleness
   * indicator the product promises never fired.
   *
   * `'latest'` is unaffected, because "the most recent row" is exactly what it asks for; its
   * freshness is reported separately by `priceAge`.
   *
   * `NO_PRICE` (supported, just never fetched) and `NO_PRICE_SOURCE` (no provider covers it) are
   * distinct because only the latter is permanent and needs a manual override to fix.
   */
  priceAt(instrumentId: string, on: PriceSelector): PriceReadResult {
    const point = on === 'latest' ? this.options.store.latest(instrumentId) : this.options.store.at(instrumentId, on)
    if (point !== null) {
      const instrument = this.options.instruments.get(instrumentId)
      if (instrument !== undefined && point.currency !== instrument.currency) {
        return {
          ok: false,
          error: {
            code: 'PRICE_CURRENCY_MISMATCH',
            expected: instrument.currency,
            got: point.currency,
          },
        }
      }
      if (on !== 'latest' && point.asOf !== on) {
        return {
          ok: false,
          error: {
            code: 'PRICE_NOT_ON_DATE',
            instrumentId,
            requested: on,
            lastKnown: point,
            staleByDays: daysBetween(point.asOf, on),
          },
        }
      }
      return { ok: true, value: point }
    }
    const instrument = this.options.instruments.get(instrumentId)
    if (instrument === undefined || this.providerFor(instrument) === null) {
      return { ok: false, error: { code: 'NO_PRICE_SOURCE', instrumentId } }
    }
    return { ok: false, error: { code: 'NO_PRICE', instrumentId } }
  }

  private inScope(instrument: InstrumentRef, scope: RefreshScope, valuationDate: IsoDate): boolean {
    if (scope.instrumentIds !== undefined && !scope.instrumentIds.includes(instrument.id)) return false
    if (scope.assetClasses !== undefined && !scope.assetClasses.includes(instrument.assetClass)) {
      return false
    }
    if (scope.onlyStale === true) {
      const latest = this.options.store.latest(instrument.id)
      if (latest === null) return true
      const { age } = priceAge({
        point: latest,
        assetClass: instrument.assetClass,
        valuationDate,
      })
      return age.staleness !== 'fresh'
    }
    return true
  }

  /**
   * A refresh is a partial-success operation by construction, mirroring `import_run`: failures are
   * per-instrument and individually re-runnable.
   */
  async refresh(scope: RefreshScope, signal: AbortSignal): Promise<RefreshReport> {
    const startedAt = this.options.now()
    const valuationDate = instantToDate(startedAt)
    const targets = [...this.options.instruments.values()].filter((instrument) =>
      this.inScope(instrument, scope, valuationDate),
    )

    const byProvider = new Map<PriceProvider, InstrumentRef[]>()
    const failures: { instrumentId: string; error: ProviderError }[] = []
    for (const instrument of targets) {
      const provider = this.providerFor(instrument)
      if (provider === null) {
        failures.push({ instrumentId: instrument.id, error: { code: 'NOT_SUPPORTED' } })
        continue
      }
      const bucket = byProvider.get(provider)
      if (bucket === undefined) byProvider.set(provider, [instrument])
      else bucket.push(instrument)
    }

    let updated = 0
    let unchanged = 0
    let creditsConsumed = 0
    let rateLimited = false
    const intradayHeld: string[] = []

    for (const [provider, refs] of byProvider) {
      const perSymbol = provider.capabilities.rateLimit?.creditsPerSymbol ?? 0
      const credits = perSymbol * refs.length
      if (credits > 0 && this.options.budget !== undefined) {
        if (!this.options.budget.consume(credits, valuationDate)) {
          rateLimited = true
          for (const ref of refs) {
            failures.push({ instrumentId: ref.id, error: { code: 'RATE_LIMITED', retryAfterMs: 0 } })
          }
          continue
        }
      }
      creditsConsumed += credits

      const quotes = await provider.fetchLatest(refs, signal)
      for (const quote of quotes) {
        if (!quote.ok) {
          if (quote.error.code === 'RATE_LIMITED') rateLimited = true
          failures.push({ instrumentId: quote.ref.id, error: quote.error })
          continue
        }
        if (quote.intraday) {
          // The session is still open, so this number is a live quote and the row it would go
          // into is a *close*. Writing it would put an 11:00 print in the closing-price column
          // permanently for any user who does not refresh again after the bell — and no later
          // refresh could tell it from a real close in order to correct it. Held rather than
          // written, and named in the report so the absence is visible.
          intradayHeld.push(quote.ref.id)
          continue
        }
        const existing = this.options.store.at(quote.ref.id, quote.asOf)
        const written = this.options.store.put({
          instrumentId: quote.ref.id,
          asOf: quote.asOf,
          close: quote.price.value,
          currency: quote.price.currency,
          source: provider.id,
          fetchedAt: this.options.now(),
        })
        const same =
          existing !== null &&
          existing.asOf === quote.asOf &&
          compareDec(existing.close, quote.price.value) === 0
        if (written && !same) updated += 1
        else unchanged += 1
      }
    }

    return {
      startedAt,
      finishedAt: this.options.now(),
      requested: targets.length,
      updated,
      unchanged,
      failed: failures.length,
      failures,
      creditsConsumed,
      rateLimited,
      intradayHeld,
    }
  }
}

/** Asset classes with no provider in v1, for the settings screen's "no automatic price" list. */
export function unsupportedAssetClasses(
  service: PriceService,
  instruments: readonly InstrumentRef[],
): readonly AssetClass[] {
  const classes = new Set<AssetClass>()
  for (const instrument of instruments) {
    if (service.providerFor(instrument) === null) classes.add(instrument.assetClass)
  }
  return [...classes]
}
