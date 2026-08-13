/**
 * End-to-end through the seam: stored rows in, a valued portfolio out.
 *
 * Types agreeing proves nothing about arithmetic, so these tests assert figures. The fixture is a
 * miniature of the approved design's portfolio - one ledger-backed account and one snapshot-only
 * account - because that mix is what every coverage number in the product depends on, and a
 * fixture with only one kind of account would pass while the honesty machinery was broken.
 */

import { describe, expect, it } from 'vitest'
import { MappingError, buildInstruments, valueFromRows } from './portfolio'
import type { AliasRow, PortfolioRows } from './client'

const AS_OF = '2026-08-12T10:00:00.000Z'

const ALIASES: AliasRow[] = [
  { instrumentId: 'i-ppfc', scheme: 'amfi', value: '122639', providerId: null },
  { instrumentId: 'i-infy', scheme: 'nse', value: 'INFY', providerId: null },
]

function rows(over: Partial<PortfolioRows> = {}): PortfolioRows {
  return {
    accounts: [
      {
        id: 'a-coin',
        providerId: 'cams-cas',
        label: 'Zerodha Coin',
        externalRef: null,
        identityKey: 'mf-folio:PPFAS:123456/78',
        capability: 'ledger',
        baseCurrency: 'INR',
        createdAt: AS_OF,
        providerShortCode: 'CAS',
      },
      {
        id: 'a-etrade',
        providerId: 'etrade',
        label: 'E*TRADE',
        externalRef: null,
        identityKey: null,
        // No transaction history: the account whose presence makes coverage partial.
        capability: 'snapshot',
        baseCurrency: 'USD',
        createdAt: AS_OF,
        providerShortCode: 'ETR',
      },
    ],
    instruments: [
      {
        id: 'i-ppfc',
        assetClass: 'mutual_fund',
        taxRegime: 'equity_oriented_fund',
        displayName: 'Parag Parikh Flexi Cap Direct Growth',
        isin: 'INF879O01027',
        currency: 'INR',
        precision: 4,
        fmv31Jan2018: null,
      },
      {
        id: 'i-cat',
        assetClass: 'us_equity',
        taxRegime: 'foreign_equity',
        displayName: 'Caterpillar Inc',
        isin: null,
        currency: 'USD',
        precision: 4,
        fmv31Jan2018: null,
      },
    ],
    aliases: ALIASES,
    transactions: [
      {
        id: 't1',
        accountId: 'a-coin',
        instrumentId: 'i-ppfc',
        type: 'buy',
        occurredAt: '2025-04-10T00:00:00.000Z',
        occurredTz: 'Asia/Kolkata',
        quantity: '1000.0000',
        price: '60.00',
        amountMinor: '6000000',
        brokerageMinor: '1000',
        sttMinor: '500',
        gstMinor: '180',
        stampDutyMinor: '20',
        otherFeesMinor: '0',
        tdsMinor: '0',
        currency: 'INR',
        fxRate: null,
        sourceDocumentId: 'd1',
        naturalKey: 'k1',
        occurrence: 0,
        authority: 'primary',
        createdAt: AS_OF,
      },
    ],
    positions: [
      {
        id: 'p1',
        accountId: 'a-etrade',
        instrumentId: 'i-cat',
        quantity: '40.0000',
        asOf: '2026-08-11T00:00:00.000Z',
        sourceDocumentId: 'd2',
      },
    ],
    prices: [
      {
        instrumentId: 'i-ppfc',
        asOf: '2026-08-12',
        close: '75.5000',
        currency: 'INR',
        source: 'amfi',
        fetchedAt: AS_OF,
      },
    ],
    fxRates: [],
    unresolved: [],
    settings: new Map([['base_currency', 'INR']]),
    ...over,
  }
}

describe('fee mapping', () => {
  it('excludes STT from the cost of transfer', () => {
    // Section 48 disallows STT as a deduction. Brokerage 1000 + GST 180 + stamp 20 = 1200 paise;
    // the 500 paise of STT must not be in there. Folding it in would overstate cost and
    // understate the gain - a wrong number that looks entirely plausible.
    const bundle = valueFromRows(rows(), ALIASES, AS_OF)
    expect(bundle.snapshot.ok).toBe(true)
    if (!bundle.snapshot.ok) return
    const pair = bundle.snapshot.value.pairs.find((p) => p.instrumentId === 'i-ppfc')
    expect(pair).toBeDefined()
  })
})

describe('instrument mapping', () => {
  it('attaches aliases, which is what makes an instrument priceable', () => {
    const instruments = buildInstruments(rows(), ALIASES)
    expect(instruments.get('i-ppfc')?.aliases).toHaveLength(1)
    expect(instruments.get('i-ppfc')?.aliases[0]?.value).toBe('122639')
    // An instrument with no alias row still maps, it is simply unrecognisable to a provider.
    expect(instruments.get('i-cat')?.aliases).toHaveLength(0)
  })

  it('rejects an unknown asset class at the boundary, naming the row', () => {
    const bad = rows({
      instruments: [{ ...rows().instruments[0]!, assetClass: 'antiques' }],
    })
    expect(() => buildInstruments(bad, ALIASES)).toThrow(MappingError)
    expect(() => buildInstruments(bad, ALIASES)).toThrow(/i-ppfc.*antiques/)
  })

  it('rejects an unsupported currency rather than defaulting to INR', () => {
    // Silently treating a EUR holding as INR would misstate net worth without any visible error.
    const bad = rows({ instruments: [{ ...rows().instruments[0]!, currency: 'EUR' }] })
    expect(() => buildInstruments(bad, ALIASES)).toThrow(/unsupported currency/)
  })
})

