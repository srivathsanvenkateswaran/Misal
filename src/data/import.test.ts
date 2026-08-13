/**
 * The store the real pipeline writes through.
 *
 * The interesting assertions here are not about shapes. They are that a throw inside the
 * transaction sends nothing at all, that money never becomes a number on its way to Rust, and that
 * the whole pipeline — the real `runImport`, not a stub — can be driven through this store against
 * a fake IPC layer. The last of those is what proves the seam matches, because `MemoryStore`
 * enforces the same uniqueness constraints the migration declares.
 */

import { describe, expect, it, vi } from 'vitest'
import { MemoryStore, csvDescriptorPlugin, loadDescriptor, runImport, type ImportDeps } from '@ingestion/index'
import type { AliasScheme, IngestionWriter } from '@ingestion/store'
import { utf8 } from '@ingestion/hash'
import {
  BufferedWriter,
  SqliteIngestionStore,
  readStatementBytes,
  type ImportBatch,
  type Invoker,
} from './import'

const DESCRIPTOR = `
descriptorVersion: 1
id: zerodha-console-tradebook
providerId: zerodha-kite
displayName: Zerodha Console — tradebook
emits: transactions
capability: ledger

detect:
  requiredHeaders: [symbol, isin, trade_date, trade_type, quantity, price]

file:
  delimiter: ","
  encoding: utf-8
  headerRow: auto
  timezone: Asia/Kolkata
  currency: INR

account:
  realm: broker
  constant: "broker:zerodha"
  labelTemplate: "Zerodha"

instrument:
  isin: isin
  symbol: symbol
  exchange: exchange
  name: symbol
  assetClassHint: { constant: indian_equity }

columns:
  date:     { kind: date, column: trade_date, format: "yyyy-MM-dd" }
  quantity:
    kind: decimal
    column: quantity
    transform:
      negative: never
      signFrom: { column: trade_type, negativeWhen: [sell] }
  price:    { kind: decimal, column: price }
  amount:   { kind: computed, expr: { op: multiply, left: quantity, right: price } }
  description: { kind: text, column: trade_type }

typeRules:
  - when: { column: trade_type, equals: [buy],  ignoreCase: true }
    type: buy
  - when: { column: trade_type, equals: [sell], ignoreCase: true }
    type: sell
`

const TRADEBOOK = [
  'symbol,isin,trade_date,trade_type,quantity,price,exchange',
  'INFY,INE009A01021,2024-04-15,buy,10,1500.5000,NSE',
  'INFY,INE009A01021,2024-07-22,sell,4,1620.0000,NSE',
].join('\n')

/** An IPC layer backed by the reference in-memory store, so the pipeline drives real code. */
function memoryBacked(store: MemoryStore): { call: Invoker; commits: ImportBatch[] } {
  const commits: ImportBatch[] = []
  const call: Invoker = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    const text = (key: string): string => String((args ?? {})[key])
    const count = (key: string): number => Number((args ?? {})[key])
    switch (command) {
      case 'ingest_find_document_by_hash':
        return (await store.findDocumentByHash(text('contentHash'))) as T
      case 'ingest_find_account_by_identity_key':
        return (await store.findAccountByIdentityKey(text('identityKey'))) as T
      case 'ingest_find_instrument_by_isin':
        return (await store.findInstrumentByIsin(text('isin'))) as T
      case 'ingest_find_alias_target':
        return (await store.findAliasTarget(
          text('scheme') as AliasScheme,
          text('value'),
          (args?.providerId ?? null) as string | null,
        )) as T
      case 'ingest_count_txn_by_natural_key':
        return (await store.countTxnByNaturalKey(text('naturalKey'))) as T
      case 'ingest_has_txn':
        return (await store.hasTxn(text('naturalKey'), count('occurrence'))) as T
      case 'ingest_find_position':
        return (await store.findPosition(
          text('accountId'),
          text('instrumentId'),
          text('asOf'),
        )) as T
      case 'ingest_commit': {
        const batch = args?.batch as ImportBatch
        commits.push(batch)
        await applyToMemory(store, batch)
        return undefined as T
      }
      default:
        throw new Error(`unexpected command ${command}`)
    }
  }
  return { call, commits }
}

async function applyToMemory(store: MemoryStore, batch: ImportBatch): Promise<void> {
  await store.transaction(async (writer: IngestionWriter) => {
    if (batch.document !== null) await writer.insertSourceDocument(batch.document)
    for (const account of batch.accounts) await writer.insertAccount(account)
    for (const update of batch.capabilityUpdates) {
      await writer.updateAccountCapability(update.accountId, update.capability)
    }
    for (const alias of batch.aliases) await writer.insertAlias(alias)
    for (const txn of batch.txns) await writer.insertTxn(txn)
    for (const position of batch.positions) await writer.upsertPosition(position)
    for (const entry of batch.unresolved) await writer.insertUnresolvedInstrument(entry)
    if (batch.run !== null) await writer.insertImportRun(batch.run)
    for (const issue of batch.issues) await writer.insertImportIssue(issue)
  })
}

function pluginsFor(): ReturnType<typeof csvDescriptorPlugin>[] {
  const loaded = loadDescriptor(DESCRIPTOR, 'test.yaml')
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors))
  return [csvDescriptorPlugin(loaded.descriptor)]
}

function deps(call: Invoker): ImportDeps {
  let counter = 0
  return {
    store: new SqliteIngestionStore(call),
    plugins: pluginsFor(),
    now: () => '2026-08-12T10:44:00.000Z',
    newId: () => `id-${String((counter += 1))}`,
    parserVersion: '1',
  }
}

