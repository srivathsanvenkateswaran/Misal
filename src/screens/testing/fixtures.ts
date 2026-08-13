/**
 * Screen fixtures — stored rows, not view-models.
 *
 * The fixtures are `PortfolioRows` so that every screen test drives the *whole* pipeline: the
 * mapping boundary, the fold, the valuation engine, the coverage report and the view-models. A
 * fixture of pre-built view-models would let the honesty machinery break while every screen test
 * still passed, which is precisely the failure these tests exist to catch.
 *
 * The shape is the approved mockup's in miniature: ledger accounts alongside snapshot ones, one
 * holding priced in a currency with no stored rate, one price fifteen days stale, and one
 * unresolved identifier holding value back from every total.
 *
 * Every money figure is written as paise and every quantity as its stored digits. Nothing here is
 * the product of arithmetic on a JavaScript number.
 */

import type {
  AccountRow,
  AliasRow,
  InstrumentRow,
  PortfolioRows,
  PositionRow,
  PriceRow,
  TxnRow,
  UnresolvedRow,
} from '../../data/client'

export const AS_OF = '2026-08-12T10:00:00+05:30'

const NO_FEES = {
  brokerageMinor: '0',
  sttMinor: '0',
  gstMinor: '0',
  stampDutyMinor: '0',
  otherFeesMinor: '0',
  tdsMinor: '0',
} as const

export const ACCOUNTS: readonly AccountRow[] = [
  {
    id: 'a-coin',
    providerId: 'cams-cas',
    label: 'Zerodha Coin',
    externalRef: null,
    identityKey: 'mf-folio:PPFAS:91043278/22',
    capability: 'ledger',
    baseCurrency: 'INR',
    createdAt: '2024-08-01T00:00:00+05:30',
    providerShortCode: 'CAS',
  },
  {
    id: 'a-kite',
    providerId: 'zerodha-kite',
    label: 'Zerodha Kite',
    externalRef: 'ZR8842',
    identityKey: 'ucc:ZR8842',
    capability: 'ledger',
    baseCurrency: 'INR',
    createdAt: '2024-08-01T00:00:00+05:30',
    providerShortCode: 'KIT',
  },
  {
    id: 'a-gold',
    providerId: 'augmont',
    label: 'Augmont Digital Gold',
    externalRef: null,
    identityKey: null,
    capability: 'snapshot',
    baseCurrency: 'INR',
    createdAt: '2025-02-01T00:00:00+05:30',
    providerShortCode: 'GRW',
  },
  {
    id: 'a-etrade',
    providerId: 'etrade',
    label: 'E*TRADE — Morgan Stanley',
    externalRef: null,
    identityKey: null,
    capability: 'snapshot',
    baseCurrency: 'USD',
    createdAt: '2025-02-01T00:00:00+05:30',
    providerShortCode: 'ETR',
  },
]

export const INSTRUMENTS: readonly InstrumentRow[] = [
  {
    id: 'i-ppfc',
    assetClass: 'mutual_fund',
    taxRegime: 'other_mf_listed',
    displayName: 'Parag Parikh Flexi Cap',
    isin: 'INF879O01019',
    currency: 'INR',
    precision: 4,
    fmv31Jan2018: null,
  },
  {
    id: 'i-rel',
    assetClass: 'indian_equity',
    taxRegime: 's112a_listed_equity',
    displayName: 'Reliance Industries',
    isin: 'INE002A01018',
    currency: 'INR',
    precision: 0,
    fmv31Jan2018: null,
  },
  {
    id: 'i-gold',
    assetClass: 'gold',
    taxRegime: 'other_asset',
    displayName: 'Augmont Digital Gold',
    isin: null,
    currency: 'INR',
    precision: 4,
    fmv31Jan2018: null,
  },
  {
    id: 'i-cat',
    assetClass: 'us_equity',
    taxRegime: 'foreign_equity',
    displayName: 'Caterpillar Inc',
    isin: 'US1491231015',
    currency: 'USD',
    precision: 4,
    fmv31Jan2018: null,
  },
]

