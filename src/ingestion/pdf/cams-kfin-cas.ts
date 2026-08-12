/**
 * The CAMS/KFintech mutual fund CAS — the only Indian statement that can yield `capability =
 * 'ledger'`, and then only when it was requested in Detailed mode from inception.
 *
 * Document nesting, in the order it appears:
 *
 *     header block ─ investor, period '01-Apr-1990 To 27-Aug-2024'
 *     PORTFOLIO SUMMARY
 *       AMC line          'HDFC Mutual Fund'
 *         folio line      'Folio No: 12345678 / 0  PAN: ABCDE1234F'
 *           scheme line   '<rta code>-<name> - ISIN: <isin> (Advisor: ...) Registrar : CAMS'
 *             Opening Unit Balance: ...
 *             transaction rows
 *             Closing Unit Balance: ...  NAV on <d>: INR ...
 *
 * Two structural rules produce most parser bugs in this family and are handled explicitly here:
 * section context carries across page breaks (a scheme header is printed once, and its rows
 * continue under a repeated *column* header on the next page), and the statement validates itself
 * through a running unit balance that is the highest-value correctness mechanism available.
 */

import { classifyDescription, type UnitsSign } from '../classify'
import { canonicalDecimal, subtractDec, sumDec, withinTolerance } from '../numbers'
import type { ExtractPlugin, RecordSink } from '../plugin'
import { collapseWhitespace, findIsin, normaliseGlyphs } from '../text'
import type { Capability, DecodedInput, PdfPage, RawTransaction, TextLine } from '../types'
import { findHeaders, readRow, bandIndex, type ColumnBand } from './table'
import { type Dec, dec } from '@domain/numeric'

const PROVIDER_ID = 'cams-cas'
const TIMEZONE = 'Asia/Kolkata'
const DATE_FORMAT = 'dd-MMM-yyyy'
const CURRENCY = 'INR'

/** Units tolerance for every checksum in this family. */
const UNIT_TOLERANCE = dec('0.005')

const TABLE_LABELS = ['date', 'transaction', 'amount', 'units', 'price', 'nav', 'unit', 'balance']

const GENERATOR_FOOTERS = ['CAMSCASWS', 'KFINCASWS', 'KARVYCASWS']

