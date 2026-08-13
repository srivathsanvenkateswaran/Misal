/**
 * The refresh orchestrator: the only thing in Misal that reaches the network for a price.
 *
 * Reading a screen never fetches — `buildPriceService` in `portfolio.ts` deliberately registers no
 * provider, so opening the app cannot depend on connectivity or on somebody else's rate limit.
 * This module is the other half of that split: an explicit, user-triggered action that decides what
 * is stale, asks the provider that covers each instrument, and writes back only what came back.
 *
 * Four rules hold everything else up.
 *
 *  1. **A failed fetch never writes a price.** Every provider returns a per-symbol result rather
 *     than throwing, and only `ok: true` results reach the store. Stale-but-real beats
 *     fresh-but-wrong: a three-day-old price that says it is three days old is a number the user
 *     can reason about, and a substituted one is not.
 *
 *  2. **A refusal is reported, not retried.** A 429 from Yahoo or CoinGecko stops the batch and
 *     surfaces as a note the user reads. Retrying into a rate limit is how a keyless client earns
 *     a block that outlasts the session, and the honest answer to "the provider said no" is to say
 *     so.
 *
 *  3. **The TTL is a gate on the whole operation, not per instrument.** `price_cache_ttl_minutes`
 *     is what stops a user clicking Refresh six times from making six rounds of calls. It is
 *     distinct from staleness, which is per asset class and decides *which* instruments are worth
 *     asking about once a refresh is allowed to run at all.
 *
 *  4. **FX is not optional.** The engine refuses to convert without a stored rate, so a missing
 *     `fx_rate` table does not make a US holding unpriced — it makes it *absent* from net worth
 *     entirely. Rates are therefore refreshed alongside prices, from the keyless Yahoo pair feed,
 *     and a failure there is reported at the same volume as a failed price.
 *
 * Nothing here opens a socket. Every request goes through `fetch_market_data`, which is confined
 * to an allowlisted host and path prefix in Rust; the webview's CSP forbids `fetch` outright, and
 * that is the point rather than an inconvenience.
 */

import type { CurrencyCode } from '@domain/numeric'
import {
  AmfiProvider,
  CoinGeckoProvider,
  InMemoryPriceStore,
  PriceService,
  TwelveDataProvider,
  YahooProvider,
  type CreditBudget,
  type FxPair,
  type FxQuoteResult,
  type InstrumentRef,
  type PricePoint,
  type PriceProvider,
  type PriceStore,
  type ProviderError,
  type RefreshReport,
  type RefreshScope,
  type TwelveDataPlan,
} from '@valuation/index'
import { DateTime } from 'luxon'
import type { PortfolioRows } from './client'
import { buildInstruments } from './portfolio'
import type { Invoker } from './import'
import { invoke } from '@tauri-apps/api/core'

const tauriInvoke: Invoker = (command, args) => invoke(command, args)

/** Mirrors the seeded default in migration 0001. */
export const DEFAULT_PRICE_TTL_MINUTES = 360

/** Mirrors `refresh::LAST_REFRESH_KEY`. */
export const LAST_REFRESH_SETTING = 'last_price_refresh_at'

export const PRICE_TTL_SETTING = 'price_cache_ttl_minutes'
export const BASE_CURRENCY_SETTING = 'base_currency'

const IST = 'Asia/Kolkata'

// ---------------------------------------------------------------------------
// The transport seam
// ---------------------------------------------------------------------------

export interface MarketDataResponse {
  readonly status: number
  readonly body: string
}

export interface MarketDataFetcher {
  (url: string, signal: AbortSignal): Promise<MarketDataResponse>
}

/**
 * The one door out of the process for market data.
 *
 * `fetch_market_data` returns status and body and nothing else — no headers, so no `Retry-After`
 * and no cache validators. Providers therefore carry their own fixed stand-down interval, and the
 * absence of a header is not mistaken for permission to retry immediately.
 *
 * The abort signal is checked rather than forwarded: a Tauri command in flight cannot be
 * cancelled, so cancelling a refresh stops the *next* request rather than the current one.
 */
