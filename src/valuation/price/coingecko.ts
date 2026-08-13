/**
 * CoinGecko — crypto spot prices, keyless.
 *
 * Anchored on the `coingecko` alias and nothing else. A ticker is not an identifier in crypto:
 * CoinGecko's own catalogue carries many unrelated assets sharing a `symbol`, and the resolution
 * catalogue (`src/adapters/resolution/catalogue.ts`) exists precisely so that a human, not a
 * string match, decides that an exchange's BTC is CoinGecko's `bitcoin`. Pricing must use the same
 * anchor, or a holding resolved carefully at import gets valued against the wrong coin.
 *
 * Two properties of `/simple/price` shape everything here:
 *
 *  1. **An unknown id is not an error.** `?ids=bitcoin,not-a-real-coin` returns HTTP 200 with only
 *     `bitcoin` in the body — no error field, no null entry, nothing. So the response is read by
 *     asking for each id that was requested rather than by iterating what came back; an id whose
 *     key is absent is `NOT_FOUND`, and never a silently missing row that leaves a stale price
 *     looking fresh.
 *
 *  2. **Prices arrive as JSON numbers** (`6061005.018552231`), so the body is read losslessly and
 *     the literal digits are what get stored. `precision=full` is requested because the default
 *     rounds to a handful of significant figures, which for a coin priced at 1e-8 is the whole
 *     number.
 *
 * The whole batch is one request, which is why there is no credit budget here: the cost of a
 * refresh is one call regardless of how many coins are held. What has to be respected instead is
 * the public plan's few-calls-a-minute ceiling, and a 429 is reported rather than retried.
 */

import { type Dec } from '@domain/numeric'
import { decFromRaw } from '@adapters/decimal-text'
import { field, isJsonArray, isJsonObject, isRawNumber, parseLossless, type Json } from '@adapters/lossless-json'
import { DateTime } from 'luxon'
import type { InstrumentRef, IsoDate } from '../types'
import type {
  HistoricalClose,
  PriceProvider,
  ProviderCapabilities,
  ProviderError,
  ProviderResult,
  QuoteResult,
} from './types'

export const COINGECKO_BASE = 'https://api.coingecko.com/api/v3'

/**
 * The public plan is documented at 5–15 calls per minute, varying with global load. A minute is
 * the smallest stand-down that is certainly outside that window.
 */
export const COINGECKO_RETRY_AFTER_MS = 60_000

/** CoinGecko ids are lowercase slugs. Validated because they are user data reaching a query string. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * The base currency's calendar.
 *
 * Crypto never closes, so there is no exchange session to date a price by and the choice is
 * arbitrary unless it is anchored to something. It is anchored to IST — the calendar the
 * valuation date and the staleness thresholds already run on — so that a price fetched at 03:00
 * on a Tuesday in Mumbai is dated Tuesday rather than looking a day old the moment it lands.
 */
const IST = 'Asia/Kolkata'

export interface CoinGeckoFetcher {
  (url: string, signal: AbortSignal): Promise<{ status: number; body: string }>
}

export interface CoinGeckoOptions {
  readonly fetcher: CoinGeckoFetcher
}

const CAPABILITIES: ProviderCapabilities = {
  assetClasses: ['crypto'],
  requiresApiKey: false,
  latency: 'realtime',
  supportsHistory: true,
  // /exchange_rates is denominated in BTC, which is not a fiat pair and cannot answer USD/INR.
  supportsFx: false,
  // One request covers the whole book, so a per-symbol credit model would describe a cost that
  // does not exist. The ceiling that does exist is per-minute, and it is respected by batching and
  // by refusing to retry a refusal.
  rateLimit: null,
}

/** The CoinGecko id for an instrument, or null when it was never resolved to one. */
export function coinIdFor(instrument: InstrumentRef): string | null {
  if (instrument.assetClass !== 'crypto') return null
  const raw = instrument.aliases.find((a) => a.scheme === 'coingecko')?.value ?? null
  if (raw === null) return null
  const id = raw.trim().toLowerCase()
  return ID_PATTERN.test(id) ? id : null
}

function rawText(value: Json | undefined): string | null {
  if (typeof value === 'string') return value
  if (isRawNumber(value)) return value.raw
  return null
}

function decOf(value: Json | undefined): Dec | null {
  const raw = rawText(value)
  if (raw === null) return null
  try {
    return decFromRaw(raw)
  } catch {
    return null
  }
}

/**
 * Transport-level verdicts.
 *
 * A 429 stops the refresh and is reported. CoinGecko's guidance for a rate-limited public client
 * is to back off, and a desktop app that answers a refusal with an immediate retry is how a user's
 * IP ends up on the wrong side of Cloudflare.
 */