export const ALIASES: readonly AliasRow[] = [
  { instrumentId: 'i-ppfc', scheme: 'amfi', value: '122639', providerId: null },
  { instrumentId: 'i-rel', scheme: 'nse', value: 'RELIANCE', providerId: null },
]

/** `48.2100` → the amount in paise for `units` whole units, in exact integer maths. */
function amountFrom(price: string, units: bigint, decimals: bigint): string {
  const scaled = BigInt(price.replace('.', ''))
  // scaled is price × 10^decimals; paise = price × 100 × units = scaled × units / 10^(decimals-2)
  return ((scaled * units) / 10n ** (decimals - 2n)).toString()
}

interface Sip {
  readonly month: string
  readonly nav: string
}

/**
 * Twenty-four monthly purchases. The span matters: the earliest lots are more than twelve months
 * old at the valuation date and the latest are not, so the one redemption below produces both a
 * long-term and a short-term disposal and the realised split has something real in it.
 */
const SIPS: readonly Sip[] = [
  { month: '2024-09', nav: '48.2100' },
  { month: '2024-10', nav: '49.0600' },
  { month: '2024-11', nav: '50.1200' },
  { month: '2024-12', nav: '51.3400' },
  { month: '2025-01', nav: '52.1100' },
  { month: '2025-02', nav: '51.0900' },
  { month: '2025-03', nav: '53.4400' },
  { month: '2025-04', nav: '54.9000' },
  { month: '2025-05', nav: '56.1200' },
  { month: '2025-06', nav: '57.8900' },
  { month: '2025-07', nav: '58.4400' },
  { month: '2025-08', nav: '59.9100' },
  { month: '2025-09', nav: '60.7700' },
  { month: '2025-10', nav: '61.4200' },
  { month: '2025-11', nav: '62.8800' },
  { month: '2025-12', nav: '63.1900' },
  { month: '2026-01', nav: '64.5400' },
  { month: '2026-02', nav: '63.7700' },
  { month: '2026-03', nav: '65.0200' },
  { month: '2026-04', nav: '66.4100' },
  { month: '2026-05', nav: '65.8300' },
  { month: '2026-06', nav: '68.0500' },
  { month: '2026-07', nav: '69.1000' },
  { month: '2026-08', nav: '69.7670' },
]

const SIP_UNITS = 200n

function sipTxns(): readonly TxnRow[] {
  return SIPS.map((sip, index) => ({
    id: `t-ppfc-${index.toString().padStart(2, '0')}`,
    accountId: 'a-coin',
    instrumentId: 'i-ppfc',
    type: 'buy',
    occurredAt: `${sip.month}-07T00:00:00+05:30`,
    occurredTz: 'Asia/Kolkata',
    quantity: `${SIP_UNITS.toString()}.0000`,
    price: sip.nav,
    amountMinor: amountFrom(sip.nav, SIP_UNITS, 4n),
    ...NO_FEES,
    currency: 'INR',
    fxRate: null,
    sourceDocumentId: 'd-cas-1',
    naturalKey: `cas:ppfc:${sip.month}`,
    occurrence: index,
    authority: 'primary',
    createdAt: '2026-08-12T10:44:00+05:30',
  }))
}

/** One redemption, so the realised panel has a real disposal rather than an empty state. */
const REDEMPTION: TxnRow = {
  id: 't-ppfc-sell',
  accountId: 'a-coin',
  instrumentId: 'i-ppfc',
  type: 'sell',
  occurredAt: '2026-05-12T00:00:00+05:30',
  occurredTz: 'Asia/Kolkata',
  quantity: '-300.0000',
  price: '65.0200',
  amountMinor: amountFrom('65.0200', 300n, 4n),
  ...NO_FEES,
  currency: 'INR',
  fxRate: null,
  sourceDocumentId: 'd-cas-1',
  naturalKey: 'cas:ppfc:redeem-2026-05',
  occurrence: 99,
  authority: 'primary',
  createdAt: '2026-08-12T10:44:00+05:30',
}

