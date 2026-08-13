/**
 * What the exported files actually contain, driven through the whole pipeline: stored rows, the
 * valuation engine, the view-models, the column whitelists and the serialiser.
 *
 * The fixture is deliberately awkward — a snapshot account with no cost basis, a holding priced in
 * a currency with no stored rate, a fifteen-day-old price — because those are the rows where an
 * exporter is tempted to write a zero.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  EXPORT_CHOICES,
  EXPORT_COLUMN_IDS,
  buildExport,
  holdingsTable,
  runExport,
  transactionsTable,
} from './export'
import { flatten } from '../data/export'
import { buildPortfolioView } from './view-model'
import type { PortfolioData } from './view-model'
import { AS_OF, noPricesRows, portfolioRows, usdLedgerRows } from './testing/fixtures'

/**
 * Built once. `buildPortfolioView` values the portfolio at twelve month ends as well as today, so
 * rebuilding it per assertion costs more than the whole rest of this file.
 */
let built: PortfolioData | null = null
function data(): PortfolioData {
  if (built === null) {
    const view = buildPortfolioView(portfolioRows(), AS_OF)
    if (!view.ok) throw new Error(view.message)
    built = view.data
  }
  return built
}

/** The same, over the account that reports in dollars. Built once for the same reason. */
let builtUsd: PortfolioData | null = null
function usdData(): PortfolioData {
  if (builtUsd === null) {
    const view = buildPortfolioView(usdLedgerRows(), AS_OF)
    if (!view.ok) throw new Error(view.message)
    builtUsd = view.data
  }
  return builtUsd
}

function csvRows(text: string): readonly (readonly string[])[] {
  return text
    .trimEnd()
    .split('\r\n')
    .map((line) => line.split(','))
}

