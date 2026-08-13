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
 *
 * Document nesting, in the order it appears:
 *
 *     header block ─ period 'from 01-Mar-2025 to 31-Mar-2025'
 *     Your Demat Account and Mutual Fund Folios          ─ the roster, one row per account
 *       'NSDL Demat Account' | <participant> | <dp id> | <client id>
 *       'Mutual Fund Folio'  | <fund house>  |         |           | <folio>
 *     per-account block, repeated
 *       'NSDL Demat Account'                            ─ or 'CDSL Demat Account'
 *       <participant name>                              ─ unlabelled
 *       'DP ID : IN300394   Client ID : 12345678'
 *       'ACCOUNT HOLDER' / <holder> (PAN: …)
 *         holdings column header
 *         holding rows                                  ─ continuing over page breaks
 *     Mutual Fund Folios (F)
 *       folio rows
 *
 * **The per-account block is the whole point of this parser's structure.** One file routinely
 * carries several demat accounts — a broker account and a bank account under one PAN is entirely
 * ordinary — and a holding means nothing without the account it was printed under. Attributing
 * them all to the first account in the file is not merely a reporting error: `position` is unique
 * on `(account_id, instrument_id, as_of)`, so one ISIN held in two accounts collides and one
 * holding silently restates the other. See `emitDematPositions` for what happens when the document
 * does not say.
 *
 * **The roster's folio lines carry the same hazard one level down.** A folio number is issued by a
 * registrar, not by the market, so the same number appears under two fund houses in one file; the
 * house is therefore part of the folio's identity rather than a label on it. See `FolioRoster` and
 * `emitFolioRecords`.
 */

import type { RawIssue } from '../issues'
import type { ExtractPlugin, RecordSink } from '../plugin'
import { collapseWhitespace, containsTokens, findIsin, normaliseGlyphs, undouble } from '../text'
import type { DecodedInput, PdfPage, RawPosition, TextLine } from '../types'
import { bandIndex, bandIndexLast, findHeader, readRow, type ColumnBand } from './table'
import {
  FolioAmcIndex,
  amcIssues,
  mfFolioIdentityKey,
  resolveAmc,
  type AmcResolution,
} from '../amc/identity'

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

/** A demat account, however the document introduced it. */
interface DematAccount {
  readonly key: string
  readonly label: string
  readonly externalRef: string
}

/** A holding read out of a table, held until the document has said which account owns it. */
interface HeldPosition {
  /** The account whose section this row was printed under, or null when none was in scope. */
  readonly accountKey: string | null
  readonly ref: string
  readonly record: Omit<RawPosition, 'accountKey'>
}

/**
 * One roster line's claim on a folio number, by one fund house.
 *
 * A folio number is *not* the claim: folio numbers are RTA-scoped rather than globally unique, so
 * two houses issuing `12345678` are two accounts and the pair (house, number) is the smallest thing
 * that identifies one of them. See `FolioAmcIndex.scope`, which is the same scoping this uses.
 */
interface FolioClaim {
  /** `FolioAmcIndex.scope(amc, folio)` — house and number together. */
  readonly scope: string
  readonly folio: string
  /** The fund house as the roster printed it. Evidence, never an identity. */
  readonly amc: string
  readonly ref: string
}

