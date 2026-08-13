/**
 * What an export contains — the column whitelists, and nothing else.
 *
 * This module is the list of fields Misal is willing to write to a file the user will send
 * somewhere. It reads the same view-models the screens read, so an exported figure and the figure
 * on screen come from one computation; and it names every column explicitly, so nothing travels
 * into the file merely because it happened to be on the object.
 *
 * What is deliberately *not* here: anything from `credential_ref`, any keychain handle, any API
 * key, any provider secret. Those never reach this layer at all — `src/data/client.ts` does not
 * expose them — and `assertExportableColumns` refuses a column named like one anyway, so the
 * protection does not depend on that staying true.
 *
 * Two honesty rules carry over from the screens unchanged:
 *
 *   - Money and quantities are the exact stored strings. Money appears twice: `<name>_minor` is
 *     the stored integer in the smallest unit of *its own* currency and `<name>` is the exact
 *     decimal derived from it by `minorToDec`, which divides by a power of ten and never rounds.
 *     The `_inr` suffix is reserved for figures Misal has itself converted to rupees, and a table
 *     carrying an unconverted amount carries the currency column that names its unit.
 *   - A metric that could not be measured is an empty cell plus a reason, never a zero. A `0` in a
 *     spreadsheet reads as "no gain", and the file outlives the context that would have explained
 *     it.
 */

import { minorToDec } from '@domain/numeric'
import type { Measured } from '@domain/measured'
import type { Figure } from '@ui/figure'
import type {
  ExportCell,
  ExportColumn,
  ExportDocument,
  ExportFormat,
  ExportTable,
  Invoker,
  JsonRecord,
} from '../data/export'
import {
  assertExportableColumns,
  cell,
  flatten,
  saveExportDocument,
  toCsv,
  toJson,
  toRecords,
  unmeasuredCell,
} from '../data/export'
import type { InstrumentView, PortfolioData, PositionView, TxnView } from './view-model'

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/** The raw string behind a figure: the stored minor units, or the stored decimal. */
function rawOf(figure: Figure): string {
  return figure.kind === 'money' ? figure.minor : figure.value
}

/** A measured figure as its exact stored string; an unmeasured one as a reason. */
function figureCell(value: Measured<Figure>): ExportCell {
  return value.measured ? cell(rawOf(value.value)) : unmeasuredCell(value.reason)
}

/** The same figure in major units. Exact: `minorToDec` divides by a power of ten. */
function majorCell(value: Measured<Figure>): ExportCell {
  if (!value.measured) return unmeasuredCell(value.reason)
  const figure = value.value
  return cell(figure.kind === 'money' ? minorToDec(figure.minor, figure.currency) : figure.value)
}

// ---------------------------------------------------------------------------
// Holdings
// ---------------------------------------------------------------------------

interface HoldingRow {
  readonly asOfDate: string
  readonly position: PositionView
}

/**
 * The holdings whitelist.
 *
 * One row per instrument *per account*, because that is the grain at which a holding has a
 * capability, a cost basis and a source. Summing to the instrument would hide that one folio is
 * ledger-backed and the other is a snapshot, which is the single most important thing this file
 * can tell whoever reads it next.
 */