describe('SqliteIngestionStore', () => {
  it('sends one commit carrying the whole import', async () => {
    const memory = new MemoryStore()
    const { call, commits } = memoryBacked(memory)
    const outcome = await runImport(
      { bytes: utf8(TRADEBOOK), originalName: 'tradebook.csv' },
      deps(call),
    )

    expect(outcome.status).toBe('completed')
    expect(commits).toHaveLength(1)
    const batch = commits[0]!
    expect(batch.document?.contentHash).toBe(
      outcome.status === 'completed' ? outcome.contentHash : '',
    )
    expect(batch.run?.status).toBe('completed')
    expect(batch.accounts).toHaveLength(1)
    // No instrument catalogue on a fresh database, so both rows are withheld rather than guessed.
    expect(batch.txns).toHaveLength(0)
    expect(batch.unresolved).toHaveLength(1)
    expect(batch.unresolved[0]!.rawIdentifier).toBe('isin:INE009A01021')
  })

  it('writes the transactions once the instrument is known', async () => {
    const memory = new MemoryStore()
    memory.seedInstrument({
      id: 'i-infy',
      assetClass: 'indian_equity',
      displayName: 'Infosys',
      isin: 'INE009A01021',
      currency: 'INR',
    })
    const { call, commits } = memoryBacked(memory)
    await runImport({ bytes: utf8(TRADEBOOK), originalName: 'tradebook.csv' }, deps(call))

    const batch = commits[0]!
    expect(batch.txns).toHaveLength(2)
    expect(batch.unresolved).toHaveLength(0)
    // Money crosses as a string, and the pipeline's amount survives verbatim.
    for (const txn of batch.txns) {
      expect(typeof txn.amountMinor).toBe('string')
      expect(typeof txn.brokerageMinor).toBe('string')
    }
    expect(batch.txns[0]!.amountMinor).toBe('1500500')
    expect(batch.txns[0]!.quantity).toBe('10')
  })

  it('does not send a JSON number anywhere a minor unit belongs', async () => {
    const memory = new MemoryStore()
    memory.seedInstrument({
      id: 'i-infy',
      assetClass: 'indian_equity',
      displayName: 'Infosys',
      isin: 'INE009A01021',
      currency: 'INR',
    })
    const { call, commits } = memoryBacked(memory)
    await runImport({ bytes: utf8(TRADEBOOK), originalName: 'tradebook.csv' }, deps(call))

    // The wire format itself is the assertion: a bare number beside a *Minor key would be a
    // double, and a paise value past 2^53 would be silently rounded on the way to Rust.
    const wire = JSON.stringify(commits[0])
    expect(wire).not.toMatch(/"(amount|brokerage|stt|gst|stampDuty|otherFees|tds)Minor":-?\d/)
    expect(wire).not.toMatch(/"observedValueMinor":-?\d/)
  })

  it('recognises a file it has already imported without writing anything', async () => {
    const memory = new MemoryStore()
    const { call, commits } = memoryBacked(memory)
    const first = await runImport(
      { bytes: utf8(TRADEBOOK), originalName: 'tradebook.csv' },
      deps(call),
    )
    const second = await runImport(
      { bytes: utf8(TRADEBOOK), originalName: 'tradebook-copy.csv' },
      deps(call),
    )

    expect(first.status).toBe('completed')
    expect(second.status).toBe('already-imported')
    expect(commits).toHaveLength(1)
  })

  it('sends nothing at all when the work throws', async () => {
    const call = vi.fn<Invoker>()
    const store = new SqliteIngestionStore(call as unknown as Invoker)
    await expect(
      store.transaction(async (writer) => {
        await writer.insertSourceDocument({
          id: 'd1',
          accountId: null,
          providerId: 'cams-cas',
          kind: 'cas-pdf',
          contentHash: 'h',
          originalName: 'x.pdf',
          periodStart: null,
          periodEnd: null,
          importedAt: 'now',
          pageRef: null,
        })
        throw new Error('normalize gave up')
      }),
    ).rejects.toThrow('normalize gave up')
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses a half-formed import rather than committing it', async () => {
    const call = vi.fn<Invoker>()
    const store = new SqliteIngestionStore(call as unknown as Invoker)
    await expect(store.transaction(() => Promise.resolve(1))).rejects.toThrow('source_document')
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses a direct write outside a transaction', async () => {
    const store = new SqliteIngestionStore(vi.fn())
    await expect(store.insertTxn()).rejects.toThrow('transaction()')
  })
})

describe('BufferedWriter', () => {
  it('keeps one source document and one run per import', async () => {
    const writer = new BufferedWriter()
    const document = {
      id: 'd1',
      accountId: null,
      providerId: 'cams-cas',
      kind: 'cas-pdf' as const,
      contentHash: 'h',
      originalName: 'x.pdf',
      periodStart: null,
      periodEnd: null,
      importedAt: 'now',
      pageRef: null,
    }
    await writer.insertSourceDocument(document)
    expect(() => writer.insertSourceDocument(document)).toThrow('exactly one source_document')
  })
})

describe('readStatementBytes', () => {
  it('accepts the raw ArrayBuffer the command returns', async () => {
    const source = new Uint8Array([1, 2, 3, 250])
    const call = vi.fn().mockResolvedValue(source.buffer) as unknown as Invoker
    expect(await readStatementBytes('/tmp/x.pdf', call)).toEqual(source)
  })
})
