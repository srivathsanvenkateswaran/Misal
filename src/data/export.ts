/**
 * Export — CSV and JSON, written through the native save dialog.
 *
 * Three rules are structural here rather than remembered:
 *
 *  1. **A row object is never serialised.** Every table is a list of *columns*, each naming the one
 *     field it reads. `JSON.stringify(row)` would export whatever a row happens to carry, which is
 *     how a `credential_ref`, an API key or a keychain handle ends up in a file the user emails to
 *     an accountant. The spec is explicit (core schema §"Exports never contain secrets"): the
 *     export walks a whitelist. `assertExportableColumns` refuses a column whose name even reads
 *     like a secret, so adding one is a deliberate act with a test failure attached.
 *
 *  2. **Money and quantities leave as the exact strings they were stored as.** No rounding, no
 *     formatting, no grouping, no `Number`. Money is emitted twice — as the stored minor-unit
 *     integer and as the exact major-unit decimal derived from it — because the first is what Misal
 *     holds and the second is what a spreadsheet can add up. A spreadsheet will turn either into a
 *     float on open; that is out of our hands, but it will not have been mangled before it got
 *     there.
 *
 *  3. **An unmeasurable metric is an empty cell and a reason**, never a zero. H3 is a property of
 *     the value, not of the medium: a `0` in a CSV reads as "no gain" exactly as it does on screen,
 *     and a file outlives the screen it was exported from.
 */

import { invoke } from '@tauri-apps/api/core'
import type { NotMeasuredReason } from '@domain/measured'
import { REASON_TEXT } from '@domain/measured'

export type ExportFormat = 'csv' | 'json'

/**
 * One cell: either a value, or a statement that there is none and why.
 *
 * There is no third case, and in particular no "empty" case that a reader could take for zero. A
 * field that is genuinely absent rather than unmeasurable — an instrument with no ISIN — is a
 * value of `''`, which in a column of identifiers reads as what it is.
 */
export type ExportCell =
  | { readonly kind: 'value'; readonly text: string }
  | { readonly kind: 'not-measured'; readonly reason: string }

export function cell(text: string): ExportCell {
  return { kind: 'value', text }
}

export function unmeasuredCell(reason: NotMeasuredReason): ExportCell {
  return { kind: 'not-measured', reason: REASON_TEXT[reason] }
}

export interface ExportColumn<Row> {
  /** snake_case. Becomes the CSV header and the JSON key, unchanged. */
  readonly id: string
  readonly cell: (row: Row) => ExportCell
  /**
   * Emit a companion `<id>_not_measured` column.
   *
   * Set on every column that can carry an unmeasurable metric. The companion exists whether or not
   * any row in this export happens to be unmeasurable, so the file's shape is a property of the
   * schema rather than of the data that day.
   */
  readonly withReason?: boolean
}

export interface ExportTable<Row> {
  readonly name: string
  readonly columns: readonly ExportColumn<Row>[]
  readonly rows: readonly Row[]
}

/** A table reduced to strings: what CSV writes and what JSON is built from. */
export interface FlatTable {
  readonly name: string
  readonly headers: readonly string[]
  readonly rows: readonly (readonly string[])[]
}

/**
 * Column names that must never appear in an export.
 *
 * A name check, not a content check. The values are the user's own data — a crypto instrument may
 * legitimately be called a token, and an account may be labelled anything at all — so scanning
 * content would either fire on innocent rows or teach us to ignore it. What this catches is the
 * real failure mode: someone adds `credentialRef` or `apiKeySecret` to a column list because it
 * was on the row object in front of them.
 */
const FORBIDDEN_COLUMN =
  /secret|api[_-]?key|apikey|keychain|credential|passphrase|password|private[_-]?key|access[_-]?token|refresh[_-]?token/i

export class ExportError extends Error {
  override readonly name = 'ExportError'
}

export function assertExportableColumns(columns: readonly { readonly id: string }[]): void {
  for (const column of columns) {
    if (FORBIDDEN_COLUMN.test(column.id)) {
      throw new ExportError(
        `Column ${JSON.stringify(column.id)} names a secret or a credential. Secrets live in the OS keychain and are never exported.`,
      )
    }
  }
}

const REASON_SUFFIX = '_not_measured'

export function flatten<Row>(table: ExportTable<Row>): FlatTable {
  assertExportableColumns(table.columns)

  const headers: string[] = []
  for (const column of table.columns) {
    headers.push(column.id)
    if (column.withReason === true) headers.push(`${column.id}${REASON_SUFFIX}`)
  }

  const rows = table.rows.map((row) => {
    const out: string[] = []
    for (const column of table.columns) {
      const value = column.cell(row)
      out.push(value.kind === 'value' ? value.text : '')
      if (column.withReason === true) {
        out.push(value.kind === 'value' ? '' : value.reason)
      }
    }
    return out
  })

  return { name: table.name, headers, rows }
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC 4180: quote a field containing a comma, a quote or a newline, and double any quote inside it.
 * CRLF line endings, because that is what the format says and what every spreadsheet expects.
 */
function csvField(text: string): string {
  return /["\n\r,]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function toCsv(table: FlatTable): string {
  const lines = [table.headers.map(csvField).join(',')]
  for (const row of table.rows) lines.push(row.map(csvField).join(','))
  return `${lines.join('\r\n')}\r\n`
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/**
 * Every value is a string or `null`. Never a JSON number: a JSON number is an IEEE-754 double, and
 * a paise value past 2^53 or an eighteen-decimal crypto quantity would lose its tail on the way
 * out — the same reason the IPC boundary carries strings in both directions.
 */
export type JsonRecord = Record<string, string | null>

export function toRecords(table: FlatTable): readonly JsonRecord[] {
  return table.rows.map((row) => {
    const record: JsonRecord = {}
    table.headers.forEach((header, index) => {
      const text = row[index] ?? ''
      record[header] = text === '' ? null : text
    })
    return record
  })
}

export function toJson(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// Writing the file
// ---------------------------------------------------------------------------

export interface ExportDocument {
  readonly fileName: string
  readonly format: ExportFormat
  readonly contents: string
}

/** The commands this module speaks. Injectable, so the tests need no Tauri runtime. */
export type Invoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

const tauriInvoke: Invoker = (command, args) => invoke(command, args)

/**
 * Show the native save dialog and write the file, in one round trip.
 *
 * The dialog is driven from Rust, as the statement picker is: `pick_statement_file` proved the
 * pattern, and it keeps the frontend from needing filesystem reach of its own. `null` means the
 * user dismissed the dialog, which is not an error and is not reported as one.
 *
 * The core-side command is `save_export_file(suggestedName, contents) -> Option<String>`.
 */
export const saveExportDocument = (
  document: ExportDocument,
  call: Invoker = tauriInvoke,
): Promise<string | null> =>
  call('save_export_file', {
    suggestedName: document.fileName,
    contents: document.contents,
  })
