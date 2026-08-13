import { describe, expect, it } from 'vitest'
import { AS_OF, portfolioRows, TRANSACTIONS } from './testing/fixtures'
import { buildPortfolioView } from './view-model'

describe('crypto-quoted txn', () => {
  it('reproduces', () => {
    const cryptoTxn = {
      ...TRANSACTIONS[0],
      id: 't-btc-1',
      currency: 'X:USDT',
      naturalKey: 'bnc:btc:1',
    } as (typeof TRANSACTIONS)[number]
    const view = buildPortfolioView(portfolioRows({ transactions: [...TRANSACTIONS, cryptoTxn] }), AS_OF as never)
    console.log(JSON.stringify(view.ok ? 'OK' : view.message))
    expect(view.ok).toBe(true)
  })
})
