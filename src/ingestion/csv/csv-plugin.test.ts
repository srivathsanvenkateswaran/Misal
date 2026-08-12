import { describe, expect, it } from 'vitest'
import { decodeCsv } from '../acquire'
import { recordGolden, serializeGolden } from '../golden'
import { BUILTIN_DESCRIPTOR_IDS, builtinDescriptor, golden, readFixtureBytes } from '../testing/fixtures'
import { csvDescriptorPlugin } from './csv-plugin'
import { loadDescriptor } from './load'
import type { NormalizedTransaction } from '../types'

function run(descriptorId: string, fixture: string) {
  const descriptor = builtinDescriptor(descriptorId)
  const plugin = csvDescriptorPlugin(descriptor)
  const input = decodeCsv(readFixtureBytes(fixture), {
    delimiter: descriptor.file.delimiter,
    encoding: descriptor.file.encoding,
  })
  return { descriptor, plugin, input }
}

describe('descriptor validation', () => {
  it('accepts every descriptor in the repository', () => {
    for (const id of BUILTIN_DESCRIPTOR_IDS) {
      expect(builtinDescriptor(id).id).toBe(id)
    }
  })

  it('rejects an unknown key, and says where it is', () => {
    const source = [
      'descriptorVersion: 1',
      'id: broken',
      'providerId: broken',
      'displayName: Broken',
      'emits: transactions',
      'capability: ledger',
      'detect: { requiredHeaders: [a] }',
      'file:',
      '  delimiter: ","',
      '  encoding: utf-8',
      '  headerRow: auto',
      '  timezone: Asia/Kolkata',
      '  currency: INR',
      '  delimeter: ","',
      'account: { realm: broker, constant: "broker:x", labelTemplate: X }',
      'instrument: { name: a }',
      'columns: {}',
    ].join('\n')

    const result = loadDescriptor(source, 'broken.yaml')
    expect(result.ok).toBe(false)
    if (result.ok) return
    // A typo'd key that passes silently is a mapping the contributor believes is active.
    expect(result.text).toMatch(/delimeter/)
    expect(result.errors.some((e) => e.line !== null)).toBe(true)
  })

  it('rejects a fifth computed operation', () => {
    const source = [
      'descriptorVersion: 1',
      'id: broken',
      'providerId: broken',
      'displayName: Broken',
      'emits: transactions',
      'capability: ledger',
      'detect: { requiredHeaders: [a] }',
      'file: { delimiter: ",", encoding: utf-8, headerRow: auto, timezone: Asia/Kolkata, currency: INR }',
      'account: { realm: broker, constant: "broker:x", labelTemplate: X }',
      'instrument: { name: a }',
      'columns:',
      '  amount: { kind: computed, expr: { op: divide, left: a, right: b } }',
    ].join('\n')

    const result = loadDescriptor(source, 'broken.yaml')
    expect(result.ok).toBe(false)
  })
})

describe('zerodha console tradebook', () => {
  it('matches its golden file', async () => {
    const { plugin, input } = run('zerodha-console-tradebook', 'csv/zerodha-console-tradebook.csv')
    const actual = serializeGolden(await recordGolden(plugin, input))
    expect(actual).toBe(golden('csv/golden/zerodha-console-tradebook.json', actual))
  })

  it('takes the sign from the side column, not from the number', async () => {
    const { plugin, input } = run('zerodha-console-tradebook', 'csv/zerodha-console-tradebook.csv')
    const { records } = await recordGolden(plugin, input)
    const sell = records.find(
      (r): r is NormalizedTransaction => r.kind === 'transaction' && r.txnType === 'sell',
    )
    expect(sell?.quantity.value).toBe('-7')
    // 7 x 1610.75 = 11275.25, and the computed amount keeps the scale of its operands.
    expect(sell?.amountMinor).toBe('-1127525')
  })

  it('detects only the file it owns', () => {
    const { plugin, input } = run('zerodha-console-tradebook', 'csv/zerodha-console-tradebook.csv')
    const other = run('mybroker-account-statement', 'csv/mybroker-account-statement.csv')
    expect(plugin.detect(input)).toBeGreaterThan(0.8)
    expect(plugin.detect(other.input)).toBe(0)
    expect(other.plugin.detect(input)).toBe(0)
  })

  it('warns that the source carries no charges', async () => {
    const { plugin, input } = run('zerodha-console-tradebook', 'csv/zerodha-console-tradebook.csv')
    const { issues } = await recordGolden(plugin, input)
    expect(issues.filter((i) => i.code === 'W_FEES_ABSENT')).toHaveLength(1)
  })
})

describe('a damaged file still imports', () => {
  it('fails only the bad rows and keeps the rest', async () => {
    const { plugin, input } = run(
      'zerodha-console-tradebook',
      'csv/zerodha-console-tradebook-damaged.csv',
    )
    const { records, issues } = await recordGolden(plugin, input)

    const codes = issues.filter((i) => i.severity === 'error').map((i) => i.code)
    expect(codes).toContain('E_DATE_PARSE') // 15-06-2024 against yyyy-MM-dd
    expect(codes).toContain('E_NUMERIC_PARSE') // quantity `4O`
    expect(codes).toContain('E_UNCLASSIFIED_TRANSACTION') // trade_type `switch`

    // Two good rows survive, and every failure carries a payload that can be replayed.
    const transactions = records.filter((r) => r.kind === 'transaction')
    expect(transactions).toHaveLength(2)
    for (const issue of issues.filter((i) => i.severity === 'error')) {
      expect(issue.raw).toBeDefined()
      expect(issue.ref).toMatch(/^row \d+$/)
    }
  })
})

describe('mybroker account statement', () => {
  it('matches its golden file', async () => {
    const { plugin, input } = run('mybroker-account-statement', 'csv/mybroker-account-statement.csv')
    const actual = serializeGolden(await recordGolden(plugin, input))
    expect(actual).toBe(golden('csv/golden/mybroker-account-statement.json', actual))
  })

  it('reads Indian grouping, parenthesised debits and a charges column', async () => {
    const { plugin, input } = run('mybroker-account-statement', 'csv/mybroker-account-statement.csv')
    const { records } = await recordGolden(plugin, input)
    const buy = records.find(
      (r): r is NormalizedTransaction => r.kind === 'transaction' && r.txnType === 'buy',
    )
    expect(buy?.amountMinor).toBe('-3850500')
    expect(buy?.price?.value).toBe('3850.50')
    expect(buy?.fees.other).toBe('4230')
  })

  it('skips the Total footer instead of failing it', async () => {
    const { plugin, input } = run('mybroker-account-statement', 'csv/mybroker-account-statement.csv')
    const { skipped, issues } = await recordGolden(plugin, input)
    expect(skipped).toHaveLength(1)
    expect(issues.some((i) => i.code === 'E_DATE_PARSE')).toBe(false)
  })

  it('classifies the dividend row, which has neither quantity nor price', async () => {
    const { plugin, input } = run('mybroker-account-statement', 'csv/mybroker-account-statement.csv')
    const { records } = await recordGolden(plugin, input)
    const dividend = records.find(
      (r): r is NormalizedTransaction => r.kind === 'transaction' && r.txnType === 'dividend',
    )
    expect(dividend?.quantity.value).toBe('0')
    expect(dividend?.amountMinor).toBe('60000')
  })
})
