/**
 * Stage data shapes for the ingestion pipeline.
 *
 *   acquire -> extract -> normalize -> resolve -> reconcile -> commit
 *
 * Every numeric field is a string at every stage before `commit`, for the reason the core schema
 * gives at the IPC boundary: a JSON number is a double, and a double cannot carry a rupee amount
 * or an 18-decimal crypto quantity without lying about it.
 *
 * Two deliberate departures from the ingestion spec's TypeScript, both forced by Subsystem A:
 *
 *   1. The spec writes `amountMinor: bigint`. Subsystem A's `Minor` is a branded string, and the
 *      whole point of the brand is that `a + b` on two of them fails `tsc`. A bigint would leave
 *      `+` legal and silently correct, which is exactly the habit the brand exists to break. Minor
 *      is used throughout instead.
 *   2. The spec has a single `feesMinor`. The migration decomposes fees into brokerage, STT, GST,
 *      stamp duty, other and TDS, because section 48 allows brokerage as a cost of transfer and
 *      expressly disallows STT. Collapsing them at normalize would make correct capital gains
 *      impossible to compute later without re-reading the statement, so the breakdown is carried.
 */

import type { Dec, Minor } from '@domain/numeric'

export type SourceKind = 'cas-pdf' | 'csv'

export type Capability = 'ledger' | 'snapshot'

export type TxnType =
  | 'buy'
  | 'sell'
  | 'dividend'
  | 'split'
  | 'bonus'
  | 'transfer_in'
  | 'transfer_out'
  | 'fee'
  | 'interest'
  | 'tds'

export const TXN_TYPES: readonly TxnType[] = [
  'buy',
  'sell',
  'dividend',
  'split',
  'bonus',
  'transfer_in',
  'transfer_out',
  'fee',
  'interest',
  'tds',
]

// ---------------------------------------------------------------------------
// Acquire
// ---------------------------------------------------------------------------

export interface AcquiredSource {
  /** sha256 of the raw bytes, lowercase hex. Of the encrypted bytes for an encrypted PDF. */
  readonly contentHash: string
  readonly originalName: string
  readonly byteLength: number
  readonly kind: SourceKind
}

export interface TextItem {
  readonly text: string
  /** Left edge, PDF user space, origin bottom-left. */
  readonly x: number
  /** Baseline. */
  readonly y: number
  readonly width: number
  readonly height: number
  readonly fontName: string
  /**
   * The `b` and `a` components of the text matrix, kept only so the layout engine can reject
   * rotated text without re-reading the PDF. Watermarks are drawn vertically and bleed fragments
   * such as `CAMS L` into scheme names.
   */
  readonly matrixA?: number
  readonly matrixB?: number
}

export interface TextLine {
  readonly y: number
  /** Sorted by x, whitespace fillers removed. */
  readonly cells: readonly TextItem[]
  /** Cells joined by single spaces. */
  readonly text: string
}

export interface PdfMeta {
  readonly pageCount: number
  /** /Title, /Author, /Creator, /Keywords. */
  readonly info: Readonly<Record<string, string>>
  readonly encrypted: boolean
  readonly hasTextLayer: boolean
}

/** A page as extracted, before layout reconstruction. This is what a Tier-1 fixture holds. */
export interface RawPdfPage {
  /** 1-based. */
  readonly pageNumber: number
  /** Points. */
  readonly width: number
  readonly height: number
  /** Degrees: 0 | 90 | 180 | 270. */
  readonly rotation: number
  readonly items: readonly TextItem[]
}

/** A page after the shared layout engine has reconstructed rows. */
export interface PdfPage extends RawPdfPage {
  readonly lines: readonly TextLine[]
}

export interface CsvMeta {
  readonly delimiter: string
  /** Index into rows; -1 when headerless. */
  readonly headerRowIndex: number
  readonly headers: readonly string[]
}

/** What a plugin actually receives. Decryption and low-level parsing already happened. */
export type DecodedInput =
  | { readonly kind: 'pdf-text'; readonly pages: readonly PdfPage[]; readonly meta: PdfMeta }
  | {
      readonly kind: 'csv-rows'
      readonly rows: readonly (readonly string[])[]
      readonly meta: CsvMeta
    }

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

export interface RawRef {
  /** Human-locatable origin, written to import_issue.row_ref. 'p.7 r.12', 'row 341'. */
  readonly ref: string
  /** Verbatim JSON of the source row, written to import_issue.raw_payload for re-run. */
  readonly raw: Readonly<Record<string, string>>
}

/** A logical account discovered inside the document. One file may declare many. */
export interface RawAccount extends RawRef {
  readonly type: 'account'
  /** Stable, realm-qualified identity; lands in account.identity_key. */
  readonly accountKey: string
  readonly label: string
  /** The number as printed, masked or not; lands in account.external_ref. */
  readonly externalRef: string
  readonly capability: Capability
  readonly baseCurrency: string
  /**
   * Set when a source that would otherwise be a ledger failed its own checks. Only a document
   * carrying this may pull an existing `ledger` account down to `snapshot`; a plain snapshot
   * source never can.
   */
  readonly downgradedFrom?: Capability
}

export interface RawInstrumentRef {
  readonly isin?: string
  readonly amfiCode?: string
  readonly exchange?: 'NSE' | 'BSE' | 'NASDAQ' | 'NYSE'
  readonly symbol?: string
  /** RTA scheme code, broker scrip code. Scoped to the provider. */
  readonly providerLocalId?: string
  /** Always present; feeds unresolved_instrument.raw_name. */
  readonly name: string
  readonly assetClassHint?: string
}