function statusError(status: number): ProviderError | null {
  if (status === 429) return { code: 'RATE_LIMITED', retryAfterMs: COINGECKO_RETRY_AFTER_MS }
  if (status === 401 || status === 403) return { code: 'UPSTREAM', status }
  if (status >= 400) return { code: 'UPSTREAM', status }
  return null
}

export interface SimplePriceEntry {
  readonly price: Dec
  readonly asOf: IsoDate | null
}

export type CoinGeckoResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProviderError }

/**
 * Parse a `/simple/price` body into `(id, vsCurrency) -> entry`.
 *
 * Keyed by the pair rather than by the id, because one request can carry several vs-currencies and
 * an INR instrument must never be handed the USD figure sitting next to it in the same object.
 */
export function parseSimplePrice(
  body: string,
  status: number,
): CoinGeckoResult<ReadonlyMap<string, SimplePriceEntry>> {
  const failed = statusError(status)
  if (failed !== null) return { ok: false, error: failed }

  let parsed: Json
  try {
    parsed = parseLossless(body)
  } catch {
    return { ok: false, error: { code: 'MALFORMED_RESPONSE', detail: 'response was not JSON' } }
  }
  if (!isJsonObject(parsed)) {
    return { ok: false, error: { code: 'MALFORMED_RESPONSE', detail: 'body is not an object' } }
  }

  const out = new Map<string, SimplePriceEntry>()
  for (const [id, quoted] of Object.entries(parsed)) {
    if (!isJsonObject(quoted)) continue
    const updated = rawText(field(quoted, 'last_updated_at'))
    const asOf = updated === null ? null : dateAt(updated)
    for (const [vs, value] of Object.entries(quoted)) {
      if (vs === 'last_updated_at') continue
      const price = decOf(value)
      if (price === null) continue
      out.set(`${id}/${vs}`, { price, asOf })
    }
  }
  return { ok: true, value: out }
}

function dateAt(epochSeconds: string): IsoDate | null {
  // A count of seconds, never a value. The same exemption `calendar.ts` takes for day counts.
  if (!/^\d{1,15}$/.test(epochSeconds)) return null
  // eslint-disable-next-line no-restricted-syntax -- epoch seconds, not a monetary value
  const at = DateTime.fromSeconds(Number.parseInt(epochSeconds, 10), { zone: IST })
  return at.isValid ? at.toISODate() : null
}

function millisAt(epochMillis: string): IsoDate | null {
  if (!/^\d{1,17}$/.test(epochMillis)) return null
  // eslint-disable-next-line no-restricted-syntax -- epoch millis, not a monetary value
  const at = DateTime.fromMillis(Number.parseInt(epochMillis, 10), { zone: IST })
  return at.isValid ? at.toISODate() : null
}

export class CoinGeckoProvider implements PriceProvider {
  readonly id = 'coingecko' as const
  readonly capabilities = CAPABILITIES

  constructor(private readonly options: CoinGeckoOptions) {}

  supports(instrument: InstrumentRef): boolean {
    return coinIdFor(instrument) !== null
  }

