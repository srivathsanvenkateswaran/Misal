/**
 * The NSDL depository eCAS.
 *
 * Always `capability = 'snapshot'`, and the reasoning deserves stating because the naive read of
 * the format is the opposite: the file *does* contain a genuine per-ISIN transaction ledger with
 * opening and closing balances. But **each file covers exactly one month.** A cost basis needs
 * history from the account's inception, which would mean a contiguous run of every monthly
 * statement since the demat account was opened, with no gaps — and a missing month is
 * indistinguishable from a dormant one without cross-checking period headers, because half-yearly
 * statements are issued precisely when there were no transactions.
 *
 * So the holdings are ingested and the account stays a snapshot. Positions remain authoritative
 * for it, and the valuation engine must not fold its ledger. Capability is the fold gate as well
 * as the display gate.
 *
 * Coverage is genuinely cross-depository: an NSDL CAS contains the user's CDSL demat accounts as
 * well, plus MF folios fed by the RTAs. Which depository issues the file is decided by whichever
 * demat account was opened earlier, so the UI must accept either.
 */

import type { ExtractPlugin, RecordSink } from '../plugin'
import { collapseWhitespace, containsTokens, findIsin, normaliseGlyphs, undouble } from '../text'
import type { DecodedInput, PdfPage, RawPosition, TextLine } from '../types'
import { bandIndex, bandIndexLast, findHeader, readRow, type ColumnBand } from './table'
import { FolioAmcIndex, amcIssues, mfFolioIdentityKey } from '../amc/identity'

const PROVIDER_ID = 'nsdl-cas'
const TIMEZONE = 'Asia/Kolkata'
const DATE_FORMAT = 'dd-MMM-yyyy'
const CURRENCY = 'INR'

export const nsdlEcasPlugin: ExtractPlugin = {
  id: 'nsdl-ecas',
  providerId: PROVIDER_ID,
  accepts: 'cas-pdf',
  detect,
  extract,
}

function detect(input: DecodedInput): number {
  if (input.kind !== 'pdf-text') return 0
  const info = Object.values(input.meta.info).join(' ')
  // Metadata is checked first because it is unambiguous and survives layout changes.
  if (/NSDL-Consolidated Account Statement|NSDL-CAS Team/i.test(info)) return 0.97
  const text = textOf(input.pages, 2)
  if (/National Securities Depository Limited/i.test(text)) return 0.93
  return /NSDL Consolidated Account Statement/i.test(text) ? 0.9 : 0
}

function textOf(pages: readonly PdfPage[], limit: number): string {
  return pages
    .slice(0, limit)
    .flatMap((page) => page.lines.map((line) => line.text))
    .join('\n')
}

type Section = 'roster' | 'demat-holdings' | 'mf-folios' | null

const ROSTER_ANCHOR = ['your', 'demat', 'account', 'mutual', 'fund', 'folios']
const MF_ANCHOR = ['mutual', 'fund', 'folios']
const DEMAT_HEADER = ['isin', 'stock', 'symbol']
const MF_HEADER = ['folio', 'scheme', 'isin']

const PERIOD = /from\s+([0-9]{2}-[A-Za-z]{3}-[0-9]{4})\s+to\s+([0-9]{2}-[A-Za-z]{3}-[0-9]{4})/i

