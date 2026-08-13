/**
 * The serialiser, and the thing it exists to prevent.
 *
 * The first test is the whole point of the column-list design: a row object carrying a keychain
 * reference and an API key is handed to the exporter, and neither reaches the file — not because
 * they were stripped, but because nothing ever asked for them.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  ExportError,
  assertExportableColumns,
  cell,
  flatten,
  saveExportDocument,
  toCsv,
  toJson,
  toRecords,
  unmeasuredCell,
} from './export'
import type { ExportTable } from './export'

interface Row {
  readonly label: string
  readonly quantity: string
  readonly cost: string | null
  // Everything below is on the row and must never be on the way out.
  readonly keychainKey: string
  readonly apiKeySecret: string
  readonly credentialRef: string
}

const ROW: Row = {
  label: 'Zerodha Coin',
  quantity: '11240.5560',
  cost: null,
  keychainKey: 'secret/a-coin',
  apiKeySecret: 'sk_live_9f2c11e7b0',
  credentialRef: 'oauth-token:etrade',
}

const TABLE: ExportTable<Row> = {
  name: 'holdings',
  columns: [
    { id: 'account', cell: (row) => cell(row.label) },
    { id: 'quantity', cell: (row) => cell(row.quantity) },
    {
      id: 'cost_inr_minor',
      cell: (row) => (row.cost === null ? unmeasuredCell('no_transaction_history') : cell(row.cost)),
      withReason: true,
    },
  ],
  rows: [ROW],
}

describe('the column whitelist', () => {
  it('writes nothing the columns did not ask for — no key, no keychain handle, no credential', () => {
    const csv = toCsv(flatten(TABLE))
    const json = toJson({ holdings: toRecords(flatten(TABLE)) })

    for (const secret of [ROW.keychainKey, ROW.apiKeySecret, ROW.credentialRef, 'sk_live']) {
      expect(csv).not.toContain(secret)
      expect(json).not.toContain(secret)
    }
    // And the fields it did ask for are all there.
    expect(csv).toContain('Zerodha Coin')
    expect(csv).toContain('11240.5560')
  })

  it('refuses a column named like a secret, so adding one is not an accident', () => {
    expect(() =>
      assertExportableColumns([{ id: 'account' }, { id: 'api_key_secret' }]),
    ).toThrow(ExportError)
    for (const id of ['keychain_key', 'credential_ref', 'access_token', 'passphrase', 'apiKey']) {
      expect(() => assertExportableColumns([{ id }])).toThrow(ExportError)
    }
  })

  it('checks the whitelist as part of flattening, not as an optional extra step', () => {
    expect(() =>
      flatten({
        name: 'holdings',
        columns: [{ id: 'keychain_key', cell: () => cell('secret/a-coin') }],
        rows: [ROW],
      }),
    ).toThrow(ExportError)
  })
})

describe('an unmeasurable metric', () => {
  it('is an empty cell and a reason, never a zero', () => {
    const flat = flatten(TABLE)
    expect(flat.headers).toEqual([
      'account',
      'quantity',
      'cost_inr_minor',
      'cost_inr_minor_not_measured',
    ])
    expect(flat.rows[0]).toEqual(['Zerodha Coin', '11240.5560', '', 'no transaction history'])
    expect(toCsv(flat)).not.toContain(',0,')
  })

  it('is null in JSON, with the reason beside it — not omitted, not zero', () => {
    const [record] = toRecords(flatten(TABLE))
    expect(record?.cost_inr_minor).toBeNull()
    expect(record?.cost_inr_minor_not_measured).toBe('no transaction history')
  })

  it('keeps the reason column even when every row in this export is measured', () => {
    const flat = flatten({ ...TABLE, rows: [{ ...ROW, cost: '62767300' }] })
    expect(flat.headers).toContain('cost_inr_minor_not_measured')
    expect(flat.rows[0]).toEqual(['Zerodha Coin', '11240.5560', '62767300', ''])
  })
})

describe('CSV', () => {
  it('quotes what RFC 4180 requires and doubles an inner quote', () => {
    const csv = toCsv({
      name: 't',
      headers: ['a', 'b'],
      rows: [['plain', 'has, comma'], ['has "quote"', 'has\nnewline']],
    })
    expect(csv).toBe('a,b\r\nplain,"has, comma"\r\n"has ""quote""","has\nnewline"\r\n')
  })

  it('does not touch the digits of a quantity or an amount', () => {
    const csv = toCsv({
      name: 't',
      headers: ['quantity', 'amount_inr_minor'],
      rows: [['0.00000042', '9007199254740993']],
    })
    // The second is past 2^53: a JSON number or a parseFloat would have lost it here.
    expect(csv).toContain('0.00000042,9007199254740993')
  })
})

describe('JSON', () => {
  it('emits strings and nulls only, so nothing becomes a double on the way out', () => {
    const parsed = JSON.parse(toJson({ rows: toRecords(flatten(TABLE)) })) as {
      rows: Record<string, unknown>[]
    }
    const record = parsed.rows[0] ?? {}
    expect(Object.keys(record).length).toBeGreaterThan(0)
    for (const value of Object.values(record)) {
      expect(value === null || typeof value === 'string').toBe(true)
    }
  })
})

describe('saving', () => {
  it('asks the core for the native dialog and reports the path it chose', async () => {
    const call = vi.fn().mockResolvedValue('/Users/x/Desktop/misal-holdings-2026-08-12.csv')
    const path = await saveExportDocument(
      { fileName: 'misal-holdings-2026-08-12.csv', format: 'csv', contents: 'a,b\r\n' },
      call,
    )
    expect(call).toHaveBeenCalledWith('save_export_file', {
      suggestedName: 'misal-holdings-2026-08-12.csv',
      contents: 'a,b\r\n',
    })
    expect(path).toBe('/Users/x/Desktop/misal-holdings-2026-08-12.csv')
  })

  it('treats a dismissed dialog as a null path rather than an error', async () => {
    const call = vi.fn().mockResolvedValue(null)
    await expect(
      saveExportDocument({ fileName: 'x.csv', format: 'csv', contents: '' }, call),
    ).resolves.toBeNull()
  })
})