/** A scheme row, held until the document has said whose folio it is. */
interface HeldFolioRow {
  readonly folio: string
  readonly isin: string
  readonly ref: string
  readonly record: Omit<RawPosition, 'accountKey'>
}

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
  const accounts = new Map<string, DematAccount>()
  // Every (house, folio) the roster declared. Keyed on the pair rather than on the number, because
  // a map from folio number to house is last-writer-wins and silently merges two houses' folios
  // into one account; see `FolioRoster`.
  const roster = new FolioRoster()
  // Which demat account the reader is currently inside. Holdings are attributed to *this*, never
  // to whichever account the roster happened to declare first; see `DematSectionReader`.
  const demat = new DematSectionReader()
  const dematPositions: HeldPosition[] = []
  // Folio identity is deferred to the end of the document for the same reason it is in the CAMS
  // parser: the roster prints the fund house's name and the holdings table prints the ISIN, and
  // the ISIN is the identifier that does not change between statements. Keying at the roster line
  // would key on the name alone, which is where one folio became two accounts.
  const index = new FolioAmcIndex()
  const folioRows: HeldFolioRow[] = []

  for (const page of pages) {
    for (let i = 0; i < page.lines.length; i += 1) {
      const line = page.lines[i]
      if (line === undefined) continue
      const text = collapseWhitespace(normaliseGlyphs(line.text))
      if (text === '') continue
      const ref = `p.${String(page.pageNumber)} r.${String(i + 1)}`

      // Read before the section anchors, because the account header block sits between the end of
      // one holdings table and the header of the next, where no anchor fires.
      if (demat.read(text, accounts)) continue

      if (containsTokens(text, ROSTER_ANCHOR)) {
        section = 'roster'
        bands = null
        demat.leave()
        continue
      }
      if (containsTokens(text, MF_ANCHOR)) {
        section = 'mf-folios'
        bands = null
        demat.leave()
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
        readRoster(line, bands, accounts, roster, index, ref)
        continue
      }

      if (section === 'demat-holdings') {
        readDematHolding(line, bands, demat.current(), asOf, ref, dematPositions)
        continue
      }

      readMfFolio(line, bands, asOf, ref, folioRows)
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

  emitDematPositions(dematPositions, accounts, demat.sawAnyHeader(), sink)
  emitFolioRecords(roster, folioRows, index, sink)
}

function readRoster(
  line: TextLine,
  bands: readonly ColumnBand[],
  accounts: Map<string, DematAccount>,
  roster: FolioRoster,
  index: FolioAmcIndex,
  ref: string,
): void {
  const cells = readRow(line, bands)
  const dpName = cells[bandIndex(bands, ['dp', 'name'])] ?? ''
  // CDSL BO IDs are the concatenation of DP ID and client ID and are rendered doubled by bold
  // text; de-doubling before use is what makes the two shapes converge on one key.
  const dpId = undouble((cells[bandIndex(bands, ['dp', 'id'])] ?? '').trim())
  const clientId = undouble((cells[bandIndex(bands, ['client', 'id'])] ?? '').trim())
  const folio = collapseWhitespace(cells[bandIndex(bands, ['folio'])] ?? '').replace(/\s*\/\s*/, '/')

  const identity = dematIdentity(dpId, clientId)
  if (identity !== null) {
    register(accounts, identity, dpName)
    return
  }
  if (folio !== '' && dpName !== '') {
    // The roster's DP Name column carries the fund house for a folio line. It is evidence, not an
    // identity: the account row is emitted once the holdings table has contributed its ISINs. The
    // claim is recorded against the *pair*, so a second house naming the same number does not
    // overwrite the first.
    roster.claim(dpName, folio, ref)
    index.observeName(dpName, folio)
  }
}

/**
 * One row of a demat holdings table, tagged with the account whose section it was printed under.
 *
 * The row is *held* rather than emitted, because whether the attribution is trustworthy is a
 * property of the whole document rather than of this line: see `emitDematPositions`.
 */
function readDematHolding(
  line: TextLine,
  bands: readonly ColumnBand[],
  accountKey: string | null,
  asOf: string | null,
  ref: string,
  out: HeldPosition[],
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

  out.push({
    accountKey,
    ref,
    record: {
      type: 'position',
      ref,
      raw: { isin, name, quantity, value },
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
    },
  })
}

/**
 * Attribute the held rows, and fail the ones that cannot be attributed.
 *
 * The rule is deliberately narrow, because the bug being fixed here was a wide one: every holding
 * in the file was attributed to `accounts.values().find(a => a.key.startsWith('demat:'))`, the
 * first demat account the roster declared. With two accounts that silently moves every share into
 * one of them, and where the same ISIN is genuinely held in both, the two rows collide on
 * `position`'s `UNIQUE (account_id, instrument_id, as_of)` and one restates the other — units gone,
 * no error, a smaller number.
 *
 * So a row is emitted only when the document actually said which account it belongs to:
 *
 *   1. **A section header was in scope.** The holdings pages are grouped under a per-account block
 *      naming the participant and the client — `DP ID : IN300394  Client ID : 12345678`. That is
 *      the attribution, and it is the document's own statement of it.
 *   2. **The document declares exactly one demat account and prints no such header at all.** Then
 *      there is only one account the row can belong to, and that is a deduction rather than a
 *      guess. It is narrowed by `sawAnyHeader`: once this template has been observed printing
 *      account headers, a holdings block without one is a hole in the parse, not a template that
 *      omits them, and the rows fail rather than falling back.
 *   3. **Otherwise the row fails**, naming the accounts it might have belonged to. A visible gap is
 *      recoverable; a plausible wrong attribution is what this fix exists to remove.
 */
function emitDematPositions(
  held: readonly HeldPosition[],
  accounts: ReadonlyMap<string, DematAccount>,
  sawAnyHeader: boolean,
  sink: RecordSink,
): void {
  const declared = [...accounts.keys()].filter((key) => key.startsWith('demat:'))
  const sole = declared.length === 1 ? declared[0] : undefined
  const soleUnambiguous = !sawAnyHeader && sole !== undefined ? sole : null

  for (const position of held) {
    const accountKey = position.accountKey ?? soleUnambiguous
    if (accountKey === null) {
      sink.issue({
        severity: 'error',
        code: 'E_MISSING_REQUIRED_FIELD',
        message:
          `this holding is not printed under any demat account header Misal could read, and the ` +
          `statement declares ${String(declared.length)} demat account(s), so which one holds it ` +
          `cannot be decided. It was left out rather than attributed to a guess.`,
        ref: position.ref,
        raw: position.record.raw,
      })
      continue
    }
    sink.position({ ...position.record, accountKey })
  }
}

// ---------------------------------------------------------------------------
// Demat account sections
// ---------------------------------------------------------------------------

/**
 * The identity key for a demat account, from whichever pair of identifiers was printed.
 *
 * An NSDL CAS states every account, its own and the CDSL ones it also covers, as a DP ID and a
 * client ID; the two depositories differ only in that an NSDL DP ID is `IN` plus six characters
 * where a CDSL one is eight digits. The 16-digit BO ID — the DP ID and client ID concatenated — is
 * the *CDSL-issued* CAS's convention, and it is accepted here so that a template printing it
 * resolves to the same realm-qualified key rather than being dropped on the floor, which is what
 * used to happen and lost the account entirely.
 */
function dematIdentity(dpId: string, clientId: string): { key: string; externalRef: string } | null {
  const dp = dpId.trim().toUpperCase()
  const client = clientId.trim().toUpperCase()
  if (BO_ID_VALUE.test(dp) && client === '') return { key: `demat:bo:${dp}`, externalRef: dp }
  if (dp === '' && BO_ID_VALUE.test(client)) return { key: `demat:bo:${client}`, externalRef: client }
  if (DP_ID_VALUE.test(dp) && CLIENT_ID_VALUE.test(client)) {
    return { key: `demat:${dp}-${client}`, externalRef: `${dp}-${client}` }
  }
  return null
}

function register(
  accounts: Map<string, DematAccount>,
  identity: { key: string; externalRef: string },
  dpName: string,
): void {
  const name = collapseWhitespace(dpName)
  const existing = accounts.get(identity.key)
  // First naming wins, which means the roster's: it is read before the detail pages and its DP
  // Name is a clean column, where a detail header shares its line with the account holders in the
  // joint-holding layout. A repeat that names nothing must never blank a label already given.
  if (existing !== undefined && (name === '' || existing.label !== identity.externalRef)) return
  accounts.set(identity.key, {
    key: identity.key,
    label: name === '' ? identity.externalRef : `${name} · ${identity.externalRef}`,
    externalRef: identity.externalRef,
  })
}

/**
 * A DP ID is eight characters: `IN` plus six for an NSDL participant, eight digits for a CDSL one.
 *
 * The CDSL shape matters here even though this is the NSDL parser: an NSDL CAS carries the
 * investor's CDSL accounts too, and it prints them in NSDL's own `DP Id`/`Client Id` form rather
 * than as the 16-digit BO ID that a CDSL-issued CAS uses. Rejecting the all-numeric form would
 * drop every CDSL account in the file.
 */
const DP_ID_VALUE = /^(?:IN[0-9A-Z]{6}|[0-9]{8})$/
const CLIENT_ID_VALUE = /^[0-9A-Z]{8}$/
const BO_ID_VALUE = /^[0-9]{16}$/

/**
 * The per-account header block, in the shapes these templates print.
 *
 * The block that introduces one account's holdings reads, over two to four physical lines:
 *
 *     NSDL Demat Account
 *     EXAMPLE SECURITIES PRIVATE LIMITED
 *     DP ID : IN300394        Client ID : 12345678
 *     ACCOUNT HOLDER
 *     A N INVESTOR (PAN: AAAAA0000A)
 *
 * The broker's name is an unlabelled cell, so it cannot be matched on a label; it is taken as the
 * line following the account-type line. `DP Name :` is the *CDSL*-issued CAS's label rather than
 * this document's, and is accepted only because it costs nothing and a mixed template would
 * otherwise lose the name.
 *
 * The identifier labels tolerate a missing colon, because the observed spacing varies, but their
 * value patterns are strict: a labelled identifier followed by a value of exactly the right shape
 * is what separates a header from the numbered notes at the back of the statement, which mention
 * "demat account" in prose and would otherwise open a phantom section.
 */
const ACCOUNT_TYPE_LINE = /^(?:NSDL|CDSL)\s+Demat\s+Account\s*$/i
const DP_ID_LABEL = /\bDP\s*ID\s*[:-]?\s*([A-Z0-9]{8})\b/i
const CLIENT_ID_LABEL = /\bClient\s*ID\s*[:-]?\s*([0-9A-Z]{8})\b/i
const BO_ID_LABEL = /\bBO\s*ID\s*[:-]?\s*([0-9]{16})\b/i
const DP_NAME_LABEL = /\bDP\s*Name\s*[:-]\s*(.+)$/i

/** Prose is not a header. The notes at the back of the statement are far longer than this. */
const HEADER_LINE_LIMIT = 200

/** A participant's name: letters and name punctuation, no amounts. */
const BROKER_NAME = /^[A-Za-z][A-Za-z0-9&.,'()\- ]*$/

/**
 * Which demat account the reader is inside.
 *
 * The DP ID and the client ID are frequently on separate physical lines, and the participant's
 * name on a third, so the block is assembled across lines rather than matched as one. A fresh
 * `DP ID` always closes whatever was open: a second one means a second account's section has
 * begun, and carrying the previous account past it is the failure this class of bug is made of.
 *
 * Context deliberately survives a page break. One account's holdings run over several pages under
 * a repeated *column* header with no repeated account header, so resetting per page would orphan
 * every continuation row.
 */
class DematSectionReader {
  private key: string | null = null
  private pendingDpId: string | null = null
  private pendingName = ''
  private expectName = false
  private seenHeader = false

  current(): string | null {
    return this.key
  }

  /** True once any account header has been read, anywhere in the document. */
  sawAnyHeader(): boolean {
    return this.seenHeader
  }

  /** Leave the current account's section — a roster or a mutual fund block is not inside one. */
  leave(): void {
    this.key = null
    this.pendingDpId = null
    this.pendingName = ''
    this.expectName = false
  }

  /**
   * Consume `text` if it is part of an account header block. Returns true when it was.
   *
   * The raw line is tried before the de-doubled one so that a document with no bold doubling is
   * never mangled by the repair. A `false` return leaves the reader untouched, which is what makes
   * the second attempt safe.
   */
  read(text: string, accounts: Map<string, DematAccount>): boolean {
    if (this.attempt(text, accounts)) return true
    const repaired = undoubled(text)
    return repaired !== text && this.attempt(repaired, accounts)
  }

  private attempt(line: string, accounts: Map<string, DematAccount>): boolean {
    if (line.length > HEADER_LINE_LIMIT) return false

    if (ACCOUNT_TYPE_LINE.test(line)) {
      // `NSDL Demat Account` opens a block and closes whatever preceded it. The participant's name
      // is the next line, unlabelled.
      this.key = null
      this.pendingDpId = null
      this.pendingName = ''
      this.expectName = true
      return true
    }

    const labelled = DP_NAME_LABEL.exec(line)?.[1]
    const printedName = labelled === undefined ? null : collapseWhitespace(stripLabels(labelled))

    const bo = BO_ID_LABEL.exec(line)?.[1]
    if (bo !== undefined) {
      this.open(dematIdentity(bo, ''), accounts, printedName ?? this.pendingName)
      return true
    }

    const dp = DP_ID_LABEL.exec(line)?.[1]
    const client = CLIENT_ID_LABEL.exec(line)?.[1]

    if (dp !== undefined) {
      this.key = null
      this.pendingDpId = dp.toUpperCase()
      this.expectName = false
      if (printedName !== null) this.pendingName = printedName
    } else if (printedName !== null) {
      this.pendingName = printedName
      this.expectName = false
      return true
    } else if (this.expectName) {
      this.expectName = false
      const bare = collapseWhitespace(stripHolder(line))
      if (bare !== '' && BROKER_NAME.test(bare)) {
        this.pendingName = bare
        return true
      }
      return false
    }

    if (client !== undefined && this.pendingDpId !== null) {
      this.open(dematIdentity(this.pendingDpId, client), accounts, this.pendingName)
      return true
    }
    return dp !== undefined
  }

  private open(
    identity: { key: string; externalRef: string } | null,
    accounts: Map<string, DematAccount>,
    dpName: string,
  ): void {
    if (identity === null) return
    this.seenHeader = true
    this.key = identity.key
    this.pendingDpId = null
    this.pendingName = ''
    this.expectName = false
    // A header may introduce an account the roster never listed. Registering it here is what stops
    // a holding being read against an account that no `RawAccount` record declares.
    register(accounts, identity, dpName)
  }
}

/** Everything after the DP name and before the next label on the same physical line. */
function stripLabels(text: string): string {
  return stripHolder(text.replace(/\b(?:DP|Client|BO)\s*ID\s*[:-].*$/i, '')).replace(/\s*[|·]\s*$/, '')
}

/**
 * Drop the account-holder column that shares the line in the joint-holding layout.
 *
 * A joint account prints `ACCOUNT HOLDERS` beside the account-type line and one holder per line
 * beside the participant's name and identifiers, so the reconstructed line carries both columns.
 * The holder's name is a person's, and it does not belong in an account label.
 */
function stripHolder(text: string): string {
  return text.replace(/\s*\(?\s*PAN\s*[:.].*$/i, '').replace(/\s*ACCOUNT\s+HOLDERS?\b.*$/i, '')
}

/**
 * The line with every token de-doubled, when de-doubling changes anything.
 *
 * Both depositories draw the account header in bold, and bold rendering doubles glyphs, so
 * `DP ID : IN300394` extracts as `DDPP IIDD :: IINN330000339944`. Matching the raw line first means
 * a legitimately paired string is never mangled on a document that has no doubling.
 */
function undoubled(text: string): string {
  return text
    .split(' ')
    .map((token) => undouble(token))
    .join(' ')
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
  asOf: string | null,
  ref: string,
  out: HeldFolioRow[],
): void {
  const isin = findIsin(line.text)
  if (isin === null || asOf === null) return
  const cells = readRow(line, bands)
  const folio = collapseWhitespace(cells[bandIndex(bands, ['folio'])] ?? '').replace(/\s*\/\s*/, '/')
  const name = cells[bandIndex(bands, ['scheme'])] ?? ''
  const quantity = cells[bandIndex(bands, ['closing'])] ?? cells[bandIndex(bands, ['balance'])] ?? ''
  const value = cells[bandIndexLast(bands, ['value'])] ?? ''
  if (folio === '' || quantity === '') return

  // The row is *held* rather than attributed here. Which house's folio this number is cannot be
  // decided from the number alone — see `attribute` — and the ISIN this row carries is the evidence
  // that decides it, so nothing is filed into the AMC index until every roster claim is known.
  out.push({
    folio,
    isin,
    ref,
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

// ---------------------------------------------------------------------------
// Mutual fund folios
// ---------------------------------------------------------------------------

/**
 * Every (fund house, folio number) the roster declared, in the order it declared them.
 *
 * The map this replaces was `folio number → house`, and it was last-writer-wins. A folio number is
 * RTA-scoped rather than globally unique, so `12345678` under HDFC and `12345678` under SBI are two
 * accounts that a real statement can and does print together; the old map kept the second and lost
 * the first, then filed **both** houses' schemes into the surviving house's evidence bucket, where
 * `resolveAmc` handed the account to whichever ISIN issuer prefix happened to print first. One folio
 * got no account at all, and its units were reported against the other house.
 *
 * That the units then reappear under their own house when the registrar's own CAS is imported is
 * what makes it a money bug rather than a labelling one: `derivePositions` works per
 * `(accountId, instrumentId)`, so the misfiled copy and the correct one are both counted.
 *
 * Claims are keyed on `FolioAmcIndex.scope`, so two spellings of one house are one claim — the
 * lookup key reduces "HDFC Mutual Fund" and "HDFC Asset Management Company Limited" alike — while
 * two genuinely different houses stay two.
 */
class FolioRoster {
  private readonly claims = new Map<string, FolioClaim>()
  private readonly byNumber = new Map<string, FolioClaim[]>()

  /** Record that `amc` claims `folio`. Repeating a claim is not a second claim. */
  claim(amc: string, folio: string, ref: string): void {
    const scope = FolioAmcIndex.scope(amc, folio)
    if (this.claims.has(scope)) return
    const claim: FolioClaim = { scope, folio, amc, ref }
    this.claims.set(scope, claim)
    const siblings = this.byNumber.get(folio)
    if (siblings === undefined) this.byNumber.set(folio, [claim])
    else siblings.push(claim)
  }

  /** Every house that claimed this folio number. More than one is legal, and is the hard case. */
  claimants(folio: string): readonly FolioClaim[] {
    return this.byNumber.get(folio) ?? []
  }

  all(): readonly FolioClaim[] {
    return [...this.claims.values()]
  }

  /** The folio numbers more than one house claimed, in document order. */
  contested(): readonly (readonly FolioClaim[])[] {
    return [...this.byNumber.values()].filter((claims) => claims.length > 1)
  }
}

/**
 * Emit one account per (house, folio), and each scheme row against the house that issued its ISIN.
 *
 * The attribution rule is the same shape as `emitDematPositions`', and for the same reason: a row
 * is filed only where the document *said* it goes.
 *
 *   1. **One house claimed the number.** The roster's own statement of ownership, and the ordinary
 *      case. The ISIN still decides the account's identity — `resolveAmc` prefers it to the printed
 *      name — so a roster that misnames the house is corrected rather than believed.
 *   2. **Several houses claimed it.** Then the folio number identifies nothing on its own, and the
 *      row is attributed by *its own* ISIN issuer prefix: the one identifier on the row that names
 *      a fund house without depending on which roster line printed last.
 *   3. **Otherwise the row fails**, naming the houses it might have belonged to. An ISIN whose
 *      issuer is not in the registry cannot break a tie between two houses, and neither can an ISIN
 *      that matches none of the claimants — a plausible wrong answer here is a doubled holding.
 */
function emitFolioRecords(
  roster: FolioRoster,
  rows: readonly HeldFolioRow[],
  index: FolioAmcIndex,
  sink: RecordSink,
): void {
  for (const claims of roster.contested()) sink.issue(sharedFolioIssue(claims))

  const attributed: { claim: FolioClaim; record: Omit<RawPosition, 'accountKey'> }[] = []
  for (const row of rows) {
    const claimants = roster.claimants(row.folio)
    const claim = attribute(claimants, row.isin)
    if (claim === null) {
      sink.issue(unattributedRowIssue(row, claimants))
      continue
    }
    // The strongest AMC identifier this document prints for a folio, and the only one shared with
    // the registrar's own statement. It is filed under the claim this row was attributed to, so a
    // contested number does not pool two houses' ISINs into one bucket.
    index.observeIsin(claim.amc, claim.folio, row.isin)
    attributed.push({ claim, record: row.record })
  }

  // Two spellings of one house reduce to one claim, but two claims can still resolve to one
  // identity — a former name and a current one, say — and one account must not be emitted twice.
  const emitted = new Set<string>()
  for (const claim of roster.all()) {
    const resolution = index.resolve(claim.amc, claim.folio)
    const key = mfFolioIdentityKey(resolution, claim.folio)
    if (emitted.has(key)) continue
    emitted.add(key)
    for (const issue of amcIssues(resolution, claim.folio, key)) sink.issue(issue)
    sink.account({
      type: 'account',
      ref: key,
      raw: { identity: key, folio: claim.folio, amc: claim.amc },
      accountKey: key,
      label: `${resolution.kind === 'canonical' ? resolution.canonicalName : claim.amc} · ${claim.folio}`,
      externalRef: claim.folio,
      capability: 'snapshot',
      baseCurrency: CURRENCY,
    })
  }

  for (const held of attributed) {
    sink.position({
      ...held.record,
      accountKey: index.identityKey(held.claim.amc, held.claim.folio),
    })
  }
}

/** Which claimant owns this scheme row, or null when the document does not say. */
function attribute(claimants: readonly FolioClaim[], isin: string): FolioClaim | null {
  if (claimants.length === 0) return null
  if (claimants.length === 1) return claimants[0] ?? null
  const issuer = houseOf(resolveAmc({ printedNames: [], isins: [isin] }))
  if (issuer === null) return null
  // Several claimants can name one house — a rename, printed both ways — and they resolve to one
  // identity key, so the first is as good as any. Zero matches is a gap, never a guess.
  const owner = claimants.find(
    (claim) => houseOf(resolveAmc({ printedNames: [claim.amc], isins: [] })) === issuer,
  )
  return owner ?? null
}

/** The registry id a resolution names, or null when it named no house the registry knows. */
function houseOf(resolution: AmcResolution): string | null {
  return resolution.kind === 'canonical' ? resolution.amcId : null
}

function sharedFolioIssue(claims: readonly FolioClaim[]): RawIssue {
  const houses = claims.map((claim) => `"${claim.amc}"`).join(', ')
  return {
    severity: 'warning',
    code: 'W_FOLIO_NUMBER_SHARED',
    message:
      `folio number ${claims[0]?.folio ?? ''} is listed under ${String(claims.length)} fund ` +
      `houses in this statement (${houses}). Folio numbers are issued per registrar, not ` +
      `globally, so these are separate accounts and each scheme was attributed to the house that ` +
      `issued its ISIN.`,
    ref: claims.map((claim) => claim.ref).join(', '),
  }
}

function unattributedRowIssue(row: HeldFolioRow, claimants: readonly FolioClaim[]): RawIssue {
  const houses = claimants.map((claim) => `"${claim.amc}"`).join(', ')
  const because =
    claimants.length === 0
      ? `no fund house in this statement's roster claims folio ${row.folio}`
      : `folio ${row.folio} is claimed by ${houses}, and this scheme's ISIN (${row.isin}) does ` +
        `not identify which of them issued it`
  return {
    severity: 'error',
    code: 'E_MISSING_REQUIRED_FIELD',
    message:
      `${because}, so which account holds this scheme cannot be decided. It was left out rather ` +
      `than attributed to a guess: folio numbers are registrar-scoped, and attributing units to ` +
      `the wrong house double-counts them once that house's own statement is imported.`,
    ref: row.ref,
    // Replayable: the import report has to be able to show the user the row it dropped.
    raw: row.record.raw,
  }
}

const KNOWN_HEADINGS =
  /(portfolio composition|statement|about nsdl|page|transactions|for the period|no transaction recorded|holding|summary|value|isin|folio|account|nsdl|cdsl|note)/i

function isUnknownHeading(text: string): boolean {
  if (KNOWN_HEADINGS.test(text)) return false
  return /^[A-Z][A-Z ()%/.-]{9,}$/.test(text)
}