interface Trade {
  readonly id: string
  readonly date: string
  readonly units: bigint
  readonly price: string
}

const RELIANCE_TRADES: readonly Trade[] = [
  { id: 'r18', date: '2024-11-14', units: 80n, price: '2412.75' },
  { id: 'r47', date: '2025-06-03', units: 55n, price: '2648.10' },
  { id: 'r91', date: '2026-02-19', units: 30n, price: '2790.45' },
]

function relianceTxns(): readonly TxnRow[] {
  return RELIANCE_TRADES.map((trade, index) => ({
    id: `t-rel-${trade.id}`,
    accountId: 'a-kite',
    instrumentId: 'i-rel',
    type: 'buy',
    occurredAt: `${trade.date}T09:30:00+05:30`,
    occurredTz: 'Asia/Kolkata',
    quantity: `${trade.units.toString()}`,
    price: trade.price,
    amountMinor: amountFrom(trade.price, trade.units, 2n),
    ...NO_FEES,
    currency: 'INR',
    fxRate: null,
    sourceDocumentId: 'd-kite-1',
    naturalKey: `kite:rel:${trade.id}`,
    occurrence: index,
    authority: 'primary',
    createdAt: '2026-08-12T09:12:00+05:30',
  }))
}

export const TRANSACTIONS: readonly TxnRow[] = [...sipTxns(), REDEMPTION, ...relianceTxns()]

/**
 * Snapshot rows only for the snapshot accounts. A ledger account's statement balances are the
 * engine's independent check on its own fold; supplying them here would make the fixture assert
 * agreement rather than exercise the fold.
 */
export const POSITIONS: readonly PositionRow[] = [
  {
    id: 'p-gold',
    accountId: 'a-gold',
    instrumentId: 'i-gold',
    quantity: '21.4790',
    asOf: '2026-08-10T00:00:00+05:30',
    sourceDocumentId: 'd-grw-1',
  },
  {
    id: 'p-cat',
    accountId: 'a-etrade',
    instrumentId: 'i-cat',
    quantity: '34.0000',
    asOf: '2026-08-09T00:00:00+05:30',
    sourceDocumentId: 'd-etr-1',
  },
]

const MONTH_ENDS: readonly string[] = [
  '2025-09-30',
  '2025-10-31',
  '2025-11-30',
  '2025-12-31',
  '2026-01-31',
  '2026-02-28',
  '2026-03-31',
  '2026-04-30',
  '2026-05-31',
  '2026-06-30',
  '2026-07-31',
]

const PPFC_MONTH_END_NAV: readonly string[] = [
  '60.9100', '61.5200', '62.9900', '63.2400', '64.6100', '63.8800',
  '65.1400', '66.5200', '65.9400', '68.1600', '69.2200',
]

const RELIANCE_MONTH_END: readonly string[] = [
  '2688.40', '2712.55', '2745.90', '2760.20', '2802.35', '2778.60',
  '2811.90', '2856.45', '2833.70', '2894.15', '2908.60',
]

function monthlyPrices(): readonly PriceRow[] {
  const rows: PriceRow[] = []
  MONTH_ENDS.forEach((asOf, index) => {
    const nav = PPFC_MONTH_END_NAV[index]
    const close = RELIANCE_MONTH_END[index]
    if (nav !== undefined) {
      rows.push({
        instrumentId: 'i-ppfc',
        asOf,
        close: nav,
        currency: 'INR',
        source: 'amfi',
        fetchedAt: `${asOf}T20:00:00+05:30`,
      })
    }
    if (close !== undefined) {
      rows.push({
        instrumentId: 'i-rel',
        asOf,
        close,
        currency: 'INR',
        source: 'twelvedata',
        fetchedAt: `${asOf}T20:00:00+05:30`,
      })
    }
  })
  return rows
}

