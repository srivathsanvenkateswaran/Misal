/**
 * Twelve Data — BYOK, US equities, crypto and FX.
 *
 * Free-tier reality, and it is worse than "delayed": the Basic plan covers real-time US equities,
 * forex and crypto only. Indian exchanges are not on it — NSE data is EOD latency on Grow+ and
 * above, with a single free trial symbol. So a free-tier user gets US equities, crypto and FX here,
 * mutual funds from AMFI, and **no automatic prices for Indian equities**; those return
 * `PLAN_RESTRICTED` and land in the manual-override flow.
 *
 * This provider is deliberately thin: the symbol construction, the plan gate and the response
 * parsing — the parts that are easy to get quietly wrong — are implemented and tested; the HTTP
 * call itself is injected so that no test in this subsystem touches a network.
 *
 * **Rate limiting has two halves, and only the second one is a refusal.**
 *
 *  1. *The minute window.* Twelve Data charges one credit **per symbol**, including symbols
 *     batched into a single `/quote` call, and allows eight credits a minute. A twenty-holding
 *     portfolio therefore spends twenty credits in one request and is refused outright — the
 *     burst that "a sync fails with no recovery" describes. The batch is now split into chunks of
 *     at most `perMinute` symbols and the chunks are paced against a sliding sixty-second window,
 *     so the limit is respected rather than discovered. Waiting is self-restraint, not a retry:
 *     nothing has said no yet.
 *
 *  2. *The stand-down.* When the provider does say no — an HTTP 429, or a `code: 429` inside a
 *     200 body — every further request in the run is refused locally, without a call, until the
 *     stand-down elapses, and the interval doubles with each refusal. Retrying into a refusal is
 *     how a key earns a block that outlasts the session, so the refusal is respected and reported.
 *     This mirrors the rule the Yahoo provider states for its own 429.
 *
 * The window lives on the provider instance, which lives for one refresh. Across refreshes the
 * TTL gate in `refresh.ts` is what stands between the user and the provider; a minute window that
 * survived a restart would need the same persistent store the daily budget is still waiting for.
 */

import { type Dec, dec } from '@domain/numeric'
import { z } from 'zod'
import type { AliasRef, InstrumentRef, IsoDate } from '../types'
import type {
  FxPair,
  FxQuoteResult,
  HistoricalClose,
  HistoricalFxRate,
  PriceProvider,
  ProviderCapabilities,
  PriceSelector,
  ProviderError,
  ProviderResult,
  QuoteResult,
} from './types'

export const TWELVE_DATA_BASE = 'https://api.twelvedata.com'

export type TwelveDataPlan = 'basic' | 'paid'

export interface TwelveDataFetcher {
  (url: string, signal: AbortSignal): Promise<{ status: number; body: string }>
}

/** The span the per-minute allowance is counted over. */
export const TWELVE_DATA_WINDOW_MS = 60_000

/**
 * How long to stand down after the provider refuses, and the ceiling the doubling stops at.
 *
 * `fetch_market_data` returns status and body only, so a `Retry-After` header never reaches us.
 * A minute is the shortest interval unambiguously longer than the window that was breached.
 */
export const TWELVE_DATA_STAND_DOWN_MS = 60_000
export const TWELVE_DATA_MAX_STAND_DOWN_MS = 480_000

/**
 * The longest this provider will pace itself before giving up and reporting instead.
 *
 * A refresh is something a user is watching. Waiting out one window to place the next chunk is
 * worth it; waiting several is not, and saying "the provider is rate limiting us" is the better
 * answer than a progress indicator that appears to have hung.
 */
export const TWELVE_DATA_MAX_PACING_WAIT_MS = 60_000

/**
 * A sliding window over credits spent, in the provider's own accounting unit.
 *
 * Deliberately not a token bucket: Twelve Data's limit is "no more than N in any sixty seconds",
 * and a bucket that refills smoothly would let a burst of N/2 land twice inside one window. Every
 * spend is kept with the instant it happened and expires exactly `windowMs` later.
 *
 * Every number here is a count of credits or of milliseconds. Nothing in it is money.
 */