function extract(input: DecodedInput, sink: RecordSink): void {
  if (input.kind !== 'pdf-text') return
  const pages = input.pages

  const period = PERIOD.exec(textOf(pages, 2))
  const asOf = period?.[2] ?? null
  if (period !== null) {
    sink.period({
      ...(period[1] !== undefined ? { start: period[1] } : {}),
      ...(period[2] !== undefined ? { end: period[2] } : {}),
      format: DATE_FORMAT,
      timezone: TIMEZONE,
    })
  }

  let section: Section = null
  let bands: readonly ColumnBand[] | null = null
  const accounts = new Map<string, { key: string; label: string; externalRef: string }>()
  const folioAmc = new Map<string, string>()
  // Folio identity is deferred to the end of the document for the same reason it is in the CAMS
  // parser: the roster prints the fund house's name and the holdings table prints the ISIN, and
  // the ISIN is the identifier that does not change between statements. Keying at the roster line
  // would key on the name alone, which is where one folio became two accounts.
  const index = new FolioAmcIndex()
  const folioPositions: { folio: string; record: Omit<RawPosition, 'accountKey'> }[] = []

  for (const page of pages) {
    for (let i = 0; i < page.lines.length; i += 1) {
      const line = page.lines[i]
      if (line === undefined) continue
      const text = collapseWhitespace(normaliseGlyphs(line.text))
      if (text === '') continue
      const ref = `p.${String(page.pageNumber)} r.${String(i + 1)}`

      if (containsTokens(text, ROSTER_ANCHOR)) {
        section = 'roster'
        bands = null
        continue
      }
      if (containsTokens(text, MF_ANCHOR)) {
        section = 'mf-folios'
        bands = null
        continue
      }
      if (containsTokens(text, DEMAT_HEADER)) {
        section = 'demat-holdings'
        bands = findHeader([line], DEMAT_HEADER, 3)?.bands ?? null
        continue
      }
      if (section === 'roster' && containsTokens(text, ['dp', 'id']) && bands === null) {
        bands = findHeader([line], ['dp', 'id', 'client', 'folio'], 2)?.bands ?? null
        continue
      }
      if (section === 'mf-folios' && containsTokens(text, MF_HEADER) && bands === null) {
        bands = findHeader([line], MF_HEADER, 3)?.bands ?? null
        continue
      }

      if (bands === null || section === null) {
        if (isUnknownHeading(text)) {
          sink.issue({
            severity: 'warning',
            code: 'W_UNKNOWN_SECTION',
            message: `skipped an unrecognised section: ${text.slice(0, 60)}`,
            ref,
          })
        }
        continue
      }

      if (section === 'roster') {
        readRoster(line, bands, accounts, folioAmc, index)
        continue
      }

      if (section === 'demat-holdings') {
        readDematHolding(line, bands, accounts, asOf, ref, sink)
        continue
      }

      readMfFolio(line, bands, folioAmc, index, asOf, ref, folioPositions)
    }
  }

  for (const account of accounts.values()) {
    sink.account({
      type: 'account',
      ref: account.key,
      raw: { identity: account.key },
      accountKey: account.key,
      label: account.label,
      externalRef: account.externalRef,
      capability: 'snapshot',
      baseCurrency: CURRENCY,
    })
  }

  for (const [folio, amc] of folioAmc) {
    const resolution = index.resolve(amc, folio)
    const key = mfFolioIdentityKey(resolution, folio)
    for (const issue of amcIssues(resolution, folio, key)) sink.issue(issue)
    sink.account({
      type: 'account',
      ref: key,
      raw: { identity: key, folio, amc },
      accountKey: key,
      label: `${resolution.kind === 'canonical' ? resolution.canonicalName : amc} · ${folio}`,
      externalRef: folio,
      capability: 'snapshot',
      baseCurrency: CURRENCY,
    })
  }

  for (const held of folioPositions) {
    const amc = folioAmc.get(held.folio)
    if (amc === undefined) continue
    sink.position({ ...held.record, accountKey: index.identityKey(amc, held.folio) })
  }
}

function readRoster(
  line: TextLine,
  bands: readonly ColumnBand[],
  accounts: Map<string, { key: string; label: string; externalRef: string }>,
  folioAmc: Map<string, string>,
  index: FolioAmcIndex,
): void {
  const cells = readRow(line, bands)
  const dpName = cells[bandIndex(bands, ['dp', 'name'])] ?? ''
  // CDSL BO IDs are the concatenation of DP ID and client ID and are rendered doubled by bold
  // text; de-doubling before use is what makes the two shapes converge on one key.
  const dpId = undouble((cells[bandIndex(bands, ['dp', 'id'])] ?? '').trim())
  const clientId = undouble((cells[bandIndex(bands, ['client', 'id'])] ?? '').trim())
  const folio = collapseWhitespace(cells[bandIndex(bands, ['folio'])] ?? '').replace(/\s*\/\s*/, '/')

  if (dpId !== '' && clientId !== '') {
    const key = `demat:${dpId}-${clientId}`
    accounts.set(key, { key, label: `${dpName} · ${dpId}-${clientId}`, externalRef: `${dpId}-${clientId}` })
    return
  }
  if (folio !== '' && dpName !== '') {
    // The roster's DP Name column carries the fund house for a folio line. It is evidence, not an
    // identity: the account row is emitted once the holdings table has contributed its ISINs.
    folioAmc.set(folio, dpName)
    index.observeName(dpName, folio)
  }
}