  /**
   * One request for the whole batch.
   *
   * `asOf` falls back to the caller's `today` only when CoinGecko omits `last_updated_at`, which
   * it does for some assets. That is the one substitution in this file and it is a date, not a
   * price: a price is never invented, and a price with no date at all could not be stored.
   */
  async fetchLatest(
    refs: readonly InstrumentRef[],
    signal: AbortSignal,
  ): Promise<readonly QuoteResult[]> {
    const results: QuoteResult[] = []
    const wanted: { ref: InstrumentRef; id: string }[] = []
    for (const ref of refs) {
      const id = coinIdFor(ref)
      if (id === null) results.push({ ok: false, ref, error: { code: 'NOT_SUPPORTED' } })
      else wanted.push({ ref, id })
    }
    if (wanted.length === 0) return results

    const ids = [...new Set(wanted.map((w) => w.id))].sort()
    const currencies = [...new Set(wanted.map((w) => w.ref.currency.toLowerCase()))].sort()
    const url =
      `${COINGECKO_BASE}/simple/price?ids=${encodeURIComponent(ids.join(','))}` +
      `&vs_currencies=${encodeURIComponent(currencies.join(','))}` +
      `&include_last_updated_at=true&precision=full`

    if (signal.aborted) {
      return [
        ...results,
        ...wanted.map<QuoteResult>(({ ref }) => ({ ok: false, ref, error: { code: 'OFFLINE' } })),
      ]
    }

    let response: { status: number; body: string }
    try {
      response = await this.options.fetcher(url, signal)
    } catch {
      return [
        ...results,
        ...wanted.map<QuoteResult>(({ ref }) => ({ ok: false, ref, error: { code: 'OFFLINE' } })),
      ]
    }

    const parsed = parseSimplePrice(response.body, response.status)
    if (!parsed.ok) {
      return [
        ...results,
        ...wanted.map<QuoteResult>(({ ref }) => ({ ok: false, ref, error: parsed.error })),
      ]
    }

    const today = DateTime.now().setZone(IST).toISODate()
    for (const { ref, id } of wanted) {
      const entry = parsed.value.get(`${id}/${ref.currency.toLowerCase()}`)
      if (entry === undefined) {
        // Either the id is unknown to CoinGecko or it does not quote this currency. Both are
        // NOT_FOUND for this instrument, and neither writes anything.
        results.push({ ok: false, ref, error: { code: 'NOT_FOUND' } })
        continue
      }
      const asOf = entry.asOf ?? today
      if (asOf === null) {
        results.push({
          ok: false,
          ref,
          error: { code: 'MALFORMED_RESPONSE', detail: `no date for ${id}` },
        })
        continue
      }
      results.push({
        ok: true,
        ref,
        price: { value: entry.price, currency: ref.currency },
        asOf,
        // /simple/price carries no prior close, so day change is unavailable from this call. Null
        // rather than a repeat of today's figure, which would render as a flat 0.00%.
        previousClose: null,
        // Crypto never closes, so there is no session to be inside and no closing price to be
        // pre-empted: a row here means "the price at the moment it was fetched", which is what
        // `fetchedAt` records and what the calendar-hours staleness thresholds in `staleness.ts`
        // are written against. Withholding these would leave crypto permanently unpriced.
        intraday: false,
      })
    }
    return results
  }

  /**
   * Daily closes from `/coins/{id}/market_chart`.
   *
   * The endpoint takes a lookback in days rather than a date range, so the range is converted to a
   * day count and the result is filtered back down to what was asked for. The public plan caps
   * daily granularity at 365 days, which is why a longer request is refused rather than quietly
   * returning hourly points the caller would then mis-date.
   */
  async fetchHistory(
    ref: InstrumentRef,
    from: IsoDate,
    to: IsoDate,
    signal: AbortSignal,
  ): Promise<ProviderResult<readonly HistoricalClose[]>> {
    const id = coinIdFor(ref)
    if (id === null) return { ok: false, error: { code: 'NOT_SUPPORTED' } }

    const days = daysOfLookback(from)
    if (days === null) {
      return {
        ok: false,
        error: {
          code: 'MALFORMED_RESPONSE',
          detail: 'CoinGecko serves at most 365 days of daily history on the public plan.',
        },
      }
    }

    const url =
      `${COINGECKO_BASE}/coins/${id}/market_chart` +
      `?vs_currency=${encodeURIComponent(ref.currency.toLowerCase())}&days=${days.toString()}&interval=daily&precision=full`

    let response: { status: number; body: string }
    try {
      response = await this.options.fetcher(url, signal)
    } catch {
      return { ok: false, error: { code: 'OFFLINE' } }
    }

    const failed = statusError(response.status)
    if (failed !== null) return { ok: false, error: failed }

    let parsed: Json
    try {
      parsed = parseLossless(response.body)
    } catch {
      return { ok: false, error: { code: 'MALFORMED_RESPONSE', detail: 'response was not JSON' } }
    }
    const prices = field(parsed, 'prices')
    if (!isJsonArray(prices)) {
      return { ok: false, error: { code: 'MALFORMED_RESPONSE', detail: 'no prices array' } }
    }

    const closes: HistoricalClose[] = []
    for (const point of prices) {
      if (!isJsonArray(point)) continue
      const at = rawText(point[0])
      const close = decOf(point[1])
      if (at === null || close === null) continue
      const asOf = millisAt(at)
      if (asOf === null || asOf < from || asOf > to) continue
      closes.push({ asOf, close, currency: ref.currency })
    }
    return { ok: true, value: closes.sort((a, b) => (a.asOf < b.asOf ? -1 : 1)) }
  }
}

/** Whole days from `from` to today, or null when that exceeds the public plan's daily window. */
function daysOfLookback(from: IsoDate): number | null {
  const start = DateTime.fromISO(from, { zone: IST })
  if (!start.isValid) return null
  const days = DateTime.now().setZone(IST).startOf('day').diff(start.startOf('day'), 'days').days
  if (!Number.isInteger(days) || days < 1) return 1
  return days > 365 ? null : days
}
