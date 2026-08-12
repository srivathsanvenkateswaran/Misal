/**
 * Normalize — the only place strings become typed values.
 *
 * Provider-agnostic by construction: it sees a `RawRecord` and nothing else, so a bug here is a
 * bug for every provider at once and is fixed once. A row that fails normalization produces an
 * issue and disappears from the stream; it never fails the import.
 */

import { ZERO_MINOR, type CurrencyCode, type Minor, currencyCode } from '@domain/numeric'
import type { RowCode, WarningCode } from './codes'
import type { Issue } from './issues'
import { canonicalDecimal, toMinorUnits, type Parsed } from './numbers'
import { parseDate } from './dates'
import type {
  DecimalString,
  FeeBreakdown,
  NormalizedAccount,
  NormalizedPosition,
  NormalizedRecord,
  NormalizedTransaction,
  RawAccount,
  RawPosition,
  RawRecord,
  RawTransaction,
  TxnType,
} from './types'

export type IssueSink = (issue: Issue) => void

export const ZERO_FEES: FeeBreakdown = {
  brokerage: ZERO_MINOR,
  stt: ZERO_MINOR,
  gst: ZERO_MINOR,
  stampDuty: ZERO_MINOR,
  other: ZERO_MINOR,
  tds: ZERO_MINOR,
}

/** Types that describe a movement of units and therefore require a quantity. */
const QUANTITY_REQUIRED: ReadonlySet<TxnType> = new Set<TxnType>([
  'buy',
  'sell',
  'transfer_in',
  'transfer_out',
  'split',
  'bonus',
])

/**
 * Normalize one raw record.
 *
 * Returns zero or one record. Zero means the row failed and an issue was emitted; the caller
 * counts it as failed and moves on, which is the whole non-negotiable.
 */
export function normalizeRecord(record: RawRecord, issue: IssueSink): NormalizedRecord[] {
  switch (record.type) {
    case 'account':
      return [normalizeAccount(record)]
    case 'transaction':
      return normalizeTransaction(record, issue)
    case 'position':
      return normalizePosition(record, issue)
  }
}

function normalizeAccount(record: RawAccount): NormalizedAccount {
  return {
    kind: 'account',
    accountKey: record.accountKey,
    label: record.label,
    externalRef: record.externalRef,
    capability: record.capability,
    baseCurrency: record.baseCurrency,
    ...(record.downgradedFrom !== undefined ? { downgradedFrom: record.downgradedFrom } : {}),
    origin: { ref: record.ref, raw: record.raw },
  }
}

function normalizeTransaction(record: RawTransaction, issue: IssueSink): NormalizedTransaction[] {
  const origin = { ref: record.ref, raw: record.raw }
  const emit = (code: RowCode, message: string): NormalizedTransaction[] => {
    issue({ severity: 'error', code, message, ref: record.ref, raw: record.raw })
    return []
  }

  if (record.txnType === undefined) {
    return emit(
      'E_UNCLASSIFIED_TRANSACTION',
      `no rule classified ${JSON.stringify(record.description)}`,
    )
  }

  const currency = asCurrency(record.currency)
  if (currency === null) {
    return emit('E_NUMERIC_PARSE', `unsupported currency ${JSON.stringify(record.currency)}`)
  }

  const when = parseDate(record.date, record.dateFormat, record.timezone)
  if (!when.ok) return emit('E_DATE_PARSE', when.reason)

  let quantity: DecimalString
  if (record.quantity === undefined || record.quantity.trim() === '') {
    if (QUANTITY_REQUIRED.has(record.txnType)) {
      return emit('E_MISSING_REQUIRED_FIELD', `a ${record.txnType} needs a quantity`)
    }
    quantity = { value: canonicalZero().value, scale: 0 }
  } else {
    const parsed = canonicalDecimal(record.quantity)
    if (!parsed.ok) return emit('E_NUMERIC_PARSE', `quantity: ${parsed.reason}`)
    quantity = parsed.value
  }

  let price: DecimalString | undefined
  if (record.price !== undefined && record.price.trim() !== '') {
    const parsed = canonicalDecimal(record.price)
    if (!parsed.ok) return emit('E_NUMERIC_PARSE', `price: ${parsed.reason}`)
    price = parsed.value
  }

  let amountMinor: Minor | undefined
  if (record.amount !== undefined && record.amount.trim() !== '') {
    const parsed = canonicalDecimal(record.amount)
    if (!parsed.ok) return emit('E_NUMERIC_PARSE', `amount: ${parsed.reason}`)
    const money = toMinorUnits(parsed.value, currency, record.excessPrecision ?? 'error')
    if (!money.ok) return emit('E_AMOUNT_PRECISION', money.reason)
    if (money.value.rounded) {
      warn(
        issue,
        'W_AMOUNT_ROUNDED',
        `amount ${record.amount} was rounded to ${money.value.minor} minor units`,
        record,
      )
    }
    amountMinor = money.value.minor
  }

  let fxRate: DecimalString | undefined
  if (record.fxRate !== undefined && record.fxRate.trim() !== '') {
    const parsed = canonicalDecimal(record.fxRate)
    if (!parsed.ok) return emit('E_NUMERIC_PARSE', `fx rate: ${parsed.reason}`)
    fxRate = parsed.value
  }

  const fees = normalizeFees(record, currency, issue)
  if (fees === null) return []

  return [
    {
      kind: 'transaction',
      accountKey: record.accountKey,
      instrument: record.instrument,
      txnType: record.txnType,
      occurredAt: when.value.at,
      occurredDate: when.value.date,
      occurredTz: when.value.tz,
      quantity,
      ...(price !== undefined ? { price } : {}),
      ...(amountMinor !== undefined ? { amountMinor } : {}),
      fees,
      currency,
      ...(fxRate !== undefined ? { fxRate } : {}),
      authority: record.authority ?? 'primary',
      origin,
    },
  ]
}