export function marketDataFetcher(call: Invoker = tauriInvoke): MarketDataFetcher {
  return async (url, signal) => {
    if (signal.aborted) throw new Error('refresh cancelled')
    const response = await call<{ status: number; text: string }>('fetch_market_data', {
      request: { url },
    })
    return { status: response.status, body: response.text }
  }
}

/** AMFI's parser takes text and treats a throw as offline, so a bad status must throw here. */
function amfiFetcher(fetcher: MarketDataFetcher): (url: string, signal: AbortSignal) => Promise<string> {
  return async (url, signal) => {
    const response = await fetcher(url, signal)
    if (response.status >= 400) {
      throw new Error(`AMFI returned HTTP ${response.status.toString()}`)
    }
    return response.body
  }
}

// ---------------------------------------------------------------------------
// The store that remembers what it accepted
// ---------------------------------------------------------------------------

/**
 * An in-memory store that keeps a list of the rows it actually took.
 *
 * The alternative — diffing the store before and after — would miss a re-fetch that confirms an
 * existing price, and confirming a price is worth persisting: it moves `fetched_at` forward, which
 * is what tells a user their stale-looking number was checked five minutes ago.
 *
 * Rows refused by manual precedence never reach `accepted`, so the manual-override rule holds even
 * before the Rust write path applies it again against the real table.
 */
export class RecordingPriceStore implements PriceStore {
  private readonly inner = new InMemoryPriceStore()
  private readonly written: PricePoint[] = []

  at(instrumentId: string, on: string): PricePoint | null {
    return this.inner.at(instrumentId, on)
  }
  latest(instrumentId: string): PricePoint | null {
    return this.inner.latest(instrumentId)
  }
  rows(instrumentId: string): readonly PricePoint[] {
    return this.inner.rows(instrumentId)
  }

  put(point: PricePoint): boolean {
    const accepted = this.inner.put(point)
    if (accepted && point.source !== 'manual') this.written.push(point)
    return accepted
  }

  /** Seed a stored row without recording it as something to write back. */
  seed(point: PricePoint): void {
    this.inner.put(point)
  }

