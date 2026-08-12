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
 */

import { type Dec, dec } from '@domain/numeric'
import { z } from 'zod'
import type { AliasRef, InstrumentRef, IsoDate } from '../types'
import type {
  FxPair,
  FxQuoteResult,
  HistoricalClose,
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
}

export class TwelveDataProvider implements PriceProvider {
  readonly id = 'twelvedata' as const
  readonly capabilities = CAPABILITIES

  constructor(private readonly options: TwelveDataOptions) {}

  supports(instrument: InstrumentRef): boolean {
    return symbolFor(instrument) !== null
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

    const symbols = wanted.map((w) => w.symbol).join(',')
    const url = `${TWELVE_DATA_BASE}/quote?symbol=${encodeURIComponent(symbols)}&apikey=${encodeURIComponent(this.options.apiKey ?? '')}`
    let response: { status: number; body: string }
    try {
      response = await this.options.fetcher(url, signal)
    } catch {
      return [
        ...results,
        ...wanted.map<QuoteResult>(({ ref }) => ({ ok: false, ref, error: { code: 'OFFLINE' } })),
      ]
    }

    if (response.status === 429) {
      return [
        ...results,
        ...wanted.map<QuoteResult>(({ ref }) => ({
          ok: false,
          ref,
          error: { code: 'RATE_LIMITED', retryAfterMs: 60_000 },
        })),
      ]
    }

    const entries = parseQuoteBody(response.body)
    if (entries === null) {
      return [
        ...results,
        ...wanted.map<QuoteResult>(({ ref }) => ({
          ok: false,
          ref,
          error: { code: 'MALFORMED_RESPONSE', detail: 'unrecognised quote payload' },
        })),
      ]
    }

    for (const { ref, symbol } of wanted) {
      const entry = entries.get(symbol)
      if (entry === undefined) {
        results.push({ ok: false, ref, error: { code: 'NOT_FOUND' } })
        continue
      }
      const failure = entryError(entry)
      if (failure !== null) {
        results.push({ ok: false, ref, error: failure })
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
      })
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
    const url = `${TWELVE_DATA_BASE}/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&start_date=${from}&end_date=${to}&apikey=${encodeURIComponent(this.options.apiKey ?? '')}`
    let response: { status: number; body: string }
    try {
      response = await this.options.fetcher(url, signal)
    } catch {
      return { ok: false, error: { code: 'OFFLINE' } }
    }
    const parsed = timeSeriesSchema.safeParse(JSON.parse(response.body) as unknown)
    if (!parsed.success) {
      return { ok: false, error: { code: 'MALFORMED_RESPONSE', detail: 'unrecognised time series' } }
    }
    if (parsed.data.status === 'error') {
      return { ok: false, error: { code: 'UPSTREAM', status: response.status } }
    }
    const closes = (parsed.data.values ?? []).map<HistoricalClose>((value) => ({
      asOf: value.datetime.slice(0, 10),
      close: dec(value.close),
      currency: ref.currency,
    }))
    return { ok: true, value: [...closes].sort((a, b) => (a.asOf < b.asOf ? -1 : 1)) }
  }

  async fetchFx(
    pairs: readonly FxPair[],
    on: PriceSelector,
    signal: AbortSignal,
  ): Promise<readonly FxQuoteResult[]> {
    const results: FxQuoteResult[] = []
    for (const pair of pairs) {
      if (this.options.apiKey === null) {
        results.push({ ok: false, pair, error: { code: 'AUTH_FAILED' } })
        continue
      }
      const url = `${TWELVE_DATA_BASE}/exchange_rate?symbol=${pair.base}/${pair.quote}&apikey=${encodeURIComponent(this.options.apiKey)}`
      try {
        const response = await this.options.fetcher(url, signal)
        const parsed = exchangeRateSchema.safeParse(JSON.parse(response.body) as unknown)
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
  values: z.array(z.object({ datetime: z.string(), close: z.string() })).optional(),
})

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