describe('the exported column lists', () => {
  it('is the whitelist, and nothing in it names a secret', () => {
    // Locked down on purpose: a new column is a deliberate edit here as well as there.
    expect(EXPORT_COLUMN_IDS).toEqual([
      'as_of',
      'account',
      'account_history',
      'instrument',
      'instrument_id',
      'asset_class',
      'identifiers',
      'instrument_currency',
      'quantity',
      'last_price',
      // Not `avg_cost`. It divides a cost basis Misal has already converted, so it is rupees per
      // unit in a row whose `instrument_currency` may say USD — the `_inr` suffix is this file's
      // word for "converted", and it is what happened to this figure.
      'avg_cost_inr',
      'value_inr_minor',
      'value_inr',
      'cost_inr_minor',
      'cost_inr',
      'unrealised_inr_minor',
      'unrealised_inr',
      'unrealised_pct',
      'weight_pct',
      'date',
      'instrument',
      'instrument_id',
      'asset_class',
      'account',
      'type',
      'quantity',
      'price',
      // Not `amount_inr_*`. The transactions table exports the stored amount unconverted, so the
      // unit belongs in a column of its own rather than in the column name — where it was both
      // wrong for every non-rupee row and unrecoverable, since the row's currency was not exported
      // at all.
      'currency',
      'amount_minor',
      'amount',
    ])
  })

  it('exports nothing that looks like a credential, in either file', () => {
    const files = EXPORT_CHOICES.map((choice) => buildExport(data(), choice.id).contents).join('\n')
    for (const forbidden of [
      'secret',
      'api_key',
      'apiKey',
      'keychain',
      'credential',
      'token',
      'password',
    ]) {
      expect(files.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })
})

describe('holdings', () => {
  it('exports money as the stored paise and the exact rupee decimal, unrounded', () => {
    const flat = flatten(holdingsTable(data()))
    const valueMinor = flat.headers.indexOf('value_inr_minor')
    const value = flat.headers.indexOf('value_inr')
    const row = flat.rows.find((entry) => entry[valueMinor] !== '')
    expect(row).toBeDefined()
    const minor = row?.[valueMinor] ?? ''
    const major = row?.[value] ?? ''
    expect(minor).toMatch(/^-?\d+$/u)
    // The rupee figure is the paise figure divided by a hundred, exactly: multiplying it back in
    // integer arithmetic returns the stored paise, digit for digit.
    const [whole = '0', fraction = ''] = major.split('.')
    expect(BigInt(whole + fraction.padEnd(2, '0'))).toBe(BigInt(minor))
  })

  it('exports a quantity exactly as stored, trailing zeros and all', () => {
    const flat = flatten(holdingsTable(data()))
    const quantity = flat.headers.indexOf('quantity')
    const quantities = flat.rows.map((row) => row[quantity])
    expect(quantities).toContain('21.4790')
  })

  it('leaves an unmeasurable cost empty and states why, rather than writing zero', () => {
    const flat = flatten(holdingsTable(data()))
    const account = flat.headers.indexOf('account')
    const cost = flat.headers.indexOf('cost_inr')
    const reason = flat.headers.indexOf('cost_inr_not_measured')
    const gold = flat.rows.find((row) => row[account] === 'Augmont Digital Gold')
    expect(gold?.[cost]).toBe('')
    expect(gold?.[reason]).toBe('no transaction history')
  })

  it('does not write a rupee average cost under a row declaring dollars', () => {
    /*
     * The Caterpillar row was in every `flatten()` result this file already built, and nothing
     * looked at the column: `instrument_currency=USD, last_price=376.2000, avg_cost=28705.82`.
     * Read under the unit the row itself declares — which is the only unit a recipient of the file
     * has — that is a 98.7% loss stated two columns from an `unrealised_pct` of +14.67, and the
     * mismatch is the exchange rate, about 85×.
     *
     * The unit is asserted in the row's own metadata here, and the file outlives the screen, so
     * this is the worse of the two surfaces the same quotient reaches.
     */
    const flat = flatten(holdingsTable(usdData()))
    expect(flat.headers).not.toContain('avg_cost')
    expect(flat.headers).toContain('avg_cost_inr')

    const instrument = flat.headers.indexOf('instrument')
    const currency = flat.headers.indexOf('instrument_currency')
    const lastPrice = flat.headers.indexOf('last_price')
    const avgCost = flat.headers.indexOf('avg_cost_inr')
    const cost = flat.headers.indexOf('cost_inr')
    const quantity = flat.headers.indexOf('quantity')

    const cat = flat.rows.find((row) => row[instrument] === 'Caterpillar Inc')
    expect(cat?.[currency]).toBe('USD')
    // Native, and the only column in this table that is.
    expect(cat?.[lastPrice]).toBe('376.2000')
    // Converted, and now named as converted: it is `cost_inr` divided by `quantity`, which is a
    // derivation a recipient can check against two other columns of the same row.
    expect(cat?.[cost]).toBe('975998')
    expect(cat?.[quantity]).toBe('34')
    expect(cat?.[avgCost]).toMatch(/^28705\.8235/u)
  })

  it('says a holding it cannot price is unpriced, not worth nothing', () => {
    const flat = flatten(holdingsTable(data()))
    const instrument = flat.headers.indexOf('instrument')
    const value = flat.headers.indexOf('value_inr')
    const reason = flat.headers.indexOf('value_inr_not_measured')
    // Caterpillar is quoted in dollars with no stored rupee rate anywhere.
    const cat = flat.rows.find((row) => row[instrument] === 'Caterpillar Inc')
    expect(cat?.[value]).toBe('')
    expect(cat?.[reason]).toMatch(/no (price|exchange rate)/u)
  })

  it('writes no rupee figure at all on an install that has fetched no price', () => {
    // Every holding unpriced, which is the state of any install between its first import and its
    // first refresh. The screens summed these rows to a measured ₹0; the export asks `priced` per
    // row, and this asserts that it keeps doing so for a file where *no* row is priced.
    const view = buildPortfolioView(noPricesRows(), AS_OF)
    if (!view.ok) throw new Error(view.message)
    const flat = flatten(holdingsTable(view.data))
    const value = flat.headers.indexOf('value_inr')
    const valueMinor = flat.headers.indexOf('value_inr_minor')
    const reason = flat.headers.indexOf('value_inr_not_measured')
    const quantity = flat.headers.indexOf('quantity')

    expect(flat.rows.length).toBeGreaterThan(0)
    for (const row of flat.rows) {
      expect(row[value]).toBe('')
      expect(row[valueMinor]).toBe('')
      expect(row[reason]).toBe('no price available')
      // The quantity is still there: the units are known, and only their value is not.
      expect(row[quantity]).not.toBe('')
    }
  })
})

describe('transactions', () => {
  it('exports every stored transaction of every held instrument', () => {
    const table = transactionsTable(data())
    const expected = data().instruments.reduce(
      (total, instrument) => total + instrument.transactions.length,
      0,
    )
    expect(table.rows).toHaveLength(expected)
    expect(expected).toBeGreaterThan(20)
  })

  it('keeps a redemption negative, with the sign the ledger stored', () => {
    const flat = flatten(transactionsTable(data()))
    const quantity = flat.headers.indexOf('quantity')
    expect(flat.rows.map((row) => row[quantity])).toContain('-300.0000')
  })

  it('writes a dollar amount under a currency column, not under a rupee column name', () => {
    /*
     * The worst version of the defect, because the unit was in the column *name*: a dollar vest
     * was written as `amount_inr_minor` / `amount_inr`, the header note asserted "the stored
     * integer in paise", and the table carried no currency column at all — so the error was not
     * recoverable from the file by whoever received it.
     */
    const flat = flatten(transactionsTable(usdData()))
    expect(flat.headers).not.toContain('amount_inr_minor')
    expect(flat.headers).not.toContain('amount_inr')

    const account = flat.headers.indexOf('account')
    const date = flat.headers.indexOf('date')
    const currency = flat.headers.indexOf('currency')
    const amountMinor = flat.headers.indexOf('amount_minor')
    const amount = flat.headers.indexOf('amount')
    const price = flat.headers.indexOf('price')

    // 12 units at $310.
    const vest = flat.rows.find(
      (row) => row[account]?.startsWith('E*TRADE') === true && row[date] === '2024-11-14',
    )
    expect(vest?.[currency]).toBe('USD')
    // Cents, and the currency column beside it is what makes the integer mean anything.
    expect(vest?.[amountMinor]).toBe('372000')
    expect(vest?.[amount]).toBe('3720')
    expect(vest?.[price]).toBe('310.0000')

    // Rupee rows are unaffected, and now say which they are.
    const rupee = flat.rows.find((row) => row[account] === 'Zerodha Kite')
    expect(rupee?.[currency]).toBe('INR')
  })

  it('states the convention it actually follows, per table', () => {
    const parsed = JSON.parse(buildExport(usdData(), 'json').contents) as {
      misal_export: Record<string, string>
    }
    expect(parsed.misal_export.money).toContain('<name>_minor')
    expect(parsed.misal_export.money).toContain('in its own currency')
    // The old note asserted paise of every amount column in the file, which the transactions
    // table has never been able to honour.
    expect(parsed.misal_export.money).not.toMatch(/^Amounts appear twice: <name>_inr_minor/u)
  })
})

describe('the files', () => {
  it('writes a CSV whose every row has as many fields as the header', () => {
    const csv = buildExport(data(), 'holdings-csv')
    expect(csv.fileName).toBe('misal-holdings-2026-08-12.csv')
    const rows = csvRows(csv.contents)
    const width = rows[0]?.length ?? 0
    expect(width).toBeGreaterThan(20)
    for (const row of rows) expect(row).toHaveLength(width)
  })

  it('writes a JSON file of strings and nulls, with the two conventions stated in it', () => {
    const json = buildExport(data(), 'json')
    expect(json.fileName).toBe('misal-export-2026-08-12.json')
    const parsed = JSON.parse(json.contents) as {
      misal_export: Record<string, string>
      holdings: Record<string, unknown>[]
      transactions: Record<string, unknown>[]
    }
    expect(parsed.misal_export.not_measured).toMatch(/never zero/u)
    expect(parsed.holdings.length).toBeGreaterThan(0)
    expect(parsed.transactions.length).toBeGreaterThan(0)
    for (const record of [...parsed.holdings, ...parsed.transactions]) {
      for (const value of Object.values(record)) {
        expect(value === null || typeof value === 'string').toBe(true)
      }
    }
  })

  it('hands the document to the save dialog and reports what happened', async () => {
    const save = vi.fn().mockResolvedValue('/tmp/misal-holdings-2026-08-12.csv')
    const outcome = await runExport(data(), 'holdings-csv', save)
    expect(outcome).toEqual({ saved: true, path: '/tmp/misal-holdings-2026-08-12.csv' })

    const dismissed = vi.fn().mockResolvedValue(null)
    expect(await runExport(data(), 'json', dismissed)).toEqual({ saved: false, path: null })
  })
})