function readDematHolding(
  line: TextLine,
  bands: readonly ColumnBand[],
  accounts: Map<string, { key: string }>,
  asOf: string | null,
  ref: string,
  sink: RecordSink,
): void {
  const isin = findIsin(line.text)
  if (isin === null || asOf === null) return
  const cells = readRow(line, bands)
  const identifier = cells[bandIndex(bands, ['isin'])] ?? ''
  const name = cells[bandIndex(bands, ['company', 'name'])] ?? ''
  const quantity = cells[bandIndex(bands, ['shares'])] ?? ''
  const value = cells[bandIndexLast(bands, ['value'])] ?? ''
  if (quantity === '') return

  // The ISIN cell carries the exchange symbol on its second line (`AXISBANK.NSE`) or the literal
  // `NOT LISTED`. A free exchange alias, and the only one this document offers.
  const symbol = /\b([A-Z0-9&-]{1,20})\.(NSE|BSE)\b/.exec(identifier)
  const account = [...accounts.values()].find((a) => a.key.startsWith('demat:'))
  if (account === undefined) return

  sink.position({
    type: 'position',
    ref,
    raw: { isin, name, quantity, value },
    accountKey: account.key,
    instrument: {
      isin,
      ...(symbol?.[1] !== undefined ? { symbol: symbol[1] } : {}),
      ...(symbol?.[2] === 'NSE' ? { exchange: 'NSE' as const } : {}),
      ...(symbol?.[2] === 'BSE' ? { exchange: 'BSE' as const } : {}),
      name,
      assetClassHint: 'indian_equity',
    },
    quantity,
    asOf,
    dateFormat: DATE_FORMAT,
    timezone: TIMEZONE,
    ...(value !== '' ? { marketValue: value } : {}),
    currency: CURRENCY,
  })
}

/**
 * The MF folios table carries `Average Cost Per Units`, `Total Cost` and `Annualised Return(%)`.
 * Misal ingests units and value and **does not import the statement's cost or return figures**:
 * the valuation engine computes those, and two sources of truth for one number is how a net-worth
 * tool starts disagreeing with itself.
 */
function readMfFolio(
  line: TextLine,
  bands: readonly ColumnBand[],
  folioAmc: Map<string, string>,
  index: FolioAmcIndex,
  asOf: string | null,
  ref: string,
  out: { folio: string; record: Omit<RawPosition, 'accountKey'> }[],
): void {
  const isin = findIsin(line.text)
  if (isin === null || asOf === null) return
  const cells = readRow(line, bands)
  const folio = collapseWhitespace(cells[bandIndex(bands, ['folio'])] ?? '').replace(/\s*\/\s*/, '/')
  const name = cells[bandIndex(bands, ['scheme'])] ?? ''
  const quantity = cells[bandIndex(bands, ['closing'])] ?? cells[bandIndex(bands, ['balance'])] ?? ''
  const value = cells[bandIndexLast(bands, ['value'])] ?? ''
  const amc = folioAmc.get(folio)
  if (folio === '' || quantity === '' || amc === undefined) return

  // The strongest AMC identifier this document prints for a folio, and the only one shared with
  // the registrar's own statement.
  index.observeIsin(amc, folio, isin)

  out.push({
    folio,
    record: {
      type: 'position',
      ref,
      raw: { folio, isin, name, quantity, value },
      instrument: { isin, name, assetClassHint: 'mutual_fund' },
      quantity,
      asOf,
      dateFormat: DATE_FORMAT,
      timezone: TIMEZONE,
      ...(value !== '' ? { marketValue: value } : {}),
      currency: CURRENCY,
    },
  })
}

const KNOWN_HEADINGS =
  /(portfolio composition|statement|about nsdl|page|transactions|for the period|no transaction recorded|holding|summary|value|isin|folio|account|nsdl|cdsl|note)/i

function isUnknownHeading(text: string): boolean {
  if (KNOWN_HEADINGS.test(text)) return false
  return /^[A-Z][A-Z ()%/.-]{9,}$/.test(text)
}
