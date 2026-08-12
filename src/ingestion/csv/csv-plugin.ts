/**
 * The one CSV plugin. It interprets descriptors; it knows nothing about any particular broker.
 *
 * This is what makes adding a broker a data change rather than a code change: drop a `.yaml` file
 * in, drop a redacted fixture and its golden JSON in, open a PR. The reviewer reads the diff of
 * expected output, not a new parser.
 *
 * One honest deviation from the plugin contract. The contract says a plugin does no numeric
 * parsing, and this one canonicalises numbers and evaluates `computed` expressions. It has to:
 * `amount = quantity x price` cannot be deferred to a stage that no longer knows which columns
 * were multiplied. What it still does not do is parse dates, convert to minor units, or decide
 * the excess-precision policy — those stay in normalize, and the arithmetic it does run goes
 * through the same exact-decimal helpers as everything else.
 */

import { absDec, addDec, mulDec, negDec, type Dec } from '@domain/numeric'
import type { CsvDecodeHint } from '../acquire'
import type { ExtractPlugin, RecordSink } from '../plugin'
import type { CanonicalOptions } from '../numbers'
import { canonicalDecimal, compare, padToScale, scaleOf, subtractDec } from '../numbers'
import type { DecimalString, RawFees, RawInstrumentRef, RawTransaction, TxnType } from '../types'
import type { ColumnRule, ComputedExpr, CsvDescriptor, MatchExpr, NumericTransform } from './descriptor'
import type { DecodedInput } from '../types'

/** A UTF-8 BOM survives decoding as U+FEFF glued to the first header name. */
const BOM = String.fromCharCode(0xfeff)

const FEE_COLUMNS = ['fees', 'brokerage', 'stt', 'gst', 'stampDuty', 'tds'] as const