export class MinuteWindow {
  private readonly spent: { at: number; credits: number }[] = []

  constructor(
    private readonly perMinute: number,
    private readonly windowMs: number = TWELVE_DATA_WINDOW_MS,
  ) {}

  /**
   * Milliseconds to wait before `credits` more may be spent, or 0 when there is room now.
   *
   * Returns `Infinity`-free arithmetic: a request larger than the whole allowance can never fit,
   * and is reported as the wait until the window is empty so the caller refuses it rather than
   * sleeping forever.
   */
  waitFor(credits: number, now: number): number {
    this.expire(now)
    let used = 0
    for (const entry of this.spent) used += entry.credits
    if (used + credits <= this.perMinute) return 0
    let released = 0
    for (const entry of this.spent) {
      released += entry.credits
      if (used - released + credits <= this.perMinute) return entry.at + this.windowMs - now
    }
    // Larger than the entire allowance. The wait until everything has expired is the most honest
    // number available, and the caller turns it into a refusal rather than a sleep.
    const oldest = this.spent[this.spent.length - 1]
    return oldest === undefined ? 0 : oldest.at + this.windowMs - now
  }

  record(credits: number, now: number): void {
    this.expire(now)
    this.spent.push({ at: now, credits })
  }

  private expire(now: number): void {
    while (this.spent.length > 0 && (this.spent[0]?.at ?? 0) + this.windowMs <= now) {
      this.spent.shift()
    }
  }
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const CAPABILITIES: ProviderCapabilities = {
  assetClasses: ['us_equity', 'crypto', 'indian_equity'],
  requiresApiKey: true,
  latency: 'delayed',
  supportsHistory: true,
  supportsFx: true,
  // 8 credits/minute is the binding constraint; 800/day is ample for a personal portfolio.
  rateLimit: { perMinute: 8, perDay: 800, creditsPerSymbol: 1 },
}

function alias(instrument: InstrumentRef, scheme: AliasRef['scheme']): string | null {
  return instrument.aliases.find((a) => a.scheme === scheme)?.value ?? null
}

/**
 * Symbols carry an exchange suffix and are built from `instrument_alias`, never from
 * `display_name` — E*TRADE's INFY (the US ADR) and Zerodha's INFY (the NSE line) are different
 * instruments and only the alias tells them apart.
 */
export function symbolFor(instrument: InstrumentRef): string | null {
  switch (instrument.assetClass) {
    case 'indian_equity': {
      const nse = alias(instrument, 'nse')
      if (nse !== null) return `${nse}:NSE`
      const bse = alias(instrument, 'bse')
      return bse === null ? null : `${bse}:BSE`
    }
    case 'us_equity':
      return alias(instrument, 'ticker')
    case 'crypto': {
      const ticker = alias(instrument, 'ticker') ?? alias(instrument, 'coingecko')
      return ticker === null ? null : `${ticker.toUpperCase()}/USD`
    }
    case 'mutual_fund':
    case 'gold':
    case 'bond':
    case 'cash':
      // AMFI covers funds; the rest have no Twelve Data symbol and fall to a manual price.
      return null
  }
}

const quoteEntrySchema = z.object({
  symbol: z.string().optional(),
  close: z.string().optional(),
  previous_close: z.string().optional(),
  datetime: z.string().optional(),
  status: z.string().optional(),
  code: z.number().optional(),
  message: z.string().optional(),
  /**
   * Twelve Data states the session for us, which Yahoo does not.
   *
   * When it is true, `close` is the last trade rather than the day's closing price, and `datetime`
   * is today — the same trap `yahoo.ts` documents at length, arriving here with a flag on it.
   * Absent is read as closed, matching the conservative direction taken there.
   */
  is_market_open: z.boolean().optional(),
})

const envelopeSchema = z.record(z.string(), z.unknown())

export type QuoteEntry = z.infer<typeof quoteEntrySchema>

const SINGLE_QUOTE_KEYS = ['close', 'symbol', 'status', 'code']

/**
 * A batch response may carry per-symbol errors inside a 200 body, so each entry's `status` is
 * inspected rather than only the HTTP status.
 *
 * The single-symbol and batch shapes are told apart by looking for quote fields at the top level.
 * A schema union cannot do it: every field of a quote is optional, so the batch object validates as
 * a single quote with nothing in it and every symbol is silently lost.
 */
export function parseQuoteBody(body: string): ReadonlyMap<string, QuoteEntry> | null {
  let raw: unknown
  try {
    raw = JSON.parse(body) as unknown
  } catch {
    return null
  }
  const envelope = envelopeSchema.safeParse(raw)
  if (!envelope.success) return null
  const entries = new Map<string, QuoteEntry>()

  if (SINGLE_QUOTE_KEYS.some((key) => key in envelope.data)) {
    const single = quoteEntrySchema.safeParse(envelope.data)
    if (!single.success) return null
    if (single.data.symbol !== undefined) entries.set(single.data.symbol, single.data)
    return entries
  }

  for (const [symbol, value] of Object.entries(envelope.data)) {
    const entry = quoteEntrySchema.safeParse(value)
    if (entry.success) entries.set(symbol, entry.data)
  }
  return entries
}

function entryError(entry: QuoteEntry): ProviderError | null {
  if (entry.status !== 'error') return null
  if (entry.code === 403) return { code: 'PLAN_RESTRICTED', detail: entry.message ?? '' }
  if (entry.code === 404) return { code: 'NOT_FOUND' }
  if (entry.code === 429) return { code: 'RATE_LIMITED', retryAfterMs: 60_000 }
  if (entry.code === 401) return { code: 'AUTH_FAILED' }
  return { code: 'UPSTREAM', status: entry.code ?? 0 }
}

export interface TwelveDataOptions {
  readonly apiKey: string | null
  readonly plan: TwelveDataPlan
  readonly fetcher: TwelveDataFetcher
  /** Injected so tests pace without waiting. */
  readonly sleep?: (ms: number) => Promise<void>
  /** Epoch milliseconds. A count, injected so the sliding window is testable without a timer. */
  readonly now?: () => number
}

export class TwelveDataProvider implements PriceProvider {
  readonly id = 'twelvedata' as const
  readonly capabilities = CAPABILITIES