const HOLDING_COLUMNS: readonly ExportColumn<HoldingRow>[] = [
  { id: 'as_of', cell: (row) => cell(row.asOfDate) },
  { id: 'account', cell: (row) => cell(row.position.accountLabel) },
  { id: 'account_history', cell: (row) => cell(row.position.capability) },
  { id: 'instrument', cell: (row) => cell(row.position.name) },
  { id: 'instrument_id', cell: (row) => cell(row.position.instrumentId) },
  { id: 'asset_class', cell: (row) => cell(row.position.assetClass) },
  { id: 'identifiers', cell: (row) => cell(row.position.detail) },
  { id: 'instrument_currency', cell: (row) => cell(row.position.currency) },
  { id: 'quantity', cell: (row) => cell(row.position.quantity) },
  { id: 'last_price', cell: (row) => figureCell(row.position.lastPrice), withReason: true },
  { id: 'avg_cost', cell: (row) => figureCell(row.position.avgCost), withReason: true },
  {
    id: 'value_inr_minor',
    cell: (row) => (row.position.priced ? cell(row.position.valueMinor) : unmeasuredCell('no_price')),
    withReason: true,
  },
  {
    id: 'value_inr',
    cell: (row) =>
      row.position.priced ? cell(minorToDec(row.position.valueMinor, 'INR')) : unmeasuredCell('no_price'),
    withReason: true,
  },
  {
    id: 'cost_inr_minor',
    cell: (row) =>
      row.position.costMinor === null
        ? unmeasuredCell('no_transaction_history')
        : cell(row.position.costMinor),
    withReason: true,
  },
  {
    id: 'cost_inr',
    cell: (row) =>
      row.position.costMinor === null
        ? unmeasuredCell('no_transaction_history')
        : cell(minorToDec(row.position.costMinor, 'INR')),
    withReason: true,
  },
  {
    id: 'unrealised_inr_minor',
    cell: (row) => figureCell(row.position.unrealised),
    withReason: true,
  },
  { id: 'unrealised_inr', cell: (row) => majorCell(row.position.unrealised), withReason: true },
  { id: 'unrealised_pct', cell: (row) => figureCell(row.position.unrealisedPct), withReason: true },
  { id: 'weight_pct', cell: (row) => cell(row.position.weight) },
]