export function csvDescriptorPlugin(descriptor: CsvDescriptor): ExtractPlugin {
  const hint: CsvDecodeHint = {
    delimiter: descriptor.file.delimiter,
    encoding: descriptor.file.encoding,
  }

  return {
    id: `csv-descriptor:${descriptor.id}`,
    providerId: descriptor.providerId,
    accepts: 'csv',
    decodeHints: [hint],
    detect: (input) => detect(descriptor, input),
    extract: (input, sink) => {
      extract(descriptor, input, sink)
    },
  }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function detect(descriptor: CsvDescriptor, input: DecodedInput): number {
  if (input.kind !== 'csv-rows') return 0
  // The decoding is part of the claim: a descriptor that declares semicolons does not own a file
  // that only parses as commas.
  if (input.meta.delimiter !== descriptor.file.delimiter) return 0

  const headerIndex = findHeaderRow(descriptor, input.rows)
  if (headerIndex === -1) return 0

  const preamble = descriptor.detect.preambleContains ?? []
  if (preamble.length > 0) {
    const text = input.rows
      .slice(0, headerIndex)
      .map((row) => row.join(' '))
      .join('\n')
      .toLowerCase()
    if (!preamble.every((needle) => text.includes(needle.toLowerCase()))) return 0
  }

  const headers = new Set((input.rows[headerIndex] ?? []).map(normaliseHeader))
  const signals = (descriptor.detect.signalHeaders ?? []).filter((h) => headers.has(normaliseHeader(h)))
  const bonus = signals.length === 0 ? 0 : 0.09 * (signals.length / (descriptor.detect.signalHeaders?.length ?? 1))
  return 0.9 + bonus
}

function findHeaderRow(descriptor: CsvDescriptor, rows: readonly (readonly string[])[]): number {
  const required = descriptor.detect.requiredHeaders.map(normaliseHeader)
  if (descriptor.file.headerRow !== 'auto') {
    const row = rows[descriptor.file.headerRow]
    if (row === undefined) return -1
    const present = new Set(row.map(normaliseHeader))
    return required.every((h) => present.has(h)) ? descriptor.file.headerRow : -1
  }
  return rows.findIndex((row) => {
    const present = new Set(row.map(normaliseHeader))
    return required.every((h) => present.has(h))
  })
}

/** Case- and whitespace-insensitive, because exports vary the casing of their own headers. */
function normaliseHeader(header: string): string {
  return header.replace(BOM, '').trim().toLowerCase().replace(/\s+/g, ' ')
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function extract(descriptor: CsvDescriptor, input: DecodedInput, sink: RecordSink): void {
  if (input.kind !== 'csv-rows') return

  const headerIndex = findHeaderRow(descriptor, input.rows)
  if (headerIndex === -1) {
    sink.issue({
      severity: 'error',
      code: 'E_HEADER_NOT_FOUND',
      message: `none of the rows carry all of: ${descriptor.detect.requiredHeaders.join(', ')}`,
    })
    return
  }

  const headers = (input.rows[headerIndex] ?? []).map(normaliseHeader)
  const skipPatterns = (descriptor.file.skipRowsMatching ?? []).map((p) => new RegExp(p, 'i'))
  const declaredFees = FEE_COLUMNS.filter((f) => descriptor.columns[f] !== undefined)
  const seenAccounts = new Set<string>()
  let emitted = 0

  if (descriptor.emits === 'transactions' && declaredFees.length === 0) {
    // Surfaced rather than papered over: the tradebook carries no brokerage or STT, so the cost
    // basis this file supports is gross of charges. That is a real limitation of the source.
    sink.issue({
      severity: 'warning',
      code: 'W_FEES_ABSENT',
      message: `${descriptor.displayName} carries no charges column, so cost basis from it is gross of fees`,
    })
  }

  for (let i = headerIndex + 1; i < input.rows.length; i += 1) {
    const cells = input.rows[i] ?? []
    const rowNumber = i + 1
    const ref = `row ${String(rowNumber)}`
    const joined = cells.join(descriptor.file.delimiter)
    const first = cells.find((c) => c.trim() !== '') ?? ''

    if (skipPatterns.some((p) => p.test(first) || p.test(joined))) {
      sink.skipped(ref, 'matched skipRowsMatching')
      continue
    }
    if (cells.filter((c) => c.trim() !== '').length === 0) {
      sink.skipped(ref, 'blank row')
      continue
    }
    if (cells.length !== headers.length) {
      sink.issue({
        severity: 'error',
        code: 'E_ROW_SHAPE',
        message: `row has ${String(cells.length)} cells, the header has ${String(headers.length)}`,
        ref,
        raw: { row: joined },
      })
      continue
    }

    const raw = rawPayload(headers, cells)
    const cell = (column: string): string | null => {
      const index = headers.indexOf(normaliseHeader(column))
      return index === -1 ? null : (cells[index] ?? '')
    }

    const missing = missingColumn(descriptor, cell)
    if (missing !== null) {
      sink.issue({
        severity: 'error',
        code: 'E_MISSING_COLUMN',
        message: `the file has no column named ${JSON.stringify(missing)}`,
        ref,
        raw,
      })
      continue
    }

    const fields = evaluateFields(descriptor, cell)
    if (!fields.ok) {
      sink.issue({ severity: 'error', code: 'E_NUMERIC_PARSE', message: fields.reason, ref, raw })
      continue
    }

    const accountKey = interpolate(descriptor.account.keyTemplate ?? descriptor.account.constant ?? '', cell)
    if (accountKey === '') {
      sink.issue({
        severity: 'error',
        code: 'E_MISSING_REQUIRED_FIELD',
        message: 'the descriptor produced an empty account key',
        ref,
        raw,
      })
      continue
    }
    if (!seenAccounts.has(accountKey)) {
      seenAccounts.add(accountKey)
      sink.account({
        type: 'account',
        ref,
        raw,
        accountKey,
        label: interpolate(descriptor.account.labelTemplate, cell),
        externalRef: accountKey,
        capability: descriptor.capability,
        baseCurrency: currencyOf(descriptor, cell),
        })
    }

    const instrument = instrumentRef(descriptor, cell)

    if (descriptor.emits === 'positions') {
      const asOf = textOf(descriptor.columns['asOf'], cell)
      const quantity = fields.values.get('quantity')
      if (asOf === null || quantity === undefined) {
        sink.issue({
          severity: 'error',
          code: 'E_MISSING_REQUIRED_FIELD',
          message: 'a position needs both asOf and quantity',
          ref,
          raw,
        })
        continue
      }
      const marketValue = fields.values.get('marketValue')
      sink.position({
        type: 'position',
        ref,
        raw,
        accountKey,
        instrument,
        quantity: quantity.value,
        asOf,
        dateFormat: dateFormatOf(descriptor.columns['asOf']),
        timezone: descriptor.file.timezone,
        ...(marketValue !== undefined ? { marketValue: marketValue.value } : {}),
        currency: currencyOf(descriptor, cell),
      })
      emitted += 1
      continue
    }

    const date = textOf(descriptor.columns['date'], cell)
    if (date === null) {
      sink.issue({
        severity: 'error',
        code: 'E_MISSING_REQUIRED_FIELD',
        message: 'the row has no date',
        ref,
        raw,
      })
      continue
    }

    const description = textOf(descriptor.columns['description'], cell) ?? ''
    const type = classify(descriptor, cell)
    if (type === null) {
      sink.issue({
        severity: 'error',
        code: 'E_UNCLASSIFIED_TRANSACTION',
        message: `no type rule matched ${JSON.stringify(description)}`,
        ref,
        raw,
      })
      continue
    }

    const quantity = fields.values.get('quantity')
    const price = fields.values.get('price')
    const amount = fields.values.get('amount')
    const balanceAfter = fields.values.get('balanceAfter')
    const fxRate = fields.values.get('fxRate')

    const excessPrecision = excessPrecisionOf(descriptor)
    const record: RawTransaction = {
      type: 'transaction',
      ref,
      raw,
      accountKey,
      instrument,
      description,
      txnType: type,
      date,
      dateFormat: dateFormatOf(descriptor.columns['date']),
      timezone: descriptor.file.timezone,
      ...(quantity !== undefined ? { quantity: quantity.value } : {}),
      ...(price !== undefined ? { price: price.value } : {}),
      ...(amount !== undefined ? { amount: amount.value } : {}),
      ...(balanceAfter !== undefined ? { balanceAfter: balanceAfter.value } : {}),
      ...(fxRate !== undefined ? { fxRate: fxRate.value } : {}),
      fees: feesOf(fields.values),
      currency: currencyOf(descriptor, cell),
      ...(excessPrecision !== undefined ? { excessPrecision } : {}),
    }
    sink.transaction(record)
    emitted += 1
    checkRowTotal(descriptor, record, fields.values, sink)
  }

  for (const postcondition of descriptor.postconditions ?? []) {
    if (postcondition.kind === 'non-empty' && emitted === 0) {
      sink.issue({
        severity: postcondition.severity,
        code: 'E_POSTCONDITION_FAILED',
        message: 'the file produced no rows',
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Field evaluation
// ---------------------------------------------------------------------------

type Fields =
  | { readonly ok: true; readonly values: Map<string, DecimalString> }
  | { readonly ok: false; readonly reason: string }

/**
 * Evaluate every numeric column rule, then the computed ones.
 *
 * Computed rules are evaluated after the plain ones and may only reference plain ones, which is
 * what keeps the four operations from becoming a dependency graph and then a language.
 */
function evaluateFields(descriptor: CsvDescriptor, cell: (column: string) => string | null): Fields {
  const values = new Map<string, DecimalString>()

  for (const [name, rule] of Object.entries(descriptor.columns)) {
    if (rule.kind !== 'decimal' && rule.kind !== 'money') continue
    const printed = cell(rule.column) ?? ''
    if (printed.trim() === '') continue
    const parsed = canonicalDecimal(printed, canonicalOptionsFor(rule.transform))
    if (!parsed.ok) return { ok: false, reason: `${name}: ${parsed.reason}` }
    const signed = applySign(parsed.value, rule.transform, cell)
    values.set(name, signed)
  }

  for (const [name, rule] of Object.entries(descriptor.columns)) {
    if (rule.kind !== 'computed') continue
    const computed = evaluateComputed(rule.expr, values)
    if (computed === null) continue
    values.set(name, computed)
  }

  return { ok: true, values }
}

function canonicalOptionsFor(transform: NumericTransform | undefined): CanonicalOptions {
  if (transform === undefined) return {}
  return {
    ...(transform.strip !== undefined ? { strip: transform.strip } : {}),
    ...(transform.negative !== undefined ? { negative: transform.negative } : {}),
  }
}

/**
 * Take the sign from another column.
 *
 * An export that writes an unsigned quantity beside a `BUY`/`SELL` column is the common case, and
 * inferring the sign from the number would get every sell wrong.
 */
function applySign(
  value: DecimalString,
  transform: NumericTransform | undefined,
  cell: (column: string) => string | null,
): DecimalString {
  const signFrom = transform?.signFrom
  if (signFrom === undefined) return value
  const other = cell(signFrom.column) ?? ''
  const negative = signFrom.negativeWhen.some((pattern) => new RegExp(pattern, 'i').test(other))
  if (!negative) return value
  if (value.value.startsWith('-')) return value
  return { value: negDec(value.value), scale: value.scale }
}

function evaluateComputed(
  expr: ComputedExpr,
  values: Map<string, DecimalString>,
): DecimalString | null {
  switch (expr.op) {
    case 'multiply': {
      const left = values.get(expr.left)
      const right = values.get(expr.right)
      if (left === undefined || right === undefined) return null
      return padToScale(mulDec(left.value, right.value), left.scale + right.scale)
    }
    case 'add': {
      const terms = expr.terms.map((t) => values.get(t))
      if (terms.some((t) => t === undefined)) return null
      const present = terms as DecimalString[]
      const scale = present.reduce((max, t) => (t.scale > max ? t.scale : max), 0)
      return padToScale(addDec(...present.map((t) => t.value)), scale)
    }
    case 'negate': {
      const of = values.get(expr.of)
      return of === undefined ? null : padToScale(negDec(of.value), of.scale)
    }
    case 'abs': {
      const of = values.get(expr.of)
      return of === undefined ? null : padToScale(absDec(of.value), of.scale)
    }
  }
}

// ---------------------------------------------------------------------------
// Row shaping
// ---------------------------------------------------------------------------

function rawPayload(headers: readonly string[], cells: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((header, index) => {
    out[header] = cells[index] ?? ''
  })
  return out
}

function missingColumn(descriptor: CsvDescriptor, cell: (column: string) => string | null): string | null {
  for (const rule of Object.values(descriptor.columns)) {
    if (rule.kind === 'constant' || rule.kind === 'computed') continue
    if (cell(rule.column) === null) return rule.column
  }
  for (const name of [descriptor.instrument.name, descriptor.instrument.isin, descriptor.instrument.providerLocalId]) {
    if (name !== undefined && cell(name) === null) return name
  }
  return null
}

function textOf(rule: ColumnRule | undefined, cell: (column: string) => string | null): string | null {
  if (rule === undefined) return null
  if (rule.kind === 'constant') return rule.value
  if (rule.kind === 'computed') return null
  const value = cell(rule.column)
  return value === null || value.trim() === '' ? null : value.trim()
}

function dateFormatOf(rule: ColumnRule | undefined): string {
  return rule !== undefined && rule.kind === 'date' ? rule.format : 'yyyy-MM-dd'
}

function currencyOf(descriptor: CsvDescriptor, cell: (column: string) => string | null): string {
  const currency = descriptor.file.currency
  if (typeof currency === 'string') return currency
  return (cell(currency.column) ?? '').trim()
}

function excessPrecisionOf(descriptor: CsvDescriptor): 'error' | 'round-half-up' | undefined {
  const amount = descriptor.columns['amount']
  if (amount === undefined) return undefined
  if (amount.kind !== 'money' && amount.kind !== 'decimal') return undefined
  return amount.transform?.onExcessPrecision
}

function feesOf(values: Map<string, DecimalString>): RawFees {
  const pick = (name: string): string | undefined => values.get(name)?.value
  return {
    ...(pick('brokerage') !== undefined ? { brokerage: pick('brokerage') as string } : {}),
    ...(pick('stt') !== undefined ? { stt: pick('stt') as string } : {}),
    ...(pick('gst') !== undefined ? { gst: pick('gst') as string } : {}),
    ...(pick('stampDuty') !== undefined ? { stampDuty: pick('stampDuty') as string } : {}),
    ...(pick('tds') !== undefined ? { tds: pick('tds') as string } : {}),
    ...(pick('fees') !== undefined ? { other: pick('fees') as string } : {}),
  }
}

function instrumentRef(descriptor: CsvDescriptor, cell: (column: string) => string | null): RawInstrumentRef {
  const rule = descriptor.instrument
  const read = (column: string | undefined): string | undefined => {
    if (column === undefined) return undefined
    const value = cell(column)
    return value === null || value.trim() === '' ? undefined : value.trim()
  }

  const exchange =
    rule.exchange === undefined
      ? undefined
      : typeof rule.exchange === 'string'
        ? asExchange(read(rule.exchange))
        : rule.exchange.constant

  const assetClassHint =
    rule.assetClassHint === undefined
      ? undefined
      : typeof rule.assetClassHint === 'string'
        ? read(rule.assetClassHint)
        : rule.assetClassHint.constant

  return {
    ...(read(rule.isin) !== undefined ? { isin: read(rule.isin) as string } : {}),
    ...(read(rule.amfiCode) !== undefined ? { amfiCode: read(rule.amfiCode) as string } : {}),
    ...(read(rule.symbol) !== undefined ? { symbol: read(rule.symbol) as string } : {}),
    ...(exchange !== undefined ? { exchange } : {}),
    ...(read(rule.providerLocalId) !== undefined
      ? { providerLocalId: read(rule.providerLocalId) as string }
      : {}),
    name: read(rule.name) ?? '',
    ...(assetClassHint !== undefined ? { assetClassHint } : {}),
  }
}

function asExchange(value: string | undefined): RawInstrumentRef['exchange'] {
  switch ((value ?? '').toUpperCase()) {
    case 'NSE':
      return 'NSE'
    case 'BSE':
      return 'BSE'
    case 'NASDAQ':
      return 'NASDAQ'
    case 'NYSE':
      return 'NYSE'
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Type rules
// ---------------------------------------------------------------------------

function classify(
  descriptor: CsvDescriptor,
  cell: (column: string) => string | null,
): TxnType | null {
  for (const rule of descriptor.typeRules ?? []) {
    if (matches(rule.when, cell)) return rule.type
  }
  return null
}

function matches(expr: MatchExpr, cell: (column: string) => string | null): boolean {
  if ('all' in expr) return expr.all.every((e) => matches(e, cell))
  if ('any' in expr) return expr.any.some((e) => matches(e, cell))

  const value = (cell(expr.column) ?? '').trim()
  if ('equals' in expr) {
    return expr.ignoreCase === true
      ? expr.equals.some((e) => e.toLowerCase() === value.toLowerCase())
      : expr.equals.includes(value)
  }
  if ('matches' in expr) return new RegExp(expr.matches).test(value)

  const parsed = canonicalDecimal(value)
  if (!parsed.ok) return false
  const sign = signOf(parsed.value.value)
  return sign === expr.sign
}

function signOf(value: Dec): 'positive' | 'negative' | 'zero' {
  if (value.startsWith('-')) return 'negative'
  return /^0(?:\.0*)?$/.test(value) ? 'zero' : 'positive'
}

// ---------------------------------------------------------------------------
// Postconditions
// ---------------------------------------------------------------------------

/**
 * `row-total`: does the row's own arithmetic hold?
 *
 * Rows with no quantity or no price — a dividend credit — are not checked, because there is
 * nothing to check, not because the check passed.
 */
function checkRowTotal(
  descriptor: CsvDescriptor,
  record: RawTransaction,
  values: Map<string, DecimalString>,
  sink: RecordSink,
): void {
  for (const postcondition of descriptor.postconditions ?? []) {
    if (postcondition.kind !== 'row-total') continue
    const quantity = values.get(postcondition.params['quantity'] ?? 'quantity')
    const price = values.get(postcondition.params['price'] ?? 'price')
    const amount = values.get(postcondition.params['amount'] ?? 'amount')
    if (quantity === undefined || price === undefined || amount === undefined) continue

    const toleranceText = postcondition.params['tolerance'] ?? '0.01'
    const tolerance = canonicalDecimal(toleranceText)
    if (!tolerance.ok) continue

    const expected = absDec(mulDec(quantity.value, price.value))
    const actual = absDec(amount.value)
    const difference = absDec(subtractDec(expected, actual))
    if (compare(difference, tolerance.value.value) <= 0) continue

    sink.issue({
      severity: postcondition.severity,
      code: 'W_BALANCE_MISMATCH',
      message: `row total does not reconcile: ${quantity.value} x ${price.value} is ${expected}, the file says ${actual}`,
      ref: record.ref,
      raw: record.raw,
    })
  }
}

/** Interpolate `{column}` placeholders from the row. Missing columns collapse to nothing. */
function interpolate(template: string, cell: (column: string) => string | null): string {
  return template.replace(/\{([^}]+)\}/g, (_, column: string) => (cell(column) ?? '').trim())
}

export { normaliseHeader, findHeaderRow, scaleOf }