  private readonly window: MinuteWindow
  private readonly sleep: (ms: number) => Promise<void>
  private readonly clock: () => number
  /** Epoch ms until which the provider has said no. Nothing is asked before it passes. */
  private standDownUntil = 0
  private standDownMs = TWELVE_DATA_STAND_DOWN_MS

  constructor(private readonly options: TwelveDataOptions) {
    this.window = new MinuteWindow(CAPABILITIES.rateLimit?.perMinute ?? 8)
    this.sleep = options.sleep ?? realSleep
    this.clock = options.now ?? (() => Date.now())
  }

  supports(instrument: InstrumentRef): boolean {
    return symbolFor(instrument) !== null
  }

  /**
   * Take `credits` from the minute window, waiting if that is what it costs.
   *
   * Returns an error only when nothing should be asked at all: either the provider has refused
   * and the stand-down has not elapsed, or the wait would be longer than a user should be made to
   * watch. A zero-length wait is the normal case and costs nothing.
   */
  private async reserve(credits: number): Promise<ProviderError | null> {
    const now = this.clock()
    if (now < this.standDownUntil) {
      return { code: 'RATE_LIMITED', retryAfterMs: this.standDownUntil - now }
    }
    const wait = this.window.waitFor(credits, now)
    if (wait > TWELVE_DATA_MAX_PACING_WAIT_MS) {
      return { code: 'RATE_LIMITED', retryAfterMs: wait }
    }
    if (wait > 0) await this.sleep(wait)
    this.window.record(credits, this.clock())
    return null
  }