export const camsKfinCasPlugin: ExtractPlugin = {
  id: 'cams-kfin-cas',
  providerId: PROVIDER_ID,
  accepts: 'cas-pdf',
  detect,
  extract,
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

type StatementType = 'detailed' | 'summary'

const TITLE = /consolidated\s+account\s+(statement|summary)/i

function detect(input: DecodedInput): number {
  if (input.kind !== 'pdf-text') return 0
  const text = textOf(input.pages, 3)
  // The generator footer is the *issuing* RTA and is distinct from each scheme's `Registrar :`
  // value — a CAMS-generated statement routinely contains KFintech-serviced folios. Only the
  // footer decides which sub-parser runs.
  if (GENERATOR_FOOTERS.some((footer) => text.includes(footer))) return 0.95
  return TITLE.test(text) ? 0.9 : 0
}

function statementTypeOf(pages: readonly PdfPage[]): StatementType {
  const match = TITLE.exec(textOf(pages, 3))
  return match?.[1]?.toLowerCase() === 'summary' ? 'summary' : 'detailed'
}

function textOf(pages: readonly PdfPage[], limit: number): string {
  return pages
    .slice(0, limit)
    .flatMap((page) => page.lines.map((line) => line.text))
    .join('\n')
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

interface FolioContext {
  readonly amc: string
  readonly folio: string
  readonly accountKey: string
}

interface SchemeContext {
  readonly rtaCode: string
  readonly name: string
  readonly isin: string | null
  readonly registrar: string | null
  readonly folio: FolioContext
  openingBalance: Dec
  openingSeen: boolean
  closingBalance: Dec | null
  closingDate: string | null
  marketValue: string | null
  runningBalance: Dec
  readonly units: Dec[]
  readonly transactions: RawTransaction[]
  balanceMismatch: boolean
}

function extract(input: DecodedInput, sink: RecordSink): void {
  if (input.kind !== 'pdf-text') return
  const pages = input.pages
  const type = statementTypeOf(pages)
  if (type === 'summary') {
    extractSummary(pages, sink)
    return
  }

  const state = {
    amc: null as string | null,
    folio: null as FolioContext | null,
    scheme: null as SchemeContext | null,
    bands: null as readonly ColumnBand[] | null,
    nonZeroOpening: false,
    anyMismatch: false,
    folios: new Map<string, FolioContext>(),
  }

  readPeriod(pages, sink)

  for (const page of pages) {
    // Column bands are re-seeded at every column header, but the scheme, folio and AMC context
    // deliberately survive the page boundary: they are printed once and the rows that follow
    // continue under a repeated *column* header with no repeated *section* header.
    const headers = findHeaders(page.lines, TABLE_LABELS, 4)

    for (let i = 0; i < page.lines.length; i += 1) {
      const line = page.lines[i]
      if (line === undefined) continue
      const header = headers.find((h) => i >= h.firstLine && i <= h.lastLine)
      if (header !== undefined) {
        state.bands = header.bands
        continue
      }
      const ref = `p.${String(page.pageNumber)} r.${String(i + 1)}`
      const text = collapseWhitespace(normaliseGlyphs(line.text))
      if (text === '') continue

      const amc = matchAmc(text)
      if (amc !== null) {
        closeScheme(state, sink)
        state.amc = amc
        continue
      }

      const folio = matchFolio(text, state.amc)
      if (folio !== null) {
        closeScheme(state, sink)
        state.folio = folio
        state.folios.set(folio.accountKey, folio)
        continue
      }

      const scheme = matchScheme(text, state.folio, page.lines[i + 1]?.text)
      if (scheme !== null) {
        closeScheme(state, sink)
        state.scheme = scheme
        continue
      }

      const current = state.scheme
      if (current === null) continue

      const opening = /opening unit balance\s*:?\s*([\d,.()-]+)/i.exec(text)
      if (opening !== null) {
        const parsed = canonicalDecimal(opening[1] ?? '')
        if (parsed.ok) {
          current.openingBalance = parsed.value.value
          current.runningBalance = parsed.value.value
          current.openingSeen = true
          if (parsed.value.value !== '0' && !/^0(?:\.0*)?$/.test(parsed.value.value)) {
            state.nonZeroOpening = true
          }
        }
        continue
      }

      const closing = /closing unit balance\s*:?\s*([\d,.()-]+)/i.exec(text)
      if (closing !== null) {
        const parsed = canonicalDecimal(closing[1] ?? '')
        if (parsed.ok) current.closingBalance = parsed.value.value
        const navDate = /nav on ([0-9]{2}-[A-Za-z]{3}-[0-9]{4})/i.exec(text)
        current.closingDate = navDate?.[1] ?? current.closingDate
        continue
      }

      const market = /market value on ([0-9]{2}-[A-Za-z]{3}-[0-9]{4})\s*:?\s*INR\s*([\d,.]+)/i.exec(text)
      if (market !== null) {
        current.closingDate = market[1] ?? current.closingDate
        current.marketValue = market[2] ?? null
        continue
      }

      if (state.bands !== null && startsWithDate(text)) {
        readTransaction(line, state.bands, current, ref, sink)
      } else if (isUnknownSection(text)) {
        sink.issue({
          severity: 'warning',
          code: 'W_UNKNOWN_SECTION',
          message: `skipped an unrecognised section: ${text.slice(0, 60)}`,
          ref,
        })
      }
    }
  }

  closeScheme(state, sink)

  // Accounts are emitted last because capability is only known once every scheme has been
  // checksummed. Nothing downstream depends on record order.
  // Only reachable for a Detailed statement; the Summary path returned above.
  const capability: Capability = !state.nonZeroOpening && !state.anyMismatch ? 'ledger' : 'snapshot'
  if (state.nonZeroOpening) {
    sink.issue({
      severity: 'warning',
      code: 'W_INCOMPLETE_HISTORY',
      message:
        'a scheme opens with a non-zero unit balance, so this statement does not carry the ' +
        'history a cost basis needs. Request it again from 01-01-1990.',
    })
  }

  for (const folio of state.folios.values()) {
    sink.account({
      type: 'account',
      ref: folio.accountKey,
      raw: { folio: folio.folio, amc: folio.amc },
      accountKey: folio.accountKey,
      label: `${folio.amc} · ${folio.folio}`,
      externalRef: folio.folio,
      capability,
      baseCurrency: CURRENCY,
      // Only a document that tried to be a ledger and failed its own checks may pull an existing
      // ledger account down to snapshot.
      ...(capability === 'snapshot' ? { downgradedFrom: 'ledger' as const } : {}),
    })
  }
}

// ---------------------------------------------------------------------------
// Summary statements
// ---------------------------------------------------------------------------

const SUMMARY_LABELS = ['folio', 'isin', 'scheme', 'cost', 'closing', 'balance', 'nav', 'market', 'value', 'registrar']

const AS_ON = /as\s+on\s+([0-9]{2}-[A-Za-z]{3}-[0-9]{4})/i

/**
 * `Consolidated Account Summary`: one row per holding, no transactions, always `snapshot`.
 *
 * Two layout hazards. The folio and the ISIN glue together with no separator at all
 * (`910124242826/0INF846K01859`), which is why the 12-character ISIN shape is the anchor rather
 * than any whitespace rule. And long scheme names wrap into continuation lines that contain only
 * the name column, which are skipped rather than read as holdings with no units.
 */
function extractSummary(pages: readonly PdfPage[], sink: RecordSink): void {
  const asOn = AS_ON.exec(textOf(pages, 2))?.[1] ?? null
  if (asOn !== null) sink.period({ end: asOn, format: DATE_FORMAT, timezone: TIMEZONE })

  let amc: string | null = null
  let bands: readonly ColumnBand[] | null = null
  const folios = new Map<string, FolioContext>()

  for (const page of pages) {
    const headers = findHeaders(page.lines, SUMMARY_LABELS, 4)

    for (let i = 0; i < page.lines.length; i += 1) {
      const line = page.lines[i]
      if (line === undefined) continue
      const header = headers.find((h) => i >= h.firstLine && i <= h.lastLine)
      if (header !== undefined) {
        bands = header.bands
        continue
      }
      const text = collapseWhitespace(normaliseGlyphs(line.text))
      if (text === '') continue

      const nextAmc = matchAmc(text)
      if (nextAmc !== null) {
        amc = nextAmc
        continue
      }
      if (bands === null || amc === null) continue

      const isin = findIsin(text)
      if (isin === null) continue

      const ref = `p.${String(page.pageNumber)} r.${String(i + 1)}`
      const cells = readRow(line, bands)
      const folioCell = cells[bandIndex(bands, ['folio'])] ?? ''
      const folio = collapseWhitespace(folioCell.replace(isin, '')).replace(/\s*\/\s*/, '/')
      if (folio === '') continue

      const context: FolioContext = { amc, folio, accountKey: accountKeyFor(amc, folio) }
      folios.set(context.accountKey, context)

      const quantity = cells[bandIndex(bands, ['closing'])] ?? cells[bandIndex(bands, ['balance'])] ?? ''
      const marketValue = cells[bandIndex(bands, ['market'])] ?? ''
      const navDate = /([0-9]{2}-[A-Za-z]{3}-[0-9]{4})/.exec(text)?.[1] ?? asOn
      const name = collapseWhitespace((cells[bandIndex(bands, ['scheme'])] ?? '').replace(isin, ''))
      if (quantity === '' || navDate === null) {
        sink.skipped(ref, 'a continuation line carrying only the scheme name')
        continue
      }

      sink.position({
        type: 'position',
        ref,
        raw: { folio, isin, name, quantity, marketValue },
        accountKey: context.accountKey,
        instrument: { isin, name, assetClassHint: 'mutual_fund' },
        quantity,
        asOf: navDate,
        dateFormat: DATE_FORMAT,
        timezone: TIMEZONE,
        ...(marketValue !== '' ? { marketValue } : {}),
        currency: CURRENCY,
      })
    }
  }

  for (const folio of folios.values()) {
    sink.account({
      type: 'account',
      ref: folio.accountKey,
      raw: { folio: folio.folio, amc: folio.amc },
      accountKey: folio.accountKey,
      label: `${folio.amc} · ${folio.folio}`,
      externalRef: folio.folio,
      capability: 'snapshot',
      baseCurrency: CURRENCY,
    })
  }
}

// ---------------------------------------------------------------------------
// Section matching
// ---------------------------------------------------------------------------

const AMC_LINE = /^([A-Z][A-Za-z&.'\- ]+(?:Mutual Fund|MF|Asset Management(?: Company)?(?: Limited)?))$/

function matchAmc(text: string): string | null {
  const match = AMC_LINE.exec(text)
  if (match === null) return null
  if (/total|portfolio/i.test(text)) return null
  return match[1] ?? null
}

const FOLIO_LINE = /folio\s*no[.:]?\s*:?\s*([0-9A-Z]+(?:\s*\/\s*[0-9A-Z]+)?)/i

function matchFolio(text: string, amc: string | null): FolioContext | null {
  // A row carrying a date is a gift transaction with a folio number embedded in its description,
  // not a folio header. Observed, and the source of a whole class of phantom accounts.
  if (startsWithDate(text)) return null
  const match = FOLIO_LINE.exec(text)
  if (match === null || amc === null) return null
  const folio = collapseWhitespace(match[1] ?? '').replace(/\s*\/\s*/, '/')
  return { amc, folio, accountKey: accountKeyFor(amc, folio) }
}

/**
 * The realm-qualified identity key.
 *
 * Folio numbers are RTA-scoped rather than globally unique, so the AMC slug is mandatory. The
 * sub-account suffix (`/0`) is preserved: folios differing only in suffix are different accounts.
 */
export function accountKeyFor(amc: string, folio: string): string {
  return `mf-folio:${slug(amc)}:${folio}`
}

export function slug(value: string): string {
  return collapseWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

const SCHEME_LINE = /^([A-Z0-9]+(?:\s[A-Z0-9]+)?)\s*-\s*(.+)$/

function matchScheme(text: string, folio: FolioContext | null, nextLine: string | undefined): SchemeContext | null {
  if (folio === null) return null
  if (!/registrar\s*:/i.test(text) && !/isin/i.test(text)) return null
  const match = SCHEME_LINE.exec(text)
  if (match === null) return null

  const rtaCode = collapseWhitespace(match[1] ?? '')
  let rest = match[2] ?? ''
  const isin = findIsin(rest)

  // The registrar's value frequently wraps onto the next line, and a truncated registrar is not
  // an error worth failing a scheme over.
  const registrarHere = /registrar\s*:\s*(.*)$/i.exec(rest)?.[1]?.trim() ?? ''
  const registrar =
    registrarHere !== ''
      ? registrarHere
      : /registrar\s*:/i.test(rest)
        ? collapseWhitespace(nextLine ?? '')
        : null

  rest = rest
    .replace(/-?\s*ISIN\s*:?\s*[A-Z0-9]{12}/i, '')
    .replace(/\(Advisor\s*:[^)]*\)/i, '')
    .replace(/Registrar\s*:.*$/i, '')
    // Annotations are excised rather than truncated at, because the scheme name continues after
    // them in several templates.
    .replace(/\((?:Demat|Non-Demat|formerly[^)]*|erstwhile[^)]*)\)/gi, '')
  const name = collapseWhitespace(rest).replace(/[-\s]+$/, '')

  return {
    rtaCode,
    name,
    isin,
    registrar: registrar === '' ? null : registrar,
    folio,
    openingBalance: dec('0'),
    openingSeen: false,
    closingBalance: null,
    closingDate: null,
    marketValue: null,
    runningBalance: dec('0'),
    units: [],
    transactions: [],
    balanceMismatch: false,
  }
}

const DATE_AT_START = /^\d{2}-[A-Za-z]{3}-\d{4}\b/

function startsWithDate(text: string): boolean {
  return DATE_AT_START.test(text)
}

const KNOWN_NOISE =
  /(portfolio summary|total|opening unit balance|closing unit balance|market value|nav on|registrar|folio|mutual fund|date|transaction|amount|units|price|nav|unit balance|end of statement|load|exit|advisor|isin|email|mobile|address|pan|kyc|nominee|page)/i

function isUnknownSection(text: string): boolean {
  // The corpus's early-warning system: both families drift year to year — `Stamp Duty` appeared
  // after 2020, `Annualised Return(%)` and `Sovereign Gold Bonds` later still. A parser that
  // silently ignores an unrecognised heading looks correct until the year it is not.
  if (KNOWN_NOISE.test(text)) return false
  return /^[A-Z][A-Z ()%/.-]{9,}$/.test(text)
}

// ---------------------------------------------------------------------------
// Transaction rows
// ---------------------------------------------------------------------------

function readTransaction(
  line: TextLine,
  bands: readonly ColumnBand[],
  scheme: SchemeContext,
  ref: string,
  sink: RecordSink,
): void {
  const cells = readRow(line, bands)
  const dateIndex = bandIndex(bands, ['date'])
  const descriptionIndex = bandIndex(bands, ['transaction'])
  const amountIndex = bandIndex(bands, ['amount'])
  const unitsIndex = bandIndex(bands, ['units'])
  const priceIndex = priceBand(bands)
  const balanceIndex = bandIndex(bands, ['unit', 'balance'])

  const date = cells[dateIndex] ?? ''
  const description = cells[descriptionIndex] ?? ''
  const amount = cells[amountIndex] ?? ''
  const units = cells[unitsIndex] ?? ''
  const price = cells[priceIndex] ?? ''
  const balance = cells[balanceIndex] ?? ''

  const raw: Record<string, string> = { date, description, amount, units, price, balance }

  const unitsParsed = units.trim() === '' ? null : canonicalDecimal(units)
  if (unitsParsed !== null && !unitsParsed.ok) {
    sink.issue({ severity: 'error', code: 'E_NUMERIC_PARSE', message: unitsParsed.reason, ref, raw })
    return
  }
  const sign: UnitsSign =
    unitsParsed === null ? 'none' : unitsParsed.value.value.startsWith('-') ? 'negative' : 'positive'

  const classification = classifyDescription(description, sign, amount.trim() !== '')

  if (classification.kind === 'event') {
    sink.skipped(ref, `non-financial event: ${description}`)
    return
  }

  if (classification.kind === 'levy') {
    // Levies are folded into the trade above them rather than emitted. Under s.55 stamp duty is
    // part of the cost of acquisition, and the purchase amount printed above is already net of it
    // (1,999.90 + 0.10 = 2,000.00). Folding is also what keeps idempotency correct: two SIPs on
    // one day each generate an identical zero-unit levy row, and those would collide.
    const parent = scheme.transactions[scheme.transactions.length - 1]
    if (parent === undefined) {
      sink.skipped(ref, `levy with no trade above it: ${description}`)
      return
    }
    scheme.transactions[scheme.transactions.length - 1] = {
      ...parent,
      fees: { ...parent.fees, [classification.bucket]: amount },
    }
    return
  }

  if (classification.kind === 'unclassified') {
    sink.issue({
      severity: 'error',
      code: 'E_UNCLASSIFIED_TRANSACTION',
      message: `no rule matched ${JSON.stringify(description)}`,
      ref,
      raw,
    })
    return
  }

  // Per-row checksum: the previous balance plus this row's units must equal the printed balance.
  if (unitsParsed !== null && balance.trim() !== '') {
    const printed = canonicalDecimal(balance)
    if (printed.ok) {
      const expected = sumDec([scheme.runningBalance, unitsParsed.value.value])
      if (!withinTolerance(expected, printed.value.value, UNIT_TOLERANCE)) {
        scheme.balanceMismatch = true
        sink.issue({
          severity: 'warning',
          code: 'W_BALANCE_MISMATCH',
          message: `running balance does not reconcile: expected ${expected}, the statement prints ${printed.value.value}`,
          ref,
          raw,
        })
      }
      scheme.runningBalance = printed.value.value
    }
  }
  if (unitsParsed !== null) scheme.units.push(unitsParsed.value.value)

  const common = {
    type: 'transaction' as const,
    ref,
    raw,
    accountKey: scheme.folio.accountKey,
    instrument: instrumentOf(scheme),
    description,
    date,
    dateFormat: DATE_FORMAT,
    timezone: TIMEZONE,
    currency: CURRENCY,
    fees: {},
  }

  if (classification.type === 'dividend' && classification.alsoBuy) {
    // A reinvestment is two facts: income received, and units bought with it. Emitting only the
    // purchase would hide the income at tax time.
    scheme.transactions.push({ ...common, txnType: 'dividend', ...(amount !== '' ? { amount } : {}) })
    scheme.transactions.push({
      ...common,
      txnType: 'buy',
      ...(units !== '' ? { quantity: units } : {}),
      ...(price !== '' ? { price } : {}),
      ...(amount !== '' ? { amount } : {}),
      ...(balance !== '' ? { balanceAfter: balance } : {}),
    })
    return
  }

  scheme.transactions.push({
    ...common,
    txnType: classification.type,
    ...(units !== '' ? { quantity: units } : {}),
    ...(price !== '' ? { price } : {}),
    ...(amount !== '' ? { amount } : {}),
    ...(balance !== '' ? { balanceAfter: balance } : {}),
  })
}

function priceBand(bands: readonly ColumnBand[]): number {
  const price = bandIndex(bands, ['price'])
  return price === -1 ? bandIndex(bands, ['nav']) : price
}

function instrumentOf(scheme: SchemeContext): {
  isin?: string
  providerLocalId?: string
  name: string
  assetClassHint: string
} {
  return {
    ...(scheme.isin !== null ? { isin: scheme.isin } : {}),
    ...(scheme.rtaCode !== '' ? { providerLocalId: scheme.rtaCode } : {}),
    name: scheme.name,
    assetClassHint: 'mutual_fund',
  }
}

// ---------------------------------------------------------------------------
// Closing a scheme
// ---------------------------------------------------------------------------

interface ExtractState {
  scheme: SchemeContext | null
  anyMismatch: boolean
}

function closeScheme(state: ExtractState, sink: RecordSink): void {
  const scheme = state.scheme
  if (scheme === null) return
  state.scheme = null

  // Per-scheme checksum: opening + the sum of every row's units must equal the closing balance.
  if (scheme.closingBalance !== null && scheme.openingSeen) {
    const expected = sumDec([scheme.openingBalance, ...scheme.units])
    if (!withinTolerance(expected, scheme.closingBalance, UNIT_TOLERANCE)) {
      scheme.balanceMismatch = true
      sink.issue({
        severity: 'warning',
        code: 'W_BALANCE_MISMATCH',
        message:
          `${scheme.name}: opening ${scheme.openingBalance} plus transactions is ${expected}, ` +
          `but the closing balance printed is ${scheme.closingBalance} ` +
          `(off by ${subtractDec(expected, scheme.closingBalance)})`,
        ref: scheme.folio.accountKey,
      })
    }
  }

  if (scheme.balanceMismatch) state.anyMismatch = true

  for (const transaction of scheme.transactions) sink.transaction(transaction)

  if (scheme.closingBalance !== null && scheme.closingDate !== null) {
    sink.position({
      type: 'position',
      ref: scheme.folio.accountKey,
      raw: { scheme: scheme.name, balance: scheme.closingBalance },
      accountKey: scheme.folio.accountKey,
      instrument: instrumentOf(scheme),
      quantity: scheme.closingBalance,
      asOf: scheme.closingDate,
      dateFormat: DATE_FORMAT,
      timezone: TIMEZONE,
      ...(scheme.marketValue !== null ? { marketValue: scheme.marketValue } : {}),
      currency: CURRENCY,
    })
  }
}

const PERIOD = /([0-9]{2}-[A-Za-z]{3}-[0-9]{4})\s+to\s+([0-9]{2}-[A-Za-z]{3}-[0-9]{4})/i

function readPeriod(pages: readonly PdfPage[], sink: RecordSink): void {
  const match = PERIOD.exec(textOf(pages, 2))
  if (match === null) return
  sink.period({
    ...(match[1] !== undefined ? { start: match[1] } : {}),
    ...(match[2] !== undefined ? { end: match[2] } : {}),
    format: DATE_FORMAT,
    timezone: TIMEZONE,
  })
}
