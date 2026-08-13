/**
 * Yahoo Finance — Indian equities, US equities, and keyless FX.
 *
 * The only free source that covers NSE and BSE, which makes it the provider that decides whether
 * an Indian equity book prices at all before the user has entered a credential. It is also
 * unofficial: undocumented, unsupported, and liable to change shape without notice. Everything
 * below is written on the assumption that it will one day return something unexpected, and the
 * rule for that day is that a surprise produces a named failure, never a number.
 *
 * Four things the response shape actually forced, none of which were guessable:
 *
 *  1. **The price is read from `meta.regularMarketPrice`, never from the candle arrays.**
 *     `indicators.quote[0].close` is float32 on Yahoo's side: a close of ₹1175.10 arrives as
 *     `1175.0999755859375`. `meta.regularMarketPrice` and `meta.chartPreviousClose` are computed
 *     as doubles and arrive clean (`1163.6`, `1175.1`). Reading the candle for the latest price
 *     would store four digits of Yahoo's rounding error in every row.
 *
 *  2. **A missing `regularMarketPrice` is a failure, and is never backfilled from the candles.**
 *     `500209.BO` — Infosys's BSE *scrip code* — returns HTTP 200, `chart.error: null`, and a
 *     `result[0]` whose meta has `currency: null`, no `regularMarketPrice`, `instrumentType:
 *     "MUTUALFUND"` and a `regularMarketTime` from June 2019. A parser that fell back to the last
 *     candle would have stored a seven-year-old number as today's price, silently. So a BSE alias
 *     that is all digits is refused outright (Yahoo's BSE symbols are tickers — `INFY.BO`), and a
 *     meta with no `regularMarketPrice` is reported rather than repaired.
 *
 *  3. **`meta.currency` is checked against the instrument, never converted.** Yahoo quotes some
 *     venues in minor units (LSE lines come back as `GBp`, i.e. pence). Storing a pence figure
 *     against a GBP instrument understates it a hundredfold, and it is exactly the class of error
 *     that looks plausible on screen.
 *
 *  4. **`as_of` is the exchange's local date**, derived from `regularMarketTime` in
 *     `meta.exchangeTimezoneName`. A US close at 16:00 New York is 01:30 IST the next day; dating
 *     it by the user's clock would make every US price look a day stale the moment it was fetched.
 *
 *  5. **`regularMarketPrice` during an open session is a live quote, not that day's close**, and
 *     is reported as such rather than stored. There is no `marketState` in the v8 chart meta — it
 *     belongs to the `/v7/quote` endpoint the allowlist does not admit — so the session is read
 *     from `meta.currentTradingPeriod.regular`, which every chart response carries as a pair of
 *     epoch seconds. See `sessionIsOpen` for why the comparison is against the clock rather than
 *     against `regularMarketTime`.
 *
 * Numbers are read as their literal wire text and never through `JSON.parse`, which would hand
 * back a double. The lossless reader is the one already written for the exchange adapters; it is
 * the only thing this subsystem borrows from there, and duplicating a JSON parser to preserve a
 * layering rule would be the worse trade.
 */

import { type Dec } from '@domain/numeric'
import { decFromRaw } from '@adapters/decimal-text'
import {
  field,
  isJsonArray,
  isJsonObject,
  isRawNumber,
  parseLossless,
  type Json,
} from '@adapters/lossless-json'
import { DateTime } from 'luxon'
import type { AliasRef, InstrumentRef, IsoDate, IsoInstant } from '../types'
import type {
  FxPair,
  FxQuoteResult,
  HistoricalClose,
  HistoricalFxRate,
  PriceProvider,
  PriceSelector,
  ProviderCapabilities,
  ProviderError,
  ProviderResult,
  QuoteResult,
} from './types'

export const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart'

/** The base currency's calendar. FX rows are dated by it; see `fetchFx`. */
const IST = 'Asia/Kolkata'

/**
 * How long to stand down after a 429.
 *
 * `fetch_market_data` returns status and body only, so `Retry-After` never reaches us. A minute
 * is the shortest interval that is unambiguously longer than Yahoo's unpublished window; the
 * refusal is reported to the user, not slept on, so the figure only sizes the advice.
 */
export const YAHOO_RETRY_AFTER_MS = 60_000