  /**
   * Record a refusal and say how long to stand down for.
   *
   * The interval doubles each time, because a provider that refuses twice is telling us the first
   * interval was not long enough. Nothing retries inside it: the refusal is the answer.
   */
  private refused(): ProviderError {
    const wait = this.standDownMs
    this.standDownUntil = this.clock() + wait
    const doubled = wait * 2
    this.standDownMs =
      doubled > TWELVE_DATA_MAX_STAND_DOWN_MS ? TWELVE_DATA_MAX_STAND_DOWN_MS : doubled
    return { code: 'RATE_LIMITED', retryAfterMs: wait }
  }

  /**
   * The plan gate is applied before the request, not after: asking a Basic key for an NSE quote
   * spends a credit to be told no, and the settings screen has already told the user this will
   * happen.
   */
  private gate(instrument: InstrumentRef): ProviderError | null {
    if (this.options.apiKey === null) return { code: 'AUTH_FAILED' }
    if (instrument.assetClass === 'indian_equity' && this.options.plan === 'basic') {
      return {
        code: 'PLAN_RESTRICTED',
        detail:
          'Indian exchange data is not included on the Twelve Data Basic plan. Set a manual price for this instrument, or upgrade the plan.',
      }
    }
    return null
  }

  async fetchLatest(
    refs: readonly InstrumentRef[],
    signal: AbortSignal,
  ): Promise<readonly QuoteResult[]> {
    const results: QuoteResult[] = []
    const wanted: { ref: InstrumentRef; symbol: string }[] = []
    for (const ref of refs) {
      const symbol = symbolFor(ref)
      if (symbol === null) {
        results.push({ ok: false, ref, error: { code: 'NOT_SUPPORTED' } })
        continue
      }
      const gated = this.gate(ref)
      if (gated !== null) {
        results.push({ ok: false, ref, error: gated })
        continue
      }
      wanted.push({ ref, symbol })
    }
    if (wanted.length === 0) return results

    // One credit per symbol, batched or not, so the batch is split to the size the allowance can
    // actually carry. A single twenty-symbol request is what trips the limit; four chunks of
    // five, paced, do not.
    const perChunk = CAPABILITIES.rateLimit?.perMinute ?? wanted.length
    let halted: ProviderError | null = null
    for (let index = 0; index < wanted.length; index += perChunk) {
      const chunk = wanted.slice(index, index + perChunk)
      if (halted !== null) {
        // Refused once already. Every further request buys nothing and lengthens the block.
        for (const { ref } of chunk) results.push({ ok: false, ref, error: halted })
        continue
      }

      const blocked = await this.reserve(chunk.length)
      if (blocked !== null) {
        halted = blocked
        for (const { ref } of chunk) results.push({ ok: false, ref, error: blocked })
        continue
      }

      const symbols = chunk.map((w) => w.symbol).join(',')
      const url = `${TWELVE_DATA_BASE}/quote?symbol=${encodeURIComponent(symbols)}&apikey=${encodeURIComponent(this.options.apiKey ?? '')}`
      let response: { status: number; body: string }
      try {
        response = await this.options.fetcher(url, signal)
      } catch {
        // Offline halts the rest: forty more attempts against a dead socket only lengthen the
        // wait before the user is told the one thing that matters.
        halted = { code: 'OFFLINE' }
        for (const { ref } of chunk) results.push({ ok: false, ref, error: { code: 'OFFLINE' } })
        continue
      }

      if (response.status === 429) {
        halted = this.refused()
        for (const { ref } of chunk) results.push({ ok: false, ref, error: halted })
        continue
      }

      const entries = parseQuoteBody(response.body)
      if (entries === null) {
        for (const { ref } of chunk) {
          results.push({
            ok: false,
            ref,
            error: { code: 'MALFORMED_RESPONSE', detail: 'unrecognised quote payload' },
          })
        }
        continue
      }

      for (const { ref, symbol } of chunk) {
        const entry = entries.get(symbol)
        if (entry === undefined) {
          results.push({ ok: false, ref, error: { code: 'NOT_FOUND' } })
          continue
        }
        const failure = entryError(entry)
        if (failure !== null) {
          // A 429 inside a 200 body is still a refusal, and stands the rest of the run down.
          if (failure.code === 'RATE_LIMITED') halted = this.refused()
          results.push({ ok: false, ref, error: halted ?? failure })
          continue
        }
        const close = entry.close
        const asOf = entry.datetime
        if (close === undefined || asOf === undefined) {
          results.push({
            ok: false,
            ref,
            error: { code: 'MALFORMED_RESPONSE', detail: `no close for ${symbol}` },
          })
          continue
        }
        results.push({
          ok: true,
          ref,
          price: { value: dec(close), currency: ref.currency },
          asOf: asOf.slice(0, 10),
          previousClose:
            entry.previous_close === undefined
              ? null
              : { value: dec(entry.previous_close), currency: ref.currency },
          // Twelve Data says so outright, so there is nothing to infer.
          intraday: entry.is_market_open === true,
        })
      }
    }
    return results
  }