export interface RawTransaction extends RawRef {
  readonly type: 'transaction'
  readonly accountKey: string
  readonly instrument: RawInstrumentRef
  /** The source's own words. Classification happens in normalize unless txnType is given. */
  readonly description: string
  readonly txnType?: TxnType
  /** As printed: '15-Nov-2021', '2021-11-15'. */
  readonly date: string
  /** Luxon format token string, e.g. 'dd-MMM-yyyy'. */
  readonly dateFormat: string
  /** IANA, e.g. 'Asia/Kolkata'. */
  readonly timezone: string
  readonly quantity?: string
  readonly price?: string
  readonly amount?: string
  readonly fees?: RawFees
  readonly currency: string
  /** Only when the document states it. Ingestion never fetches a rate. */
  readonly fxRate?: string
  /** Running balance printed by the source, used for the checksum. Never stored. */
  readonly balanceAfter?: string
  /**
   * Which document asserted this row, per the migration's `txn.authority`.
   *
   * The registrar is authoritative for units and the depository is corroborating for the same
   * folio; when the two disagree, the fold needs to know which it is holding. Defaults to
   * 'primary'.
   */
  readonly authority?: TxnAuthority
  /**
   * Not in the spec's RawRecord. The descriptor's `onExcessPrecision` is a per-source policy that
   * normalize must apply, and normalize is provider-agnostic, so the record carries it. Defaults
   * to 'error', which is the spec's default for statement plugins.
   */
  readonly excessPrecision?: ExcessPrecisionPolicy
}

/** Fees as printed, decomposed to match the txn table's columns. */
export interface RawFees {
  readonly brokerage?: string
  readonly stt?: string
  readonly gst?: string
  readonly stampDuty?: string
  readonly other?: string
  readonly tds?: string
}

export interface RawPosition extends RawRef {
  readonly type: 'position'
  readonly accountKey: string
  readonly instrument: RawInstrumentRef
  readonly quantity: string
  readonly asOf: string
  readonly dateFormat: string
  readonly timezone: string
  /** Feeds unresolved_instrument.observed_value_minor. */
  readonly marketValue?: string
  readonly currency: string
}

export type RawRecord = RawAccount | RawTransaction | RawPosition

export type ExcessPrecisionPolicy = 'error' | 'round-half-up'

export type TxnAuthority = 'primary' | 'corroborating'

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

/**
 * A decimal string plus the scale the source printed.
 *
 * `new Decimal('12.3450').toString()` returns '12.345' and `.dp()` returns 3. No JavaScript
 * decimal library preserves scale, and Subsystem A requires trailing zeros to survive because
 * they carry significance in fund statements. Carrying the scale alongside the value satisfies
 * both: storage writes `value`, arithmetic goes through Decimal, display pads to `scale`.
 */
export interface DecimalString {
  readonly value: Dec
  readonly scale: number
}

export interface FeeBreakdown {
  readonly brokerage: Minor
  readonly stt: Minor
  readonly gst: Minor
  readonly stampDuty: Minor
  readonly other: Minor
  readonly tds: Minor
}

export interface NormalizedAccount {
  readonly kind: 'account'
  readonly accountKey: string
  readonly label: string
  readonly externalRef: string
  readonly capability: Capability
  readonly baseCurrency: string
  readonly downgradedFrom?: Capability
  readonly origin: RawRef
}

export interface NormalizedTransaction {
  readonly kind: 'transaction'
  readonly accountKey: string
  readonly instrument: RawInstrumentRef
  readonly txnType: TxnType
  /** ISO-8601 with an explicit offset: '2021-11-15T00:00:00+05:30'. */
  readonly occurredAt: string
  /** Local calendar date 'YYYY-MM-DD' — the natural-key input, never the UTC date. */
  readonly occurredDate: string
  readonly occurredTz: string
  readonly quantity: DecimalString
  readonly price?: DecimalString
  readonly amountMinor?: Minor
  readonly fees: FeeBreakdown
  readonly currency: string
  readonly fxRate?: DecimalString
  readonly authority: TxnAuthority
  readonly origin: RawRef
}

export interface NormalizedPosition {
  readonly kind: 'position'
  readonly accountKey: string
  readonly instrument: RawInstrumentRef
  readonly quantity: DecimalString
  readonly asOf: string
  readonly asOfDate: string
  readonly asOfTz: string
  readonly marketValueMinor?: Minor
  readonly currency: string
  readonly origin: RawRef
}

export type NormalizedRecord = NormalizedAccount | NormalizedTransaction | NormalizedPosition

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

export interface ResolvedTransaction extends NormalizedTransaction {
  readonly accountId: string
  readonly instrumentId: string
}

export interface ResolvedPosition extends NormalizedPosition {
  readonly accountId: string
  readonly instrumentId: string
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

/**
 * Dispositions.
 *
 * The spec names the third one `duplicate-in-document` and discards the row. That predates the
 * migration, which added `txn.occurrence` precisely so that two genuinely distinct events which
 * are identical in every other respect — a doubled SIP instalment on the same day, at the same
 * NAV, for the same amount — both survive. So the repeat is admitted under a higher occurrence
 * and counted as committed; the W_DUPLICATE_IN_DOCUMENT warning still fires, because a repeat is
 * worth a human look either way.
 */
export type Disposition = 'insert' | 'duplicate-in-db' | 'repeat-in-document'

export interface ReconciledTransaction extends ResolvedTransaction {
  readonly naturalKey: string
  readonly occurrence: number
  readonly disposition: Disposition
}

export interface ReconciledPosition extends ResolvedPosition {
  readonly disposition: 'insert' | 'restate' | 'duplicate-in-db'
}