/** Pause between consecutive symbol requests. Yahoo's throttle is undocumented; this is polite. */
export const YAHOO_MIN_REQUEST_INTERVAL_MS = 250

/**
 * Symbols are built from aliases, so they are user data and reach a URL path. Restricted to the
 * character set Yahoo actually uses — letters, digits, `.` for the venue suffix, `-` for class
 * shares, `=X` for currency pairs, `^` for indices. The Rust allowlist would catch a traversal
 * attempt anyway; this refuses to construct one in the first place.
 */
const SYMBOL_PATTERN = /^[A-Z0-9.\-=^]{1,24}$/

/** A BSE alias that is all digits is a scrip code, and Yahoo's `.BO` symbols are tickers. */
const ALL_DIGITS = /^\d+$/

export interface YahooFetcher {
  (url: string, signal: AbortSignal): Promise<{ status: number; body: string }>
}

export interface YahooOptions {
  readonly fetcher: YahooFetcher
  /** Injected so tests pace without waiting. */
  readonly sleep?: (ms: number) => Promise<void>
  readonly minRequestIntervalMs?: number
  /**
   * The clock, injected so a test can place itself inside or outside a trading session.
   *
   * Needed because whether a quote is intraday is a question about *now* and not about anything
   * in the response; see `sessionIsOpen`.
   */
  readonly now?: () => IsoInstant
}

const CAPABILITIES: ProviderCapabilities = {
  assetClasses: ['indian_equity', 'us_equity'],
  requiresApiKey: false,
  // Yahoo's Indian feed is delayed; its US feed is near-real-time. The weaker claim is the honest
  // one for a field the UI shows the user.
  latency: 'delayed',
  supportsHistory: true,
  supportsFx: true,
  // Yahoo publishes no quota, so there is no credit model to describe and inventing one would put
  // a fabricated number on the settings screen. The real controls live in this provider: a pause
  // between requests, and a 429 that stops the batch instead of retrying into a block.
  rateLimit: null,
}

function alias(instrument: InstrumentRef, scheme: AliasRef['scheme']): string | null {
  return instrument.aliases.find((a) => a.scheme === scheme)?.value ?? null
}

/**
 * The Yahoo symbol for an instrument, or null when there is no honest way to name it.
 *
 * NSE lines take `.NS` and BSE lines take `.BO`, both on the ticker. A numeric BSE alias is a
 * scrip code and is refused — see the module comment for what Yahoo returns when you try one.
 */
export function yahooSymbolFor(instrument: InstrumentRef): string | null {
  const candidate = rawSymbolFor(instrument)
  if (candidate === null) return null
  const upper = candidate.trim().toUpperCase()
  return SYMBOL_PATTERN.test(upper) ? upper : null
}

function rawSymbolFor(instrument: InstrumentRef): string | null {
  switch (instrument.assetClass) {
    case 'indian_equity': {
      const nse = alias(instrument, 'nse')
      if (nse !== null && nse !== '') return `${nse}.NS`
      const bse = alias(instrument, 'bse')
      if (bse === null || bse === '' || ALL_DIGITS.test(bse.trim())) return null
      return `${bse}.BO`
    }
    case 'us_equity':
      return alias(instrument, 'ticker')
    case 'mutual_fund':
    case 'crypto':
    case 'gold':
    case 'bond':
    case 'cash':
      // AMFI covers Indian funds and CoinGecko covers crypto. The rest have no Yahoo line that
      // can be derived from an alias without guessing, and a guessed ticker prices the wrong
      // security.
      return null
  }
}

/** Yahoo's currency-pair convention: `USDINR=X` is rupees per dollar. */
export function fxSymbolFor(pair: FxPair): string {
  return `${pair.base}${pair.quote}=X`
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * `meta.currentTradingPeriod.regular`, as the two epoch-second strings it arrives as.
 *
 * Kept as text rather than parsed to a number: these are compared with `BigInt`, so nothing here
 * ever becomes a float.
 */
export interface YahooSession {
  readonly start: string
  readonly end: string
}

/** The parts of `chart.result[0].meta` this provider trusts. */
export interface YahooMeta {
  readonly symbol: string
  readonly currency: string
  readonly price: Dec
  readonly previousClose: Dec | null
  /** The exchange's local calendar date for `regularMarketTime`. */
  readonly asOf: IsoDate
  readonly timezone: string
  /** Kept so a caller working in another calendar can re-date the same instant. */
  readonly at: string
  /**
   * The regular session this response describes, or null when Yahoo did not state one.
   *
   * Null is not "closed": it is "unknown", and it is handled as such — see `sessionIsOpen`.
   */
  readonly session: YahooSession | null
}

export type YahooResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProviderError }

