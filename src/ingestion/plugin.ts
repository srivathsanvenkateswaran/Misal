/**
 * The extract plugin contract — the whole surface a contributor implements.
 *
 * Four deliberate exclusions, each of which would otherwise be reimplemented per provider and got
 * subtly wrong per provider:
 *
 *   - No file handle, no password, no I/O. A plugin cannot leak a password it never receives.
 *   - No database access. It cannot look up an instrument, so it cannot guess one.
 *   - No natural key, no content hash, no ids. Idempotency is not a plugin concern.
 *   - No date or money parsing. The plugin reports the string and the format token; the shared
 *     normalizer does the conversion and owns the error message.
 *
 * A plugin that throws is a bug but not a fatal one: the runner records `E_PLUGIN_CRASH` against
 * the document and commits whatever was emitted before the throw.
 */

import { DocumentFailure, type RawIssue } from './issues'
import { DOCUMENT_MESSAGE } from './codes'
import type { CsvDecodeHint } from './acquire'
import type { DecodedInput, RawAccount, RawPosition, RawRecord, RawTransaction, SourceKind } from './types'

export interface RecordSink {
  account(record: RawAccount): void
  transaction(record: RawTransaction): void
  position(record: RawPosition): void
  issue(issue: RawIssue): void
  /**
   * A row read and deliberately not imported: an address change, a nominee registration, a
   * `Total` footer. Not in the spec's sink, and needed because the migration has `rows_skipped`
   * and the counters must reconcile — `rows_read = committed + duplicate + skipped + failed`.
   * Counting a KYC-update row as a duplicate would be a lie in the import report.
   */
  skipped(ref: string, reason: string): void
  /**
   * The period the document covers, as printed. Normalised centrally like every other date, so
   * the plugin still parses nothing.
   */
  period(period: RawPeriod): void
}

export interface RawPeriod {
  readonly start?: string
  readonly end?: string
  readonly format: string
  readonly timezone: string
}

export interface ExtractPlugin {
  /** 'cams-kfin-cas', 'nsdl-ecas', 'csv-descriptor:zerodha-console-tradebook'. */
  readonly id: string
  /** FK into provider(id). */
  readonly providerId: string
  readonly accepts: SourceKind
  /**
   * How this plugin's files are decoded, for CSV sources.
   *
   * Declared rather than sniffed, and declared here rather than read from the bytes, so acquire
   * can decode once per declared variant and let detection choose between them.
   */
  readonly decodeHints?: readonly CsvDecodeHint[]
  /** Confidence in [0,1] that this plugin owns the input. Above 0.8 wins; ties are an error. */
  detect(input: DecodedInput): number
  /** Emit raw records. Must not throw for row-level problems — call `sink.issue` instead. */
  extract(input: DecodedInput, sink: RecordSink): void | Promise<void>
}

export interface SkippedRow {
  readonly ref: string
  readonly reason: string
}

export class CollectingSink implements RecordSink {
  readonly records: RawRecord[] = []
  readonly issues: RawIssue[] = []
  readonly skips: SkippedRow[] = []
  period_: RawPeriod | null = null

  account(record: RawAccount): void {
    this.records.push(record)
  }

  transaction(record: RawTransaction): void {
    this.records.push(record)
  }

  position(record: RawPosition): void {
    this.records.push(record)
  }

  issue(issue: RawIssue): void {
    this.issues.push(issue)
  }

  skipped(ref: string, reason: string): void {
    this.skips.push({ ref, reason })
  }

  period(period: RawPeriod): void {
    this.period_ = period
  }
}

const CONFIDENCE_THRESHOLD = 0.8

export interface PluginMatch {
  readonly plugin: ExtractPlugin
  readonly input: DecodedInput
  readonly confidence: number
}

/**
 * Pick the plugin that owns an input, across every candidate decoding of the file.
 *
 * A tie above the threshold is a corpus bug and must fail loudly: two parsers claiming the same
 * file means one of them is about to half-parse it, and a half-parsed statement is worse than a
 * refused one.
 */
export function selectPlugin(
  plugins: readonly ExtractPlugin[],
  inputs: readonly DecodedInput[],
  kind: SourceKind,
): PluginMatch {
  const scored = plugins
    .filter((p) => p.accepts === kind)
    .flatMap((plugin) => inputs.map((input) => ({ plugin, input, confidence: score(plugin, input) })))
    .filter((c) => c.confidence > CONFIDENCE_THRESHOLD)
    .sort((a, b) => b.confidence - a.confidence)

  const best = scored[0]
  if (best === undefined) {
    throw new DocumentFailure('E_UNKNOWN_FORMAT', DOCUMENT_MESSAGE.E_UNKNOWN_FORMAT)
  }
  const runnerUp = scored.find((c) => c.plugin.id !== best.plugin.id)
  if (runnerUp !== undefined && runnerUp.confidence === best.confidence) {
    throw new DocumentFailure(
      'E_AMBIGUOUS_FORMAT',
      `${DOCUMENT_MESSAGE.E_AMBIGUOUS_FORMAT} (${best.plugin.id}, ${runnerUp.plugin.id})`,
    )
  }
  return best
}

function score(plugin: ExtractPlugin, input: DecodedInput): number {
  try {
    const value = plugin.detect(input)
    return Number.isFinite(value) ? value : 0
  } catch {
    // A detector that throws has disqualified itself. It must not take the import with it,
    // because another plugin may well own the file.
    return 0
  }
}
