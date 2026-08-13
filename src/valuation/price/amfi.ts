/**
 * AMFI — mutual fund NAVs, keyless.
 *
 * One fetch covers the entire Indian mutual fund book, which is why fund tracking works before the
 * user has entered any credential.
 *
 * The parser reads its column mapping from the header line it actually receives, never from which
 * URL it requested. The daily file has six columns and the historical report has eight, in a
 * different order; assuming the daily layout on a historical file silently swaps the scheme name
 * into the ISIN field and matches nothing at all while reporting success.
 */

import { type Dec, dec } from '@domain/numeric'
import { DateTime } from 'luxon'
import type { AliasRef, InstrumentRef, IsoDate } from '../types'
import type {
  HistoricalClose,
  PriceProvider,
  ProviderCapabilities,
  ProviderResult,
  QuoteResult,
} from './types'

export const AMFI_DAILY_URL = 'https://portal.amfiindia.com/spages/NAVAll.txt'
export const AMFI_HISTORY_URL = 'https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx'

export interface AmfiRow {
  readonly schemeCode: string
  readonly schemeName: string
  /** Both ISIN columns, with the `-` placeholder dropped. */
  readonly isins: readonly string[]
  readonly nav: Dec
  readonly asOf: IsoDate
}

export interface AmfiParseResult {
  readonly rows: readonly AmfiRow[]
  /** Lines that looked like data but could not be parsed, with the reason. Never silently dropped. */
  readonly skipped: readonly { readonly line: string; readonly reason: string }[]
  readonly columns: readonly string[]
}

/** Header labels differ between the two files only by spacing, so they are compared normalised. */
function normaliseHeader(label: string): string {
  return label.toLowerCase().replace(/\s+/g, '')
}

const COLUMN_KEYS = {
  schemeCode: ['schemecode'],
  schemeName: ['schemename'],
  isinPayout: ['isindivpayout/isingrowth'],
  isinReinvest: ['isindivreinvestment'],
  nav: ['netassetvalue'],
  date: ['date'],
} as const

type ColumnName = keyof typeof COLUMN_KEYS

function mapColumns(header: readonly string[]): Partial<Record<ColumnName, number>> | null {
  const mapping: Partial<Record<ColumnName, number>> = {}
  header.forEach((label, index) => {
    const normalised = normaliseHeader(label)
    for (const name of Object.keys(COLUMN_KEYS) as ColumnName[]) {
      if ((COLUMN_KEYS[name] as readonly string[]).includes(normalised)) mapping[name] = index
    }
  })
  if (mapping.schemeCode === undefined || mapping.nav === undefined || mapping.date === undefined) {
    return null
  }
  return mapping
}

function parseAmfiDate(raw: string): IsoDate | null {
  // 'DD-MMM-YYYY' with an English month abbreviation, in IST.
  const parsed = DateTime.fromFormat(raw.trim(), 'dd-MMM-yyyy', { locale: 'en-US', zone: 'Asia/Kolkata' })
  if (!parsed.isValid) return null
  return parsed.toISODate()
}

const NAV_PATTERN = /^-?\d+(?:\.\d+)?$/

/**
 * Parse either AMFI layout.
 *
 * A line is data iff it splits into exactly as many fields as the header. Category headings
 * ('Open Ended Schemes(Debt Scheme - Banking and PSU Fund)') and fund-house names are bare lines
 * and fall out on that test — deliberately not by tracking section state, because the section
 * structure changes without notice and a positional parser breaks silently.
 */
export function parseAmfi(text: string): AmfiParseResult {
  const rows: AmfiRow[] = []
  const skipped: { line: string; reason: string }[] = []
  let columns: readonly string[] = []
  let mapping: Partial<Record<ColumnName, number>> | null = null

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    const fields = line.split(';').map((f) => f.trim())

    if (mapping === null || fields.length !== columns.length) {
      const candidate = mapColumns(fields)
      if (candidate !== null && normaliseHeader(fields[candidate.schemeCode ?? 0] ?? '') === 'schemecode') {
        mapping = candidate
        columns = fields
        continue
      }
    }
    if (mapping === null) continue
    if (fields.length !== columns.length) continue

    const schemeCode = fields[mapping.schemeCode ?? 0] ?? ''
    const navRaw = fields[mapping.nav ?? 0] ?? ''
    const dateRaw = fields[mapping.date ?? 0] ?? ''
    if (schemeCode === '' || !/^\d+$/.test(schemeCode)) continue

    if (!NAV_PATTERN.test(navRaw)) {
      // 'N.A.' appears for schemes with no NAV published that day. It is not a value and is never
      // coerced into one.
      skipped.push({ line, reason: `unparseable NAV ${JSON.stringify(navRaw)}` })
      continue
    }
    const asOf = parseAmfiDate(dateRaw)
    if (asOf === null) {
      skipped.push({ line, reason: `unparseable date ${JSON.stringify(dateRaw)}` })
      continue
    }

    const isins = [mapping.isinPayout, mapping.isinReinvest]
      .map((index) => (index === undefined ? '' : (fields[index] ?? '')))
      .filter((value) => value !== '' && value !== '-')

    rows.push({
      schemeCode,
      schemeName: mapping.schemeName === undefined ? '' : (fields[mapping.schemeName] ?? ''),
      isins,
      nav: dec(navRaw),
      asOf,
    })
  }

  return { rows, skipped, columns }
}