export const PRICES: readonly PriceRow[] = [
  ...monthlyPrices(),
  {
    instrumentId: 'i-ppfc',
    asOf: '2026-08-11',
    close: '69.7670',
    currency: 'INR',
    source: 'amfi',
    fetchedAt: '2026-08-12T10:52:00+05:30',
  },
  {
    instrumentId: 'i-rel',
    asOf: '2026-08-11',
    close: '2908.60',
    currency: 'INR',
    source: 'twelvedata',
    fetchedAt: '2026-08-12T10:52:00+05:30',
  },
  // Fifteen days old at the valuation date: the fixture that keeps H7 honest.
  {
    instrumentId: 'i-gold',
    asOf: '2026-07-28',
    close: '11173.6500',
    currency: 'INR',
    source: 'manual',
    fetchedAt: '2026-07-28T18:20:00+05:30',
  },
  // Priced in dollars, with no stored INR rate anywhere. The holding is therefore *not converted*
  // rather than converted at a guess, and it is excluded from net worth with that stated.
  {
    instrumentId: 'i-cat',
    asOf: '2026-08-11',
    close: '376.2000',
    currency: 'USD',
    source: 'twelvedata',
    fetchedAt: '2026-08-12T10:52:00+05:30',
  },
]

export const UNRESOLVED: readonly UnresolvedRow[] = [
  {
    id: 'u-rsu',
    accountId: 'a-etrade',
    rawIdentifier: 'CAT-RSU-VEST-2024-11',
    rawName: 'Caterpillar RSU vest',
    assetClassHint: 'us_equity',
    observedQuantity: '12.0000',
    observedValueMinor: '39420000',
    currency: 'INR',
    firstSeenAt: '2026-08-09T21:03:00+05:30',
  },
]

export function portfolioRows(over: Partial<PortfolioRows> = {}): PortfolioRows {
  return {
    accounts: ACCOUNTS,
    instruments: INSTRUMENTS,
    aliases: ALIASES,
    transactions: TRANSACTIONS,
    positions: POSITIONS,
    prices: PRICES,
    fxRates: [],
  unresolved: UNRESOLVED,
    settings: new Map([['base_currency', 'INR']]),
    ...over,
  }
}

/** First run: a new user, with nothing at all. */
export function emptyRows(): PortfolioRows {
  return {
    accounts: [],
    instruments: [],
    aliases: [],
    transactions: [],
    positions: [],
    prices: [],
    fxRates: [],
  unresolved: [],
    settings: new Map(),
  }
}

/** Accounts exist, but not one of them supplies transaction history. 0% coverage. */
export function allSnapshotRows(): PortfolioRows {
  return portfolioRows({
    accounts: ACCOUNTS.filter((account) => account.capability === 'snapshot'),
    transactions: [],
  })
}

/**
 * Ledger accounts, plus one statement-only holding worth a rounding error.
 *
 * Coverage lands inside [99.95%, 100%) — the band where `historyCoveragePct`'s clamp to `99.99`
 * is doing exactly the job its comment describes, and where a half-up round at one decimal undoes
 * it and prints "100.0%" over a portfolio that is not fully covered. Nothing else in this corpus
 * lands in that band, which is how three display sites came to round there unchallenged.
 */
export function nearlyFullCoverageRows(): PortfolioRows {
  return portfolioRows({
    accounts: ACCOUNTS.filter((account) => account.id !== 'a-etrade'),
    // 0.0035 g of gold: about ₹39 against ₹7.9 lakh of ledger-backed value.
    positions: POSITIONS.filter((row) => row.accountId === 'a-gold').map((row) => ({
      ...row,
      quantity: '0.0035',
    })),
    unresolved: [],
  })
}

/** Every account supplies full history. 100% coverage — which is still displayed. */
export function allLedgerRows(): PortfolioRows {
  return portfolioRows({
    accounts: ACCOUNTS.filter((account) => account.capability === 'ledger'),
    positions: [],
    fxRates: [],
  unresolved: [],
  })
}
