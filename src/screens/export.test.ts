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
import { AS_OF, portfolioRows } from './testing/fixtures'

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
      'avg_cost',
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
      'amount_inr_minor',
      'amount_inr',
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