function aliasValues(instrument: InstrumentRef, scheme: AliasRef['scheme']): string[] {
  return instrument.aliases.filter((a) => a.scheme === scheme).map((a) => a.value)
}

/**
 * Match a parsed row to an instrument by ISIN first, then by AMFI scheme code. A row matching
 * nothing is ignored: the file covers every scheme in India and most are irrelevant.
 */
export function matchRow(row: AmfiRow, instruments: readonly InstrumentRef[]): InstrumentRef | null {
  for (const instrument of instruments) {
    const isins = new Set([...aliasValues(instrument, 'isin'), instrument.isin ?? ''])
    if (row.isins.some((isin) => isins.has(isin))) return instrument
  }
  for (const instrument of instruments) {
    if (aliasValues(instrument, 'amfi').includes(row.schemeCode)) return instrument
  }
  return null
}

export interface AmfiFetcher {
  (url: string, signal: AbortSignal): Promise<string>
}

const CAPABILITIES: ProviderCapabilities = {
  assetClasses: ['mutual_fund'],
  requiresApiKey: false,
  latency: 'eod',
  supportsHistory: true,
  supportsFx: false,
  // One file covers every scheme, so there is no per-symbol cost and nothing to rate limit beyond
  // the once-a-day fetch the caller schedules.
  rateLimit: null,
}

/** Maximum span the historical report accepts in one request. */
export const AMFI_HISTORY_MAX_DAYS = 90

export class AmfiProvider implements PriceProvider {
  readonly id = 'amfi' as const
  readonly capabilities = CAPABILITIES

  constructor(private readonly fetcher: AmfiFetcher) {}

  supports(instrument: InstrumentRef): boolean {
    if (instrument.assetClass !== 'mutual_fund') return false
    return (
      instrument.isin !== null ||
      aliasValues(instrument, 'isin').length > 0 ||
      aliasValues(instrument, 'amfi').length > 0
    )
  }

  async fetchLatest(
    refs: readonly InstrumentRef[],
    signal: AbortSignal,
  ): Promise<readonly QuoteResult[]> {
    const supported = refs.filter((ref) => this.supports(ref))
    const unsupported = refs
      .filter((ref) => !this.supports(ref))
      .map<QuoteResult>((ref) => ({ ok: false, ref, error: { code: 'NOT_SUPPORTED' } }))
    if (supported.length === 0) return unsupported

    let text: string
    try {
      text = await this.fetcher(AMFI_DAILY_URL, signal)
    } catch (cause) {
      const error = { code: 'OFFLINE' as const }
      void cause
      return [...unsupported, ...supported.map<QuoteResult>((ref) => ({ ok: false, ref, error }))]
    }

    const parsed = parseAmfi(text)
    const byInstrument = new Map<string, AmfiRow>()
    for (const row of parsed.rows) {
      const match = matchRow(row, supported)
      if (match === null) continue
      const existing = byInstrument.get(match.id)
      // Staleness is per row: a discontinued scheme can carry a years-old date, and the file's own
      // freshness says nothing about a given scheme's. The latest row for the instrument wins.
      if (existing === undefined || row.asOf > existing.asOf) byInstrument.set(match.id, row)
    }

    return [
      ...unsupported,
      ...supported.map<QuoteResult>((ref) => {
        const row = byInstrument.get(ref.id)
        if (row === undefined) return { ok: false, ref, error: { code: 'NOT_FOUND' } }
        return {
          ok: true,
          ref,
          price: { value: row.nav, currency: ref.currency },
          asOf: row.asOf,
          // The daily file carries no previous close, so day change is unavailable from AMFI
          // alone. It is null rather than a repeated value that would render as "0.00% today".
          previousClose: null,
          // A NAV is struck once, after the market closes, and published for that date. There is
          // no session during which this file carries a provisional figure: the row for a date
          // either exists and is final, or is not there yet.
          intraday: false,
        }
      }),
    ]
  }

  async fetchHistory(
    ref: InstrumentRef,
    from: IsoDate,
    to: IsoDate,
    signal: AbortSignal,
  ): Promise<ProviderResult<readonly HistoricalClose[]>> {
    if (!this.supports(ref)) return { ok: false, error: { code: 'NOT_SUPPORTED' } }
    const url = `${AMFI_HISTORY_URL}?frmdt=${toAmfiDate(from)}&todt=${toAmfiDate(to)}`
    let text: string
    try {
      text = await this.fetcher(url, signal)
    } catch {
      return { ok: false, error: { code: 'OFFLINE' } }
    }
    const parsed = parseAmfi(text)
    if (parsed.rows.length === 0) {
      return { ok: false, error: { code: 'MALFORMED_RESPONSE', detail: 'no data rows parsed' } }
    }
    const closes = parsed.rows
      .filter((row) => matchRow(row, [ref]) !== null)
      .map<HistoricalClose>((row) => ({ asOf: row.asOf, close: row.nav, currency: ref.currency }))
      .sort((a, b) => (a.asOf < b.asOf ? -1 : 1))
    return { ok: true, value: closes }
  }
}

function toAmfiDate(date: IsoDate): string {
  const parsed = DateTime.fromISO(date, { zone: 'utc' })
  return parsed.toFormat('dd-MMM-yyyy', { locale: 'en-US' })
}