  async fetchHistory(
    ref: InstrumentRef,
    from: IsoDate,
    to: IsoDate,
    signal: AbortSignal,
  ): Promise<ProviderResult<readonly HistoricalClose[]>> {
    const symbol = symbolFor(ref)
    if (symbol === null) return { ok: false, error: { code: 'NOT_SUPPORTED' } }
    const gated = this.gate(ref)
    if (gated !== null) return { ok: false, error: gated }
    const blocked = await this.reserve(CAPABILITIES.rateLimit?.creditsPerSymbol ?? 1)
    if (blocked !== null) return { ok: false, error: blocked }
    const url = `${TWELVE_DATA_BASE}/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&start_date=${from}&end_date=${to}&apikey=${encodeURIComponent(this.options.apiKey ?? '')}`
    let response: { status: number; body: string }
    try {
      response = await this.options.fetcher(url, signal)
    } catch {
      return { ok: false, error: { code: 'OFFLINE' } }
    }
    if (response.status === 429) return { ok: false, error: this.refused() }
    const parsed = timeSeriesSchema.safeParse(parseJson(response.body))
    if (!parsed.success) {
      return { ok: false, error: { code: 'MALFORMED_RESPONSE', detail: 'unrecognised time series' } }
    }
    if (parsed.data.status === 'error') {
      if (parsed.data.code === 429) return { ok: false, error: this.refused() }
      return { ok: false, error: { code: 'UPSTREAM', status: response.status } }
    }
    const closes = (parsed.data.values ?? []).map<HistoricalClose>((value) => ({
      asOf: value.datetime.slice(0, 10),
      close: dec(value.close),
      currency: ref.currency,
    }))
    return { ok: true, value: [...closes].sort((a, b) => (a.asOf < b.asOf ? -1 : 1)) }
  }