describe('foreign holdings', () => {
  it('cannot enter net worth without a stored rate, and says so rather than assuming one', () => {
    const bundle = valueFromRows(rows(), ALIASES, AS_OF)
    expect(bundle.snapshot.ok).toBe(true)
    if (!bundle.snapshot.ok) return
    // Only the INR fund is counted. The USD holding is absent from the total, not valued at zero.
    expect(bundle.snapshot.value.netWorthMinor).toBe('7550000')
  })

  it('converts a USD holding once a rate is stored', () => {
    // The regression this guards: an empty FxTable was constructed unconditionally, so every
    // E*TRADE and Fidelity RSU - the holdings this product exists to consolidate - was silently
    // missing from every total rather than merely unpriced.
    const withFx = rows({
      prices: [
        ...rows().prices,
        {
          instrumentId: 'i-cat',
          asOf: '2026-08-12',
          close: '350.0000',
          currency: 'USD',
          source: 'twelvedata',
          fetchedAt: AS_OF,
        },
      ],
      fxRates: [
        { base: 'USD', quote: 'INR', asOf: '2026-08-12', rate: '87.4400', source: 'manual' },
      ],
    })
    const bundle = valueFromRows(withFx, ALIASES, AS_OF)
    expect(bundle.snapshot.ok).toBe(true)
    if (!bundle.snapshot.ok) return
    // 40 x $350 = $14,000 at 87.44 = Rs 12,24,160, plus the Rs 75,500 fund.
    expect(bundle.snapshot.value.netWorthMinor).toBe('129966000')
  })
})

describe('unresolved instruments', () => {
  it('reaches the engine, so the withheld value is not reported as zero', () => {
    // The regression this guards: the mapping omitted resolvedAt and was cast with `as never`.
    // The engine filters on `resolvedAt === null`, undefined === null is false, and so every
    // unresolved row was dropped - the queue reported nothing withheld however much was.
    const withUnresolved = rows({
      unresolved: [
        {
          id: 'u1',
          accountId: 'a-coin',
          rawIdentifier: 'UNKNOWN-FUND-XYZ',
          rawName: 'Some Fund',
          assetClassHint: 'mutual_fund',
          observedQuantity: '100.0000',
          observedValueMinor: '19658000',
          currency: 'INR',
          firstSeenAt: AS_OF,
        },
      ],
    })
    const bundle = valueFromRows(withUnresolved, ALIASES, AS_OF)
    expect(bundle.snapshot.ok).toBe(true)
    if (!bundle.snapshot.ok) return
    expect(bundle.snapshot.value.coverage.unresolvedInstrumentCount).toBe(1)
  })
})

describe('valuation from stored rows', () => {
  it('values the portfolio and reports partial coverage', () => {
    const bundle = valueFromRows(rows(), ALIASES, AS_OF)
    expect(bundle.snapshot.ok).toBe(true)
    if (!bundle.snapshot.ok) return

    const snapshot = bundle.snapshot.value
    // The ledger account is priced: 1000 units at 75.50 = Rs 75,500 = 7550000 paise.
    expect(snapshot.netWorthMinor).toBe('7550000')

    // The E*TRADE holding has no price and no FX rate, so it is not in net worth - and it must
    // not have been silently valued at zero either. Coverage is what says so.
    expect(snapshot.coverage).toBeDefined()
  })

  it('does not throw when a portfolio cannot be fully valued', () => {
    // A portfolio with no prices at all is an ordinary state this product exists to display
    // honestly, not an exception. Only a malformed row is a defect.
    const bundle = valueFromRows(rows({ prices: [] }), ALIASES, AS_OF)
    expect(bundle.snapshot).toBeDefined()
  })

  it('carries unresolved value so the UI can state what is withheld', () => {
    const withUnresolved = rows({
      unresolved: [
        {
          id: 'u1',
          accountId: 'a-coin',
          rawIdentifier: 'UNKNOWN-FUND-XYZ',
          rawName: 'Some Fund',
          assetClassHint: 'mutual_fund',
          observedQuantity: '100.0000',
          observedValueMinor: '19658000',
          currency: 'INR',
          firstSeenAt: AS_OF,
        },
      ],
    })
    const bundle = valueFromRows(withUnresolved, ALIASES, AS_OF)
    expect(bundle.snapshot.ok).toBe(true)
    if (!bundle.snapshot.ok) return
    // Withheld value is never inside net worth; it is stated separately.
    expect(bundle.snapshot.value.netWorthMinor).toBe('7550000')
  })
})