function normalizeFees(
  record: RawTransaction,
  currency: CurrencyCode,
  issue: IssueSink,
): FeeBreakdown | null {
  const raw = record.fees
  if (raw === undefined) return ZERO_FEES

  const parts: Record<keyof FeeBreakdown, Minor> = { ...ZERO_FEES }
  for (const key of ['brokerage', 'stt', 'gst', 'stampDuty', 'other', 'tds'] as const) {
    const printed = raw[key]
    if (printed === undefined || printed.trim() === '') continue
    const parsed = canonicalDecimal(printed)
    if (!parsed.ok) {
      issue({
        severity: 'error',
        code: 'E_NUMERIC_PARSE',
        message: `${key}: ${parsed.reason}`,
        ref: record.ref,
        raw: record.raw,
      })
      return null
    }
    // A levy is always a cost, never a credit, however the source signs it.
    const magnitude: DecimalString = parsed.value.value.startsWith('-')
      ? { value: stripSign(parsed.value), scale: parsed.value.scale }
      : parsed.value
    const money = toMinorUnits(magnitude, currency, record.excessPrecision ?? 'error')
    if (!money.ok) {
      issue({
        severity: 'error',
        code: 'E_AMOUNT_PRECISION',
        message: `${key}: ${money.reason}`,
        ref: record.ref,
        raw: record.raw,
      })
      return null
    }
    parts[key] = money.value.minor
  }
  return parts
}

function normalizePosition(record: RawPosition, issue: IssueSink): NormalizedPosition[] {
  const emit = (code: RowCode, message: string): NormalizedPosition[] => {
    issue({ severity: 'error', code, message, ref: record.ref, raw: record.raw })
    return []
  }

  const currency = asCurrency(record.currency)
  if (currency === null) {
    return emit('E_NUMERIC_PARSE', `unsupported currency ${JSON.stringify(record.currency)}`)
  }

  const when = parseDate(record.asOf, record.dateFormat, record.timezone)
  if (!when.ok) return emit('E_DATE_PARSE', when.reason)

  const quantity = canonicalDecimal(record.quantity)
  if (!quantity.ok) return emit('E_NUMERIC_PARSE', `quantity: ${quantity.reason}`)

  let marketValueMinor: Minor | undefined
  if (record.marketValue !== undefined && record.marketValue.trim() !== '') {
    const parsed = canonicalDecimal(record.marketValue)
    if (!parsed.ok) return emit('E_NUMERIC_PARSE', `market value: ${parsed.reason}`)
    // A printed market value is rounded for display by the issuer; rounding it again to paise is
    // not a precision loss worth failing a holding over.
    const money = toMinorUnits(parsed.value, currency, 'round-half-up')
    if (!money.ok) return emit('E_AMOUNT_PRECISION', money.reason)
    marketValueMinor = money.value.minor
  }

  return [
    {
      kind: 'position',
      accountKey: record.accountKey,
      instrument: record.instrument,
      quantity: quantity.value,
      asOf: when.value.at,
      asOfDate: when.value.date,
      asOfTz: when.value.tz,
      ...(marketValueMinor !== undefined ? { marketValueMinor } : {}),
      currency,
      origin: { ref: record.ref, raw: record.raw },
    },
  ]
}

function warn(issue: IssueSink, code: WarningCode, message: string, record: RawTransaction): void {
  issue({ severity: 'warning', code, message, ref: record.ref, raw: record.raw })
}

function asCurrency(raw: string): CurrencyCode | null {
  try {
    return currencyCode(raw.trim().toUpperCase())
  } catch {
    return null
  }
}

function canonicalZero(): DecimalString {
  const parsed = canonicalDecimal('0')
  if (!parsed.ok) throw new Error('unreachable: 0 is canonical')
  return parsed.value
}

function stripSign(value: DecimalString): DecimalString['value'] {
  const parsed: Parsed<DecimalString> = canonicalDecimal(value.value.slice(1))
  if (!parsed.ok) throw new Error(`unreachable: ${value.value} is canonical`)
  return parsed.value.value
}