  get accepted(): readonly PricePoint[] {
    return this.written
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export type RefreshNoteCode =
  | 'RATE_LIMITED'
  | 'PLAN_RESTRICTED'
  | 'OFFLINE'
  | 'NO_PRICE_SOURCE'
  | 'NOT_FOUND'
  | 'PROVIDER_ERROR'
  | 'AUTH_FAILED'
  | 'MANUAL_OVERRIDE_HELD'
  | 'FX_UNAVAILABLE'
  | 'FX_BASE_UNSUPPORTED'
  | 'UNKNOWN_INSTRUMENT'

export interface RefreshNote {
  readonly code: RefreshNoteCode
  readonly message: string
  /** Everything this note speaks for, so the UI can list them without re-deriving the grouping. */
  readonly subjects: readonly string[]
}

export interface FxOutcome {
  readonly base: CurrencyCode
  readonly quote: 'INR'
  readonly ok: boolean
  readonly rate: string | null
  readonly asOf: string | null
  readonly error: ProviderError | null
}

export type RefreshStatus = 'ran' | 'skipped_by_ttl' | 'skipped_no_targets'

export interface RefreshOutcome {
  readonly status: RefreshStatus
  readonly startedAt: string
  readonly finishedAt: string
  /** Null when nothing was fetched. */
  readonly prices: RefreshReport | null
  readonly pricesWritten: number
  readonly fx: readonly FxOutcome[]
  readonly fxWritten: number
  /** True when any provider refused on rate-limit grounds. Nothing was retried. */
  readonly rateLimited: boolean
  readonly notes: readonly RefreshNote[]
  /** When a TTL-skipped refresh becomes eligible again. */
  readonly nextEligibleAt: string | null
}

/**
 * User-facing wording for a provider failure.
 *
 * Held here rather than in the UI so a new failure mode ships its own sentence in the same diff as
 * the code that raises it, matching how the ingestion subsystem handles its issue codes.
 */
export function describeProviderError(error: ProviderError): {
  code: RefreshNoteCode
  message: string
} {
  switch (error.code) {
    case 'NOT_SUPPORTED':
      return {
        code: 'NO_PRICE_SOURCE',
        message:
          'No price provider covers these. Set a manual price, or add an exchange or ticker alias so a provider can recognise them.',
      }
    case 'NOT_FOUND':
      return {
        code: 'NOT_FOUND',
        message:
          'The provider does not carry these symbols. The alias may be wrong, or the security may have been delisted or renamed.',
      }
    case 'PLAN_RESTRICTED':
      return {
        code: 'PLAN_RESTRICTED',
        message: error.detail === '' ? 'The provider plan does not include these.' : error.detail,
      }
    case 'RATE_LIMITED':
      return {
        code: 'RATE_LIMITED',
        message:
          'The provider is rate limiting us, so the refresh stopped rather than retrying into a longer block. Existing prices are unchanged. Try again in a few minutes.',
      }
    case 'AUTH_FAILED':
      return {
        code: 'AUTH_FAILED',
        message: 'The provider rejected the API key. Check it in settings.',
      }
    case 'OFFLINE':
      return {
        code: 'OFFLINE',
        message: 'Could not reach the provider. Nothing was changed.',
      }
    case 'MALFORMED_RESPONSE':
      return {
        code: 'PROVIDER_ERROR',
        message: `The provider returned something unreadable, so no price was recorded: ${error.detail}`,
      }
    case 'UPSTREAM':
      return {
        code: 'PROVIDER_ERROR',
        message: `The provider answered with HTTP ${error.status.toString()}. No price was recorded.`,
      }
  }
}

/** One note per distinct failure, naming everything it affected. */
function notesFor(
  failures: readonly { readonly instrumentId: string; readonly error: ProviderError }[],
  instruments: ReadonlyMap<string, InstrumentRef>,
): RefreshNote[] {
  const grouped = new Map<string, { note: RefreshNote; subjects: string[] }>()
  for (const failure of failures) {
    const described = describeProviderError(failure.error)
    const key = `${described.code} ${described.message}`
    const name = instruments.get(failure.instrumentId)?.displayName ?? failure.instrumentId
    const existing = grouped.get(key)
    if (existing === undefined) {
      const subjects = [name]
      grouped.set(key, {
        note: { code: described.code, message: described.message, subjects },
        subjects,
      })
    } else {
      existing.subjects.push(name)
    }
  }
  return [...grouped.values()].map((entry) => entry.note)
}

// ---------------------------------------------------------------------------
// Provider assembly
// ---------------------------------------------------------------------------

export interface TwelveDataCredentials {
  readonly apiKey: string
  readonly plan: TwelveDataPlan
}

export interface ProviderSet {
  readonly providers: readonly PriceProvider[]
  /** The first registered provider that serves FX, or null when none does. */
  readonly fx: PriceProvider | null
}

/**
 * Assemble the providers, in resolution order.
 *
 * Order is the whole of the routing logic: `PriceService.providerFor` takes the first provider that
 * claims an instrument, so the narrow, keyless, authoritative sources come first and the broad
 * keyed one is the fallback.
 *
 *   AMFI       — funds only, keyless, official. The one source that is not a scrape.
 *   CoinGecko  — crypto only, keyless, anchored on the alias a human resolved at import.
 *   Yahoo      — NSE, BSE and US equities, keyless, unofficial. The only free NSE/BSE source there
 *                is, which is why it comes before the paid one despite being unsupported.
 *   TwelveData — last, and only with a key. It picks up what Yahoo could not name: a BSE holding
 *                whose only alias is a numeric scrip code, for instance, which Yahoo cannot be
 *                asked about safely.
 */
export function buildProviders(
  fetcher: MarketDataFetcher,
  credentials: TwelveDataCredentials | null,
  sleep?: (ms: number) => Promise<void>,
): ProviderSet {
  const providers: PriceProvider[] = [
    new AmfiProvider(amfiFetcher(fetcher)),
    new CoinGeckoProvider({ fetcher }),
    new YahooProvider(sleep === undefined ? { fetcher } : { fetcher, sleep }),
  ]
  if (credentials !== null) {
    providers.push(
      new TwelveDataProvider({
        apiKey: credentials.apiKey,
        plan: credentials.plan,
        fetcher: async (url, signal) => {
          const response = await fetcher(url, signal)
          return { status: response.status, body: response.body }
        },
      }),
    )
  }
  return { providers, fx: providers.find((p) => p.capabilities.supportsFx) ?? null }
}

// ---------------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------------

export interface RefreshOptions {
  readonly rows: PortfolioRows
  /** Defaults to the real Tauri bridge. */
  readonly call?: Invoker
  readonly fetcher?: MarketDataFetcher
  readonly credentials?: TwelveDataCredentials | null
  readonly now?: () => string
  readonly signal?: AbortSignal
  /** Ignore the TTL. The user asked again, explicitly. */
  readonly force?: boolean
  readonly scope?: RefreshScope
  /**
   * Twelve Data's daily credit ledger, if the caller keeps one. Absent by default: see the note on
   * `refreshPrices` about what that means.
   */
  readonly budget?: CreditBudget
  /** Injected so tests pace without waiting. */
  readonly sleep?: (ms: number) => Promise<void>
}

function settingNumber(settings: ReadonlyMap<string, string>, key: string, fallback: number): number {
  const raw = settings.get(key)
  if (raw === undefined || !/^\d{1,7}$/.test(raw.trim())) return fallback
  // A count of minutes, never a value.
  // eslint-disable-next-line no-restricted-syntax -- a count of minutes, not a monetary value
  return Number.parseInt(raw.trim(), 10)
}

/**
 * How long until the TTL lets another refresh through, or null when one is due now.
 *
 * Exported because the button that triggers a refresh needs the same answer to decide whether to
 * offer itself, and two implementations of "is it time yet" would eventually disagree.
 */
export function ttlGate(
  settings: ReadonlyMap<string, string>,
  now: string,
): { eligible: boolean; nextEligibleAt: string | null } {
  const minutes = settingNumber(settings, PRICE_TTL_SETTING, DEFAULT_PRICE_TTL_MINUTES)
  const last = settings.get(LAST_REFRESH_SETTING)
  if (last === undefined || last === '') return { eligible: true, nextEligibleAt: null }
  const lastAt = DateTime.fromISO(last)
  const nowAt = DateTime.fromISO(now)
  if (!lastAt.isValid || !nowAt.isValid) return { eligible: true, nextEligibleAt: null }
  const next = lastAt.plus({ minutes })
  if (next <= nowAt) return { eligible: true, nextEligibleAt: null }
  return { eligible: false, nextEligibleAt: next.toISO() }
}

/** Currencies held, other than the base. One rate is fetched per distinct foreign currency. */
export function foreignCurrencies(
  instruments: ReadonlyMap<string, InstrumentRef>,
  rows: PortfolioRows,
  base: string,
): readonly CurrencyCode[] {
  const found = new Set<CurrencyCode>()
  for (const instrument of instruments.values()) {
    if (instrument.currency !== base) found.add(instrument.currency)
  }
  for (const account of rows.accounts) {
    // An account's base currency matters even with nothing currently held in it: a cash balance
    // reported in USD needs the same rate as a US equity does.
    if (account.baseCurrency !== base && (account.baseCurrency === 'USD' || account.baseCurrency === 'INR')) {
      found.add(account.baseCurrency)
    }
  }
  return [...found].sort()
}

/**
 * Refresh prices and exchange rates.
 *
 * Partial success is the normal outcome, not the exceptional one: this mirrors `import_run`, where
 * a run completes with some rows failed and each failure is individually re-runnable. A provider
 * that is down for one asset class must not cost the user the other four.
 *
 * **Twelve Data's daily credit budget is not persisted here.** `CreditBudget` needs a store that
 * survives a restart or a user relaunching the app six times burns the quota with no explanation,
 * and there is no setting-write command narrow enough to back one yet. Callers may supply their
 * own; without one, Twelve Data's own 429 is the only backstop, which is reported rather than
 * retried but is a worse place to find out.
 */
export async function refreshPrices(options: RefreshOptions): Promise<RefreshOutcome> {
  const call = options.call ?? tauriInvoke
  const fetcher = options.fetcher ?? marketDataFetcher(call)
  const now = options.now ?? (() => DateTime.now().setZone(IST).toISO() ?? new Date().toISOString())
  const signal = options.signal ?? new AbortController().signal
  const startedAt = now()

  const gate = ttlGate(options.rows.settings, startedAt)
  if (!gate.eligible && options.force !== true) {
    return {
      status: 'skipped_by_ttl',
      startedAt,
      finishedAt: startedAt,
      prices: null,
      pricesWritten: 0,
      fx: [],
      fxWritten: 0,
      rateLimited: false,
      notes: [],
      nextEligibleAt: gate.nextEligibleAt,
    }
  }

  const instruments = buildInstruments(options.rows, options.rows.aliases)
  const store = new RecordingPriceStore()
  for (const price of options.rows.prices) {
    // Seeded so staleness is judged against what is already stored, and so an unchanged re-fetch
    // is recognised as unchanged. Seeding never counts as something to write back.
    store.seed({
      instrumentId: price.instrumentId,
      asOf: price.asOf,
      close: price.close as PricePoint['close'],
      currency: price.currency as PricePoint['currency'],
      source: price.source,
      fetchedAt: price.fetchedAt,
    })
  }

  const service = new PriceService(
    options.budget === undefined
      ? { store, instruments, now }
      : { store, instruments, now, budget: options.budget },
  )
  const { providers, fx } = buildProviders(
    fetcher,
    options.credentials ?? null,
    options.sleep,
  )
  for (const provider of providers) service.register(provider)

  const report = await service.refresh(options.scope ?? { onlyStale: true }, signal)

  const notes: RefreshNote[] = notesFor(report.failures, instruments)

  // Only accepted rows are persisted, and only ok results ever became accepted rows. This is where
  // "a failed fetch never writes a price" stops being a convention and becomes the shape of the
  // data that crosses the boundary.
  let pricesWritten = 0
  if (store.accepted.length > 0) {
    const outcome = await call<{
      written: number
      heldByManual: string[]
      unknown: string[]
    }>('save_prices', {
      rows: store.accepted.map((point) => ({
        instrumentId: point.instrumentId,
        asOf: point.asOf,
        close: point.close,
        currency: point.currency,
        source: point.source,
        fetchedAt: point.fetchedAt,
      })),
    })
    pricesWritten = outcome.written
    if (outcome.heldByManual.length > 0) {
      notes.push({
        code: 'MANUAL_OVERRIDE_HELD',
        message:
          'Your manual prices were kept in preference to the fetched ones for these days. A refresh never overwrites a price you entered.',
        subjects: outcome.heldByManual,
      })
    }
    if (outcome.unknown.length > 0) {
      notes.push({
        code: 'UNKNOWN_INSTRUMENT',
        message:
          'These prices had nowhere to go — the instrument no longer exists. This is a defect in Misal, not in your data.',
        subjects: outcome.unknown,
      })
    }
  }

  const fxResult = await refreshFx({
    call,
    provider: fx,
    instruments,
    rows: options.rows,
    now,
    signal,
    notes,
  })

  const finishedAt = now()
  const rateLimited =
    report.rateLimited || fxResult.outcomes.some((row) => row.error?.code === 'RATE_LIMITED')

  // Stamped even when everything failed. The TTL exists to stop a user hammering a provider that
  // is refusing them, and a failed round trip is exactly the case where that matters most.
  await call('record_price_refresh', { at: finishedAt })

  return {
    status: 'ran',
    startedAt,
    finishedAt,
    prices: report,
    pricesWritten,
    fx: fxResult.outcomes,
    fxWritten: fxResult.written,
    rateLimited,
    notes,
    nextEligibleAt: null,
  }
}

interface FxRefreshInput {
  readonly call: Invoker
  readonly provider: PriceProvider | null
  readonly instruments: ReadonlyMap<string, InstrumentRef>
  readonly rows: PortfolioRows
  readonly now: () => string
  readonly signal: AbortSignal
  readonly notes: RefreshNote[]
}

/**
 * Fetch and store exchange rates for every foreign currency held.
 *
 * Separate from the price pass because the failure means something different. An unpriced holding
 * is visible in the interface and flagged; a holding with no rate cannot be converted at all, so
 * the engine leaves it out of net worth rather than guessing — which is correct behaviour and also
 * completely silent unless something says so. Hence the explicit note.
 */
async function refreshFx(
  input: FxRefreshInput,
): Promise<{ outcomes: FxOutcome[]; written: number }> {
  const base = input.rows.settings.get(BASE_CURRENCY_SETTING) ?? 'INR'
  const needed = foreignCurrencies(input.instruments, input.rows, base)
  if (needed.length === 0) return { outcomes: [], written: 0 }

  if (base !== 'INR') {
    // `FxPair.quote` is 'INR' by construction: the direction convention in `fx.ts` is fixed and a
    // rate stored the other way round turns a ₹50 lakh holding into ₹6,500.
    input.notes.push({
      code: 'FX_BASE_UNSUPPORTED',
      message: `Exchange rates are only fetched against INR, but the base currency is set to ${base}. Foreign holdings will stay out of net worth until that is resolved.`,
      subjects: [...needed],
    })
    return { outcomes: [], written: 0 }
  }

  const provider = input.provider
  const fetchFx = provider?.fetchFx?.bind(provider)
  if (provider === null || fetchFx === undefined) {
    input.notes.push({
      code: 'FX_UNAVAILABLE',
      message:
        'No provider is available for exchange rates, so foreign holdings cannot enter net worth at all — they are left out rather than converted at a guessed rate.',
      subjects: [...needed],
    })
    return { outcomes: [], written: 0 }
  }

  const pairs: FxPair[] = needed.map((currency) => ({ base: currency, quote: 'INR' }))
  let quotes: readonly FxQuoteResult[]
  try {
    quotes = await fetchFx(pairs, 'latest', input.signal)
  } catch {
    quotes = pairs.map((pair) => ({ ok: false, pair, error: { code: 'OFFLINE' } }))
  }

  const outcomes: FxOutcome[] = []
  const toWrite: {
    base: string
    quote: string
    asOf: string
    rate: string
    source: string
  }[] = []

  for (const quote of quotes) {
    if (!quote.ok) {
      outcomes.push({
        base: quote.pair.base,
        quote: quote.pair.quote,
        ok: false,
        rate: null,
        asOf: null,
        error: quote.error,
      })
      const described = describeProviderError(quote.error)
      input.notes.push({
        code: described.code,
        message: `${quote.pair.base}/${quote.pair.quote}: ${described.message} Holdings in ${quote.pair.base} stay out of net worth until a rate is stored.`,
        subjects: [`${quote.pair.base}/${quote.pair.quote}`],
      })
      continue
    }
    outcomes.push({
      base: quote.pair.base,
      quote: quote.pair.quote,
      ok: true,
      rate: quote.rate,
      asOf: quote.asOf,
      error: null,
    })
    toWrite.push({
      base: quote.pair.base,
      quote: quote.pair.quote,
      asOf: quote.asOf,
      rate: quote.rate,
      source: provider.id,
    })
  }

  if (toWrite.length === 0) return { outcomes, written: 0 }

  const saved = await input.call<{ written: number; heldByManual: string[]; unknown: string[] }>(
    'save_fx_rates',
    { rows: toWrite },
  )
  if (saved.heldByManual.length > 0) {
    input.notes.push({
      code: 'MANUAL_OVERRIDE_HELD',
      message: 'Your manual exchange rates were kept in preference to the fetched ones.',
      subjects: saved.heldByManual,
    })
  }
  return { outcomes, written: saved.written }
}