  /**
   * Dated exchange rates over a range, from the same `time_series` endpoint the price history
   * uses — `USD/INR` is a symbol there like any other.
   *
   * Registered after Yahoo in `buildProviders`, so in practice the keyless provider answers this
   * first. It exists here so a user who has a key is not worse served than one who has none.
   */
  async fetchFxHistory(
    pair: FxPair,
    from: IsoDate,
    to: IsoDate,
    signal: AbortSignal,
  ): Promise<ProviderResult<readonly HistoricalFxRate[]>> {
    if (this.options.apiKey === null) return { ok: false, error: { code: 'AUTH_FAILED' } }
    const blocked = await this.reserve(CAPABILITIES.rateLimit?.creditsPerSymbol ?? 1)
    if (blocked !== null) return { ok: false, error: blocked }
    const url = `${TWELVE_DATA_BASE}/time_series?symbol=${encodeURIComponent(`${pair.base}/${pair.quote}`)}&interval=1day&start_date=${from}&end_date=${to}&apikey=${encodeURIComponent(this.options.apiKey)}`
    let response: { status: number; body: string }
    try {
      response = await this.options.fetcher(url, signal)
    } catch {
      return { ok: false, error: { code: 'OFFLINE' } }
    }
    if (response.status === 429) return { ok: false, error: this.refused() }
    const parsed = timeSeriesSchema.safeParse(parseJson(response.body))
    if (!parsed.success) {
      return { ok: false, error: { code: 'MALFORMED_RESPONSE', detail: 'unrecognised time series' } }
    }
    if (parsed.data.status === 'error') {
      if (parsed.data.code === 429) return { ok: false, error: this.refused() }
      return { ok: false, error: { code: 'UPSTREAM', status: response.status } }
    }
    const rates = (parsed.data.values ?? []).map<HistoricalFxRate>((value) => ({
      asOf: value.datetime.slice(0, 10),
      rate: dec(value.close),
    }))
    return { ok: true, value: [...rates].sort((a, b) => (a.asOf < b.asOf ? -1 : 1)) }
  }

  async fetchFx(
    pairs: readonly FxPair[],
    on: PriceSelector,
    signal: AbortSignal,
  ): Promise<readonly FxQuoteResult[]> {
    const results: FxQuoteResult[] = []
    let halted: ProviderError | null = null
    for (const pair of pairs) {
      if (this.options.apiKey === null) {
        results.push({ ok: false, pair, error: { code: 'AUTH_FAILED' } })
        continue
      }
      if (halted !== null) {
        results.push({ ok: false, pair, error: halted })
        continue
      }
      const blocked = await this.reserve(CAPABILITIES.rateLimit?.creditsPerSymbol ?? 1)
      if (blocked !== null) {
        halted = blocked
        results.push({ ok: false, pair, error: blocked })
        continue
      }
      const url = `${TWELVE_DATA_BASE}/exchange_rate?symbol=${pair.base}/${pair.quote}&apikey=${encodeURIComponent(this.options.apiKey)}`
      try {
        const response = await this.options.fetcher(url, signal)
        if (response.status === 429) {
          halted = this.refused()
          results.push({ ok: false, pair, error: halted })
          continue
        }
        const parsed = exchangeRateSchema.safeParse(parseJson(response.body))
        if (!parsed.success || parsed.data.rate === undefined) {
          results.push({
            ok: false,
            pair,
            error: { code: 'MALFORMED_RESPONSE', detail: 'no rate in payload' },
          })
          continue
        }
        results.push({
          ok: true,
          pair,
          rate: toRate(parsed.data.rate),
          asOf: on === 'latest' ? (parsed.data.timestamp ?? '').slice(0, 10) : on,
        })
      } catch {
        results.push({ ok: false, pair, error: { code: 'OFFLINE' } })
      }
    }
    return results
  }
}

const timeSeriesSchema = z.object({
  status: z.string().optional(),
  code: z.number().optional(),
  values: z.array(z.object({ datetime: z.string(), close: z.string() })).optional(),
})

/**
 * `JSON.parse` that answers `null` instead of throwing.
 *
 * A 429 or an edge block returns HTML, and the previous code parsed the time-series body outside
 * its own try block: an unreadable payload escaped as an exception through a method whose contract
 * is to return a result. It reached `refresh.ts`, whose `try` around the FX call would have turned
 * it into a blanket OFFLINE for every pair.
 */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch {
    return null
  }
}

const exchangeRateSchema = z.object({
  rate: z.union([z.string(), z.number()]).optional(),
  timestamp: z.string().optional(),
})

/**
 * Twelve Data sometimes serialises the rate as a JSON number, which is a double and has already
 * lost whatever it was going to lose by the time we see it. It is stringified without arithmetic
 * so nothing further is lost, and the loss is the provider's, not ours.
 */
function toRate(raw: string | number): Dec {
  return dec(typeof raw === 'string' ? raw : raw.toString())
}
