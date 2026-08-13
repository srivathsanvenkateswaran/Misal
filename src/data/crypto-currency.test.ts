/**
 * A crypto sync must not be able to break the application.
 *
 * Found by adversarial review, and it was the worst defect in the project: the exchange adapters
 * mint `X:USDT` for a non-fiat quote currency — migration 0002 reserves that namespace on purpose
 * — but `buildAccounts` ran every transaction of every account through `requireCurrency`, which
 * accepts only INR and USD. One Binance USDT fill threw, the whole valuation returned not-ok, and
 * because the Shell tested that before the route escape hatch, every screen became an error
 * page — including Settings, Import and Exchanges, the only screens that could have undone it.
 * With no delete-account command, recovery was deleting the encrypted database and every
 * statement ever imported with it.
 *
 * The insult was that the rows were never needed: exchange accounts are `capability: 'snapshot'`,
 * and the engine takes their holdings from the stored snapshot and ignores transactions entirely.
 * The mapping threw on rows nothing would ever read.
 */

import { describe, expect, it } from 'vitest'
import { valueFromRows } from './portfolio'
import type { AliasRow, PortfolioRows } from './client'

const AS_OF = '2026-08-13T10:00:00.000Z'
const ALIASES: AliasRow[] = [
  { instrumentId: 'i-btc', scheme: 'coingecko', value: 'bitcoin', providerId: null },
]

/** A Binance account exactly as the sync writes it: snapshot capability, USDT-quoted fills. */
function rowsWithUsdtFills(): PortfolioRows {
  return {
    accounts: [
      {
        id: 'a-binance',
        providerId: 'binance',
        label: 'Binance',
        externalRef: null,
        identityKey: null,
        capability: 'snapshot',
        baseCurrency: 'INR',
        createdAt: AS_OF,
        providerShortCode: 'BNB',
      },
    ],
    instruments: [
      {
        id: 'i-btc',
        assetClass: 'crypto',
        taxRegime: 'vda',
        displayName: 'Bitcoin',
        isin: null,
        currency: 'INR',
        precision: 8,
        fmv31Jan2018: null,
      },
    ],
    aliases: ALIASES,
    transactions: [
      {
        id: 't-usdt',
        accountId: 'a-binance',
        instrumentId: 'i-btc',
        type: 'buy',
        occurredAt: '2026-03-01T08:00:00.000Z',
        occurredTz: null,
        quantity: '0.02500000',
        price: '64000.00',
        // No minor amount: USDT has no minor unit, so value comes from quantity x price.
        amountMinor: null,
        brokerageMinor: '0',
        sttMinor: '0',
        gstMinor: '0',
        stampDutyMinor: '0',
        otherFeesMinor: '0',
        tdsMinor: '0',
        // The reserved namespace from migration 0002. A real stored value, not a malformed row.
        currency: 'X:USDT',
        fxRate: null,
        sourceDocumentId: 'd1',
        naturalKey: 'nk1',
        occurrence: 0,
        authority: 'primary',
        createdAt: AS_OF,
      },
    ],
    positions: [
      {
        id: 'p1',
        accountId: 'a-binance',
        instrumentId: 'i-btc',
        quantity: '0.02500000',
        asOf: '2026-08-13T00:00:00.000Z',
        sourceDocumentId: 'd1',
      },
    ],
    prices: [
      {
        instrumentId: 'i-btc',
        asOf: '2026-08-13',
        close: '5600000.00',
        currency: 'INR',
        source: 'coingecko',
        fetchedAt: AS_OF,
      },
    ],
    fxRates: [],
    unresolved: [],
    settings: new Map([['base_currency', 'INR']]),
  }
}

describe('a USDT-quoted exchange fill', () => {
  it('does not throw, and does not fail the valuation', () => {
    // Before the fix this threw MappingError and every screen became an error page.
    expect(() => valueFromRows(rowsWithUsdtFills(), ALIASES, AS_OF)).not.toThrow()
    const bundle = valueFromRows(rowsWithUsdtFills(), ALIASES, AS_OF)
    expect(bundle.snapshot.ok).toBe(true)
  })

  it('still values the holding, from the snapshot the engine actually uses', () => {
    const bundle = valueFromRows(rowsWithUsdtFills(), ALIASES, AS_OF)
    expect(bundle.snapshot.ok).toBe(true)
    if (!bundle.snapshot.ok) return
    // 0.025 BTC at Rs 56,00,000 = Rs 1,40,000 = 14000000 paise.
    expect(bundle.snapshot.value.netWorthMinor).toBe('14000000')
  })

  it('still rejects a genuinely unsupported fiat currency on a ledger account', () => {
    // The fix must not become a blanket amnesty. A EUR holding on a ledger account is a real
    // defect - silently treating it as INR would misstate net worth with no visible error.
    const rows = rowsWithUsdtFills()
    const bad: PortfolioRows = {
      ...rows,
      accounts: [{ ...rows.accounts[0]!, capability: 'ledger' }],
      transactions: [{ ...rows.transactions[0]!, currency: 'EUR' }],
    }
    expect(() => valueFromRows(bad, ALIASES, AS_OF)).toThrow(/unsupported currency/)
  })
})