export function holdingsTable(data: PortfolioData): ExportTable<HoldingRow> {
  return {
    name: 'holdings',
    columns: HOLDING_COLUMNS,
    rows: data.positions.map((position) => ({ asOfDate: data.asOfDate, position })),
  }
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

interface TxnExportRow {
  readonly instrument: InstrumentView
  readonly txn: TxnView
}

/**
 * The transactions whitelist.
 *
 * Fees are not here, and their absence is a real limitation rather than a decision: the view-model
 * folds brokerage, GST, stamp duty and other charges into cost of transfer before this layer sees
 * a transaction, and STT is excluded from that sum by statute. Exporting a `fees` column from what
 * survives would misstate what the user paid, so nothing is exported until the fee columns reach
 * this layer intact. See docs/known-issues.md.
 */
const TXN_COLUMNS: readonly ExportColumn<TxnExportRow>[] = [
  { id: 'date', cell: (row) => cell(row.txn.occurredOn) },
  { id: 'instrument', cell: (row) => cell(row.instrument.name) },
  { id: 'instrument_id', cell: (row) => cell(row.instrument.id) },
  { id: 'asset_class', cell: (row) => cell(row.instrument.assetClass) },
  { id: 'account', cell: (row) => cell(row.txn.accountLabel) },
  { id: 'type', cell: (row) => cell(row.txn.type) },
  { id: 'quantity', cell: (row) => cell(row.txn.quantity) },
  {
    id: 'price',
    cell: (row) => (row.txn.price === null ? unmeasuredCell('no_price') : cell(row.txn.price)),
    withReason: true,
  },
  /*
   * `currency`, then the amount in it.
   *
   * These two columns were `amount_inr_minor` and `amount_inr`, and the transactions table had no
   * currency column at all — so a dollar vest or a USDT-quoted fill was written under a rupee
   * column name with nothing anywhere in the file to contradict it. That is worse than the same
   * mistake on screen: the unit was *in the column name*, the header note asserted paise, and the
   * row's own currency was not exported, so the error was not recoverable from the file by anyone
   * who received it. The `_inr` suffix is retired here and the currency travels beside the figure;
   * `price` is in the same currency and is covered by the same column.
   */
  { id: 'currency', cell: (row) => cell(row.txn.currency) },
  { id: 'amount_minor', cell: (row) => figureCell(row.txn.amount), withReason: true },
  { id: 'amount', cell: (row) => majorCell(row.txn.amount), withReason: true },
]

export function transactionsTable(data: PortfolioData): ExportTable<TxnExportRow> {
  return {
    name: 'transactions',
    columns: TXN_COLUMNS,
    rows: data.instruments.flatMap((instrument) =>
      instrument.transactions.map((txn) => ({ instrument, txn })),
    ),
  }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export type ExportChoiceId = 'holdings-csv' | 'transactions-csv' | 'json'

export interface ExportChoice {
  readonly id: ExportChoiceId
  readonly label: string
  readonly format: ExportFormat
  /** What the file contains, stated before the dialog opens rather than discovered afterwards. */
  readonly description: string
}

export const EXPORT_CHOICES: readonly ExportChoice[] = [
  {
    id: 'holdings-csv',
    label: 'Holdings — CSV',
    format: 'csv',
    description:
      'One row per holding per account, with quantity, price, value, cost and unrealised P&L. A ' +
      'figure Misal cannot measure is an empty cell with the reason beside it, never a zero.',
  },
  {
    id: 'transactions-csv',
    label: 'Transactions — CSV',
    format: 'csv',
    description:
      'Every transaction Misal holds for an instrument currently held, oldest first per ' +
      'instrument. Amounts are in the row’s own currency, never converted. Fees are not ' +
      'exported: they reach this layer already folded together.',
  },
  {
    id: 'json',
    label: 'Everything — JSON',
    format: 'json',
    description:
      'Holdings and transactions in one file. Every value is a string, so nothing is rounded to a ' +
      'JavaScript number on the way out.',
  },
]

/** What the header block says about the two conventions a reader has to know. */
const MONEY_NOTE =
  'Amounts appear twice: <name>_minor is the stored integer in the smallest unit of its currency ' +
  'and <name> is the exact decimal derived from it. Neither is rounded. A column named ' +
  '<name>_inr_minor / <name>_inr is in rupees and paise because Misal converted it — that is the ' +
  'holdings table, where value, cost and unrealised P&L are all converted to INR at the stored ' +
  'rate. The transactions table is NOT converted: each row is in its own currency, given in the ' +
  'currency column beside the amount, and price is quoted in that same currency. Every value is a ' +
  'string; a spreadsheet may turn it into a float when it opens the file, which Misal cannot ' +
  'prevent and has not done.'

const NOT_MEASURED_NOTE =
  'A metric Misal could not measure is empty, and the matching <name>_not_measured column states ' +
  'why. It is never zero: a zero would read as "no gain" rather than "not known".'

const SCOPE_NOTE =
  'Instruments fully exited are not included — closing a position currently makes its history ' +
  'unreachable from the instrument index this export reads.'

export function buildExport(data: PortfolioData, choice: ExportChoiceId): ExportDocument {
  const stamp = data.asOfDate

  if (choice === 'json') {
    const holdings = flatten(holdingsTable(data))
    const transactions = flatten(transactionsTable(data))
    const document: Record<string, string | readonly JsonRecord[] | JsonRecord> = {
      misal_export: {
        version: '1',
        generated_at: data.asOf,
        as_of: stamp,
        money: MONEY_NOTE,
        not_measured: NOT_MEASURED_NOTE,
        scope: SCOPE_NOTE,
      },
      holdings: toRecords(holdings),
      transactions: toRecords(transactions),
    }
    return {
      fileName: `misal-export-${stamp}.json`,
      format: 'json',
      contents: toJson(document),
    }
  }

  const table = choice === 'holdings-csv' ? flatten(holdingsTable(data)) : flatten(transactionsTable(data))
  return {
    fileName: `misal-${table.name}-${stamp}.csv`,
    format: 'csv',
    contents: toCsv(table),
  }
}

export interface ExportOutcome {
  /** False when the user dismissed the save dialog, which is not a failure. */
  readonly saved: boolean
  readonly path: string | null
}

/**
 * Build the document and hand it to the native save dialog.
 *
 * Nothing is written anywhere until the user names a destination, and nothing is written to a
 * temporary file on the way: the contents cross the IPC boundary once, to the path the user chose.
 */
export async function runExport(
  data: PortfolioData,
  choice: ExportChoiceId,
  save: (document: ExportDocument, call?: Invoker) => Promise<string | null> = saveExportDocument,
): Promise<ExportOutcome> {
  const document = buildExport(data, choice)
  const path = await save(document)
  return { saved: path !== null, path }
}

/** Exported for the test that guards the whitelist against growing a secret. */
export const EXPORT_COLUMN_IDS: readonly string[] = [
  ...HOLDING_COLUMNS.map((column) => column.id),
  ...TXN_COLUMNS.map((column) => column.id),
]

assertExportableColumns([...HOLDING_COLUMNS, ...TXN_COLUMNS])