function malformed(detail: string): { ok: false; error: ProviderError } {
  return { ok: false, error: { code: 'MALFORMED_RESPONSE', detail } }
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
 * Turn a unix second count into the calendar date at a named zone.
 *
 * `Number.parseInt` on a digits-only string is a count of seconds, not a value: it never touches
 * money or a quantity, which is the same exemption `calendar.ts` takes for day counts.
 */
function dateAt(epochSeconds: string, zone: string): IsoDate | null {
  if (!/^\d{1,15}$/.test(epochSeconds)) return null
  // eslint-disable-next-line no-restricted-syntax -- epoch seconds, not a monetary value
  const at = DateTime.fromSeconds(Number.parseInt(epochSeconds, 10), { zone })
  if (!at.isValid) return null
  return at.toISODate()
}

/**
 * The transport-level verdict, before the body is even looked at.
 *
 * A 429 is reported, never slept through and retried: Yahoo's response to a client that keeps
 * knocking is a longer block, and a user who is told "Yahoo is rate limiting us" can act on that,
 * while a user watching a silent retry loop cannot.
 */
function statusError(status: number): ProviderError | null {
  if (status === 429) return { code: 'RATE_LIMITED', retryAfterMs: YAHOO_RETRY_AFTER_MS }
  // Yahoo has no account and no key, so a 401/403 is an edge block or a newly-imposed crumb
  // requirement — an upstream condition, not an authentication failure the user can fix.
  if (status === 401 || status === 403) return { code: 'UPSTREAM', status }
  return null
}

function chartResult(body: string, status: number): YahooResult<Json> {
  const failed = statusError(status)
  if (failed !== null) return { ok: false, error: failed }

  let parsed: Json
  try {
    parsed = parseLossless(body)
  } catch {
    return malformed(`response was not JSON (HTTP ${status.toString()})`)
  }

  const chart = field(parsed, 'chart')
  if (!isJsonObject(chart)) {
    return status >= 400
      ? { ok: false, error: { code: 'UPSTREAM', status } }
      : malformed('no chart object in response')
  }

  const error = field(chart, 'error')
  if (isJsonObject(error)) {
    const code = rawText(field(error, 'code')) ?? ''
    // 'Not Found' is Yahoo's wording for a symbol it does not carry, which is the one upstream
    // condition that is really about this instrument rather than about the service.
    if (code === 'Not Found') return { ok: false, error: { code: 'NOT_FOUND' } }
    return { ok: false, error: { code: 'UPSTREAM', status } }
  }

  if (status >= 400) return { ok: false, error: { code: 'UPSTREAM', status } }

  const results = field(chart, 'result')
  if (!isJsonArray(results)) return malformed('chart.result is not an array')
  const first = results[0]
  if (first === undefined) return { ok: false, error: { code: 'NOT_FOUND' } }
  if (!isJsonObject(first)) return malformed('chart.result[0] is not an object')
  return { ok: true, value: first }
}

/** Parse a chart response down to the quote in its `meta`. */
export function parseChartQuote(body: string, status: number): YahooResult<YahooMeta> {
  const result = chartResult(body, status)
  if (!result.ok) return result

  const meta = field(result.value, 'meta')
  if (!isJsonObject(meta)) return malformed('chart.result[0].meta is not an object')

  const symbol = rawText(field(meta, 'symbol')) ?? ''
  const currency = rawText(field(meta, 'currency'))
  const price = decOf(field(meta, 'regularMarketPrice'))
  const time = rawText(field(meta, 'regularMarketTime'))
  const zone = rawText(field(meta, 'exchangeTimezoneName'))

  // The delisted-stub shape: 200 OK, no error, a result, and no price in it. Named explicitly
  // because the tempting repair — reach into the candles — is how a 2019 close becomes today's.
  if (currency === null || price === null || time === null) {
    return malformed(
      `no quote in meta for ${symbol === '' ? 'the requested symbol' : symbol}; Yahoo returned a result with no regularMarketPrice`,
    )
  }
  if (zone === null) return malformed(`no exchange timezone in meta for ${symbol}`)

  const asOf = dateAt(time, zone)
  if (asOf === null) return malformed(`unreadable regularMarketTime ${JSON.stringify(time)}`)

  return {
    ok: true,
    value: {
      symbol,
      currency,
      price,
      previousClose: decOf(field(meta, 'chartPreviousClose')),
      asOf,
      timezone: zone,
      at: time,
      session: sessionOf(meta),
    },
  }
}

/** `meta.currentTradingPeriod.regular`, or null when it is absent or unreadable. */
function sessionOf(meta: Json): YahooSession | null {
  const regular = field(field(meta, 'currentTradingPeriod'), 'regular')
  if (!isJsonObject(regular)) return null
  const start = rawText(field(regular, 'start'))
  const end = rawText(field(regular, 'end'))
  if (start === null || end === null) return null
  if (!EPOCH_SECONDS.test(start) || !EPOCH_SECONDS.test(end)) return null
  return { start, end }
}

const EPOCH_SECONDS = /^\d{1,15}$/

/**
 * Is the quote in this meta a live print from a session that has not finished?
 *
 * Two things make this harder than reading a flag, and both were established by looking at real
 * responses rather than assumed:
 *
 *  - **There is no `marketState` in the v8 chart meta.** It exists on `/v7/finance/quote`, which
 *    the host allowlist deliberately does not admit. What the chart does carry is
 *    `currentTradingPeriod.regular`, a `{start, end}` pair of epoch seconds.
 *
 *  - **The comparison must be against the clock, not against `regularMarketTime`.** The tempting
 *    test — "is the last print inside the session window" — is wrong in the direction that
 *    matters: an NSE line whose final regular trade printed at 15:29:58 keeps that timestamp all
 *    evening, so it would look intraday forever and its close would never be stored. Asking
 *    whether *now* is before the session's end has no such trap, and it stays correct whether
 *    Yahoo reports the session that just ended or the one about to start: in the second case the
 *    stamped print predates `start` and the answer is "no" on the other clause.
 *
 * An absent `currentTradingPeriod` returns false — the reading is stored as a close. That is the
 * conservative direction for the only failure the caller can still recover from: a close wrongly
 * withheld cannot be replaced by anything, whereas a row written for today is overwritten by the
 * next refresh after the session ends. Every real chart response carries the field.
 */
export function sessionIsOpen(meta: YahooMeta, nowSeconds: bigint): boolean {
  if (meta.session === null) return false
  if (!EPOCH_SECONDS.test(meta.at)) return false
  return BigInt(meta.at) >= BigInt(meta.session.start) && nowSeconds < BigInt(meta.session.end)
}

/**
 * Parse the daily candles.
 *
 * These carry Yahoo's float32 rounding (`1175.0999755859375` for a ₹1175.10 close) and are stored
 * exactly as sent. Rounding them to `meta.priceHint` would usually recover the true close and
 * would occasionally invent one, and a history series is not worth inventing a price for.
 */
export function parseChartHistory(
  body: string,
  status: number,
): YahooResult<{ currency: string; closes: readonly { asOf: IsoDate; close: Dec }[] }> {
  const result = chartResult(body, status)
  if (!result.ok) return result

  const meta = field(result.value, 'meta')
  if (!isJsonObject(meta)) return malformed('chart.result[0].meta is not an object')
  const currency = rawText(field(meta, 'currency'))
  const zone = rawText(field(meta, 'exchangeTimezoneName'))
  if (currency === null || zone === null) return malformed('no currency or timezone in meta')

  const timestamps = field(result.value, 'timestamp')
  const indicators = field(result.value, 'indicators')
  const quotes = field(indicators, 'quote')
  if (!isJsonArray(timestamps) || !isJsonArray(quotes)) {
    return malformed('no timestamp or quote arrays in the chart')
  }
  const closes = field(quotes[0], 'close')
  if (!isJsonArray(closes)) return malformed('no close array in the chart')

  const out: { asOf: IsoDate; close: Dec }[] = []
  timestamps.forEach((timestamp, index) => {
    const raw = rawText(timestamp)
    const close = decOf(closes[index])
    // A null close is a session with no trade — a halt, or a holiday Yahoo still emits a slot
    // for. Dropped rather than carried forward, because carrying it forward invents a print.
    if (raw === null || close === null) return
    const asOf = dateAt(raw, zone)
    if (asOf === null) return
    out.push({ asOf, close })
  })

  return { ok: true, value: { currency, closes: out.sort((a, b) => (a.asOf < b.asOf ? -1 : 1)) } }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Midnight UTC for an ISO date, as unix seconds, without touching a float. */
function epochSeconds(date: IsoDate): string | null {
  const at = DateTime.fromISO(date, { zone: 'utc' })
  if (!at.isValid) return null
  return at.toUnixInteger().toString()
}

export class YahooProvider implements PriceProvider {
  readonly id = 'yahoo' as const
  readonly capabilities = CAPABILITIES

  private readonly sleep: (ms: number) => Promise<void>
  private readonly intervalMs: number
  private readonly now: () => IsoInstant

  constructor(private readonly options: YahooOptions) {
    this.sleep = options.sleep ?? realSleep
    this.intervalMs = options.minRequestIntervalMs ?? YAHOO_MIN_REQUEST_INTERVAL_MS
    this.now = options.now ?? (() => DateTime.now().toISO())
  }

  /** The current instant as unix seconds. A count, so `BigInt` rather than a parse. */
  private nowSeconds(): bigint {
    const at = DateTime.fromISO(this.now())
    return at.isValid ? BigInt(at.toUnixInteger()) : BigInt(0)
  }

  supports(instrument: InstrumentRef): boolean {
    return yahooSymbolFor(instrument) !== null
  }

  private async get(
    symbol: string,
    query: string,
    signal: AbortSignal,
  ): Promise<YahooResult<{ status: number; body: string }>> {
    if (signal.aborted) return { ok: false, error: { code: 'OFFLINE' } }
    try {
      return {
        ok: true,
        value: await this.options.fetcher(`${YAHOO_CHART_BASE}/${symbol}?${query}`, signal),
      }
    } catch {
      // The transport refused or the machine is offline. Indistinguishable from here, and both
      // mean the same thing to the caller: no price was obtained, so no price is written.
      return { ok: false, error: { code: 'OFFLINE' } }
    }
  }

  /**
   * One request per symbol.
   *
   * The chart endpoint takes a single symbol, and the batch quote endpoint that would replace it
   * lives under `/v7/`, which the host allowlist deliberately does not admit — it now requires a
   * cookie-and-crumb handshake that a keyless client has no honest way to perform.
   *
   * The loop stops at the first 429 rather than working through the rest. Every further request
   * after a refusal buys nothing and lengthens the block, so the remaining symbols are reported
   * as rate limited without being asked for.
   */
  async fetchLatest(
    refs: readonly InstrumentRef[],
    signal: AbortSignal,
  ): Promise<readonly QuoteResult[]> {
    const results: QuoteResult[] = []
    const wanted: { ref: InstrumentRef; symbol: string }[] = []
    for (const ref of refs) {
      const symbol = yahooSymbolFor(ref)
      if (symbol === null) results.push({ ok: false, ref, error: { code: 'NOT_SUPPORTED' } })
      else wanted.push({ ref, symbol })
    }

    const nowSeconds = this.nowSeconds()
    let halted: ProviderError | null = null
    for (const [index, { ref, symbol }] of wanted.entries()) {
      if (halted !== null) {
        results.push({ ok: false, ref, error: halted })
        continue
      }
      if (index > 0) await this.sleep(this.intervalMs)

      const response = await this.get(symbol, 'range=1d&interval=1d', signal)
      if (!response.ok) {
        // Offline halts the batch: forty more attempts against a dead socket only lengthen the
        // wait before the user is told the one thing that matters.
        halted = response.error
        results.push({ ok: false, ref, error: response.error })
        continue
      }

      const parsed = parseChartQuote(response.value.body, response.value.status)
      if (!parsed.ok) {
        if (parsed.error.code === 'RATE_LIMITED') halted = parsed.error
        results.push({ ok: false, ref, error: parsed.error })
        continue
      }
      if (parsed.value.currency !== ref.currency) {
        results.push({
          ok: false,
          ref,
          error: {
            code: 'MALFORMED_RESPONSE',
            detail: `Yahoo quotes ${symbol} in ${parsed.value.currency}, but ${ref.displayName} is held in ${ref.currency}. Refusing to convert.`,
          },
        })
        continue
      }

      results.push({
        ok: true,
        ref,
        price: { value: parsed.value.price, currency: ref.currency },
        asOf: parsed.value.asOf,
        previousClose:
          parsed.value.previousClose === null
            ? null
            : { value: parsed.value.previousClose, currency: ref.currency },
        // A live quote, flagged rather than dressed up as the day's close. `chartPreviousClose`
        // is a real close and is handed on beside it, but it is deliberately not promoted into
        // `price`: the response says which *value* the previous close is and never which *day* it
        // belongs to, and a close filed under a guessed date is the defect one square along.
        intraday: sessionIsOpen(parsed.value, nowSeconds),
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
    const symbol = yahooSymbolFor(ref)
    if (symbol === null) return { ok: false, error: { code: 'NOT_SUPPORTED' } }
    const start = epochSeconds(from)
    const end = epochSeconds(to)
    if (start === null || end === null) {
      return { ok: false, error: { code: 'MALFORMED_RESPONSE', detail: 'unreadable date range' } }
    }
    // `period2` cuts at an instant rather than at the end of a day, so it is pushed a day past
    // `to`; without that the last date the caller asked for is silently missing from the series.
    const response = await this.get(
      symbol,
      `period1=${start}&period2=${(BigInt(end) + 86_400n).toString()}&interval=1d`,
      signal,
    )
    if (!response.ok) return response

    const parsed = parseChartHistory(response.value.body, response.value.status)
    if (!parsed.ok) return parsed
    if (parsed.value.currency !== ref.currency) {
      return {
        ok: false,
        error: {
          code: 'MALFORMED_RESPONSE',
          detail: `Yahoo quotes ${symbol} in ${parsed.value.currency}, not ${ref.currency}.`,
        },
      }
    }
    return {
      ok: true,
      value: parsed.value.closes
        .filter((row) => row.asOf >= from && row.asOf <= to)
        .map<HistoricalClose>((row) => ({
          asOf: row.asOf,
          close: row.close,
          currency: ref.currency,
        })),
    }
  }

  /**
   * Exchange rates, keyless.
   *
   * This is the part that makes FX work for a user who has entered no credential at all. Twelve
   * Data serves rates too, but only with a key; without a stored rate the engine refuses to
   * convert, so every US holding vanishes from net worth rather than merely showing as unpriced.
   *
   * `as_of` is the IST calendar date rather than the venue's. Yahoo files currency pairs under a
   * `CCY` pseudo-exchange on Europe/London, which is a quirk of its data model rather than a
   * trading session, and the rate is consumed against an IST valuation date.
   */
  async fetchFx(
    pairs: readonly FxPair[],
    on: PriceSelector,
    signal: AbortSignal,
  ): Promise<readonly FxQuoteResult[]> {
    const results: FxQuoteResult[] = []
    let halted: ProviderError | null = null

    for (const [index, pair] of pairs.entries()) {
      if (halted !== null) {
        results.push({ ok: false, pair, error: halted })
        continue
      }
      if (index > 0) await this.sleep(this.intervalMs)

      const symbol = fxSymbolFor(pair)
      if (!SYMBOL_PATTERN.test(symbol)) {
        results.push({ ok: false, pair, error: { code: 'NOT_SUPPORTED' } })
        continue
      }

      if (on === 'latest') {
        const response = await this.get(symbol, 'range=1d&interval=1d', signal)
        if (!response.ok) {
          halted = response.error
          results.push({ ok: false, pair, error: response.error })
          continue
        }
        const parsed = parseChartQuote(response.value.body, response.value.status)
        if (!parsed.ok) {
          if (parsed.error.code === 'RATE_LIMITED') halted = parsed.error
          results.push({ ok: false, pair, error: parsed.error })
          continue
        }
        // `USDINR=X` must quote INR. If Yahoo ever answers in anything else the pair has been
        // reinterpreted, and an inverted rate is the single most expensive mistake in this file.
        if (parsed.value.currency !== pair.quote) {
          results.push({
            ok: false,
            pair,
            error: {
              code: 'MALFORMED_RESPONSE',
              detail: `${symbol} came back quoted in ${parsed.value.currency}, not ${pair.quote}.`,
            },
          })
          continue
        }
        results.push({
          ok: true,
          pair,
          rate: parsed.value.price,
          // The same instant Yahoo stamped, re-dated onto the base currency's calendar.
          asOf: dateAt(parsed.value.at, IST) ?? parsed.value.asOf,
        })
        continue
      }

      const dated = await this.fxOn(symbol, pair, on, signal)
      if (!dated.ok && dated.error.code === 'RATE_LIMITED') halted = dated.error
      results.push(dated.ok ? { ok: true, pair, rate: dated.value, asOf: on } : { ok: false, pair, error: dated.error })
    }
    return results
  }

  /**
   * Dated exchange rates across a span, in one request.
   *
   * The same `USDINR=X` chart endpoint that serves `fetchFx`, with `period1`/`period2` — already
   * on the allowlist, because it is the same host and the same `/v8/finance/` prefix. Yahoo
   * publishes the daily FX series back to the 1990s, stamps each bar at midnight UTC, and emits
   * **no bar at all for a weekend or a holiday**: 1–8 January 2019 comes back as six rows, not
   * eight. So a gap in the result is a gap in the market, and the rows are returned exactly as
   * they arrived, dated by their own timestamp. Nothing here manufactures a Sunday.
   *
   * The closes carry Yahoo's float32 rounding, exactly as the equity candles do — a rate that was
   * 69.71 arrives as `69.70999908447266`. It is stored as sent, for the reason
   * `parseChartHistory` gives: rounding it back would usually recover the published figure and
   * would occasionally invent one.
   */
  async fetchFxHistory(
    pair: FxPair,
    from: IsoDate,
    to: IsoDate,
    signal: AbortSignal,
  ): Promise<ProviderResult<readonly HistoricalFxRate[]>> {
    const symbol = fxSymbolFor(pair)
    if (!SYMBOL_PATTERN.test(symbol)) return { ok: false, error: { code: 'NOT_SUPPORTED' } }
    const start = epochSeconds(from)
    const end = epochSeconds(to)
    if (start === null || end === null) {
      return { ok: false, error: { code: 'MALFORMED_RESPONSE', detail: 'unreadable date range' } }
    }
    const response = await this.get(
      symbol,
      // `period2` cuts at an instant, so it is pushed a day past `to` or the last day asked for
      // is silently missing — the same correction `fetchHistory` makes, for the same reason.
      `period1=${start}&period2=${(BigInt(end) + 86_400n).toString()}&interval=1d`,
      signal,
    )
    if (!response.ok) return response

    const parsed = parseChartHistory(response.value.body, response.value.status)
    if (!parsed.ok) return parsed
    if (parsed.value.currency !== pair.quote) {
      // An inverted rate is the single most expensive mistake in this file, and it is no less
      // expensive for being historical.
      return {
        ok: false,
        error: {
          code: 'MALFORMED_RESPONSE',
          detail: `${symbol} came back quoted in ${parsed.value.currency}, not ${pair.quote}.`,
        },
      }
    }
    return {
      ok: true,
      value: parsed.value.closes
        .filter((row) => row.asOf >= from && row.asOf <= to)
        .map<HistoricalFxRate>((row) => ({ asOf: row.asOf, rate: row.close })),
    }
  }

  /** The last close at or before `on`, within a week's lookback. Never interpolated. */
  private async fxOn(
    symbol: string,
    pair: FxPair,
    on: IsoDate,
    signal: AbortSignal,
  ): Promise<YahooResult<Dec>> {
    const at = epochSeconds(on)
    if (at === null) return malformed('unreadable date')
    // A week of lookback covers a long weekend plus a holiday. Beyond that the rate is not the
    // requested day's by any reasonable reading, and NOT_FOUND is the honest answer.
    const response = await this.get(
      symbol,
      `period1=${(BigInt(at) - 7n * 86_400n).toString()}&period2=${(BigInt(at) + 86_400n).toString()}&interval=1d`,
      signal,
    )
    if (!response.ok) return response
    const parsed = parseChartHistory(response.value.body, response.value.status)
    if (!parsed.ok) return parsed
    if (parsed.value.currency !== pair.quote) {
      return malformed(`${symbol} came back quoted in ${parsed.value.currency}, not ${pair.quote}.`)
    }
    const eligible = parsed.value.closes.filter((row) => row.asOf <= on)
    const last = eligible[eligible.length - 1]
    if (last === undefined) return { ok: false, error: { code: 'NOT_FOUND' } }
    return { ok: true, value: last.close }
  }
}
