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
  FxRateRow,
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

/**
 * Ledger accounts, plus one snapshot account whose every holding is unpriced.
 *
 * The reviewers' reproduction, and the state the shipped corpus could not reach: drop the gold
 * account and the only snapshot holding left is the dollar one, which has no stored rate. It is in
 * neither `measuredMinor` nor `valuedMinor` — an unpriced position has no rupee value to put in
 * either — so `unmeasuredMinor` comes out of the subtraction as exactly zero and the calibration
 * split is a clean 100/0 over the part that could be priced.
 *
 * Note which direction the failure runs. This is *worse* data than `portfolioRows()`, and without
 * the unpriced count on the bar it reads better: 100.0%, no hatch, no bracket, and an Accounts foot
 * saying nothing is withheld — under a row badged "Holdings only · 1 not priced".
 */
export function unpricedSnapshotRows(): PortfolioRows {
  return portfolioRows({
    accounts: ACCOUNTS.filter((account) => account.id !== 'a-gold'),
    positions: POSITIONS.filter((row) => row.accountId === 'a-etrade'),
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

// ---------------------------------------------------------------------------
// A dollar account with a transaction history — lots, trades, and stored rates.
//
// The only USD account in this corpus was snapshot-only with no transactions at all, so nothing
// here ever produced a native-currency *lot* or a native-currency *amount*. Those two rows are
// exactly where `moneyFigure`'s INR default was being taken silently, and their absence is why the
// defect survived three reviews: a dollar vest rendered as ₹, exported as `amount_inr_minor`, and
// no fixture in the corpus could tell.
//
// The account this models is the one the product exists to consolidate: an RSU broker reporting in
// dollars, with per-row `fx_rate` absent because the statement does not carry one.
// ---------------------------------------------------------------------------

interface UsdTrade {
  readonly id: string
  readonly date: string
  readonly units: bigint
  readonly price: string
}

const CAT_TRADES: readonly UsdTrade[] = [
  { id: 'v1', date: '2024-11-14', units: 12n, price: '310.0000' },
  { id: 'v2', date: '2025-06-03', units: 10n, price: '340.0000' },
  { id: 'v3', date: '2026-02-19', units: 12n, price: '360.0000' },
]

/** Cents: units × price, in exact integer maths on the stored digits. */
function cents(price: string, units: bigint): string {
  return ((BigInt(price.replace('.', '')) * units) / 100n).toString()
}

/**
 * Dollar-denominated buys. `amountMinor` is **cents**, and `currency` says so — the two travel
 * together or the integer is meaningless.
 */
export function usdTxns(): readonly TxnRow[] {
  return CAT_TRADES.map((trade, index) => ({
    id: `t-cat-${trade.id}`,
    accountId: 'a-etrade',
    instrumentId: 'i-cat',
    type: 'buy',
    occurredAt: `${trade.date}T09:30:00-05:00`,
    occurredTz: 'America/New_York',
    quantity: `${trade.units.toString()}.0000`,
    price: trade.price,
    amountMinor: cents(trade.price, trade.units),
    ...NO_FEES,
    currency: 'USD',
    // No per-row rate: the stored daily table is the only source, which is what a real statement
    // leaves behind.
    fxRate: null,
    sourceDocumentId: 'd-etr-1',
    naturalKey: `etrade:cat:${trade.id}`,
    occurrence: index,
    authority: 'primary',
    createdAt: '2026-08-12T10:44:00+05:30',
  }))
}

export const USD_INR: readonly FxRateRow[] = [
  { base: 'USD', quote: 'INR', asOf: '2024-11-14', rate: '84.2500', source: 'manual' },
  { base: 'USD', quote: 'INR', asOf: '2025-06-03', rate: '85.1000', source: 'manual' },
  { base: 'USD', quote: 'INR', asOf: '2026-02-19', rate: '86.4000', source: 'manual' },
  { base: 'USD', quote: 'INR', asOf: '2026-08-11', rate: '87.5000', source: 'manual' },
]

/**
 * The E*TRADE account promoted to a ledger, with the dollar rates its transactions need.
 *
 * Its lots carry `currency: 'USD'` and `costMinor` in cents; its transactions carry amounts in
 * cents. Every rupee figure on the same screen — net worth, the FIFO cost tile, the calibration
 * bar — is converted at the stored rate, so this fixture is the one place the corpus holds both
 * kinds of number at once and can be made to state which is which.
 */
export function usdLedgerRows(over: Partial<PortfolioRows> = {}): PortfolioRows {
  return portfolioRows({
    accounts: ACCOUNTS.map((account) =>
      account.id === 'a-etrade' ? { ...account, capability: 'ledger' as const } : account,
    ),
    transactions: [...TRANSACTIONS, ...usdTxns()],
    positions: POSITIONS.filter((row) => row.accountId !== 'a-etrade'),
    fxRates: USD_INR,
    ...over,
  })
}

/**
 * One refresh, and no price history — the state of every install younger than twelve months.
 *
 * Nothing calls `fetchHistory`, so a fresh machine stores exactly one price row per instrument and
 * it is dated today. Every month-end column before this one then folds holdings it cannot price:
 * the transactions are all there, the units are all there, and the priced value is zero.
 *
 * The shipped corpus hides this — it carries a hand-written month-end price series that no real
 * install would have — which is why eleven columns reading "no history" over a portfolio with 28
 * transactions going back to 2024-09-07 was nobody's fixture.
 */
export function freshInstallRows(over: Partial<PortfolioRows> = {}): PortfolioRows {
  return portfolioRows({
    prices: PRICES.filter((price) => price.asOf >= '2026-08-11'),
    ...over,
  })
}

// ---------------------------------------------------------------------------
// Three shapes an aggregate can be in, only one of which the corpus could reach.
//
// `unpricedSnapshotRows()` makes a whole account unpriced, so every total over it comes out at
// zero — which renders as `fullCoverage(0)` and a coverage attribute of "0.0%", the harmless-
// looking end of the defect. What follows are the shapes that are not harmless: an aggregate that
// is *partly* priced, where the sum is a real, large, wrong number; a genuine zero, which must
// keep saying zero; and the state of every install between an import and its first refresh.
// ---------------------------------------------------------------------------

/**
 * One account holding one priced instrument and one unpriced one.
 *
 * Nothing in the corpus produced this. Every unpriced fixture makes the whole aggregate unpriced,
 * so the sum is zero and looks like an empty state; here the E*TRADE account holds ten grams of
 * gold — ₹1,11,737 — beside a dollar holding with no stored rate, and summing the unpriced one as
 * zero yields a confident rupee figure that silently omits a holding, under a coverage of 100.0%:
 * the one number this product documents as meaning complete.
 *
 * Pricing is decided per instrument (a stored close plus a rate for its currency), so an account
 * is the smallest scope that can be *partly* priced. That is why this fixture moves a holding
 * between accounts rather than pricing half an instrument: the latter is not a state the engine
 * can be in.
 */
export function partlyPricedAccountRows(over: Partial<PortfolioRows> = {}): PortfolioRows {
  return portfolioRows({
    positions: [
      ...POSITIONS,
      {
        id: 'p-etrade-gold',
        accountId: 'a-etrade',
        instrumentId: 'i-gold',
        quantity: '10.0000',
        asOf: '2026-08-09T00:00:00+05:30',
        sourceDocumentId: 'd-etr-1',
      },
    ],
    unresolved: [],
    ...over,
  })
}

/**
 * A holding sold down to nothing, with the statement row retained.
 *
 * The one case where a zero on the screen is the truth: the units are known, the price is known,
 * and the product of the two is ₹0. It is here to bound the fix for the unpriced sums — an
 * aggregate that omits a holding it could not price must be withheld, and an aggregate that
 * genuinely came to zero must not be, or "not measured" becomes the new way of saying nothing.
 */
export function zeroQuantityRows(over: Partial<PortfolioRows> = {}): PortfolioRows {
  return portfolioRows({
    positions: POSITIONS.map((row) =>
      row.accountId === 'a-gold' ? { ...row, quantity: '0.0000' } : row,
    ),
    unresolved: [],
    ...over,
  })
}

/**
 * A fresh install: statements imported, no refresh yet, so not one price is stored.
 *
 * This is not an exotic state — it is every install between its first import and its first
 * refresh, and it is what the user sees while deciding whether the product works. With no price
 * row at all, every holding is unpriced, every instrument total and every account total is a sum
 * of zeros, and the defect this fixture exists for renders on *every* tile and *every* row at
 * once rather than on the one foreign holding.
 *
 * `freshInstallRows()` is the neighbouring state and a different one: there, one refresh has
 * happened, so today is priced and only the earlier months are not.
 */
export function noPricesRows(over: Partial<PortfolioRows> = {}): PortfolioRows {
  return portfolioRows({ prices: [], ...over })
}

/**
 * A sub-paisa crypto price, with a ledger behind it.
 *
 * SHIB is in the shipped seed catalogue and trades near $0.00001. Nothing in this corpus priced
 * anything below a paisa, so "two decimals for a quote" was never asked a question it could get
 * wrong — and it gets it wrong the same way every time: `0.00` beside a correct, non-zero Value.
 */
export const SUB_PAISA_INSTRUMENT: InstrumentRow = {
  id: 'i-shib',
  assetClass: 'crypto',
  taxRegime: 's115bbh_vda',
  displayName: 'Shiba Inu',
  isin: null,
  currency: 'INR',
  precision: 8,
  fmv31Jan2018: null,
}

export function subPaisaRows(over: Partial<PortfolioRows> = {}): PortfolioRows {
  return portfolioRows({
    instruments: [...INSTRUMENTS, SUB_PAISA_INSTRUMENT],
    transactions: [
      ...TRANSACTIONS,
      {
        id: 't-shib-1',
        accountId: 'a-kite',
        instrumentId: 'i-shib',
        type: 'buy',
        occurredAt: '2026-03-11T09:30:00+05:30',
        occurredTz: 'Asia/Kolkata',
        quantity: '120000000.00000000',
        price: '0.00081500',
        // 120,000,000 × ₹0.000815 = ₹97,800 → 97,80,000 paise.
        amountMinor: '9780000',
        ...NO_FEES,
        currency: 'INR',
        fxRate: null,
        sourceDocumentId: 'd-kite-1',
        naturalKey: 'kite:shib:1',
        occurrence: 0,
        authority: 'primary',
        createdAt: '2026-08-12T09:12:00+05:30',
      },
    ],
    prices: [
      ...PRICES,
      {
        instrumentId: 'i-shib',
        asOf: '2026-08-11',
        close: '0.00092400',
        currency: 'INR',
        source: 'coingecko',
        fetchedAt: '2026-08-12T10:52:00+05:30',
      },
    ],
    ...over,
  })
}

// ---------------------------------------------------------------------------
// Two snapshot accounts that hold nothing worth anything, for opposite reasons.
//
// Every account in `ACCOUNTS` has positions or transactions behind it, and `allLedgerRows()` empties
// `positions` only for accounts that are `ledger` anyway. So a *snapshot* account contributing zero
// value to net worth could only ever be reached one way in this corpus — an unpriced holding — and
// any screen deciding something from that zero was reading one cause where there are three.
// ---------------------------------------------------------------------------

/**
 * A snapshot account with an account row and no position rows at all.
 *
 * This is the state of every exchange the moment its key is committed: `upsert_exchange_account`
 * inserts with a hardcoded `capability = 'snapshot'` at credential-commit time, before any balances
 * sync has run, and `queries.rs::list_accounts` lists every non-archived account. A first sync that
 * has not started, that threw, or that found nothing all leave the account exactly here — on screen,
 * badged "Holdings only", with nothing under it.
 *
 * Nothing failed to price in this fixture, because there was nothing to price: `unpricedCount` is 0
 * and the calibration bar carries no unpriced note.
 */
export function connectedNoHoldingsRows(over: Partial<PortfolioRows> = {}): PortfolioRows {
  return portfolioRows({
    // The ledger accounts keep their transactions, so net worth is non-zero and the only account
    // contributing nothing is the snapshot one.
    accounts: ACCOUNTS.filter((account) => account.id !== 'a-etrade'),
    positions: [],
    unresolved: [],
    ...over,
  })
}

/**
 * A position row retained after the holding was fully sold: quantity `0`, priced normally.
 *
 * Nothing in `POSITIONS` is zero-quantity, so "the account holds rows, every row prices, and the
 * value is nonetheless zero" was a state the corpus could not produce — and it is the third way a
 * snapshot account contributes nothing.
 */
export const ZERO_QUANTITY_POSITION: PositionRow = {
  id: 'p-gold-sold',
  accountId: 'a-gold',
  instrumentId: 'i-gold',
  quantity: '0.0000',
  asOf: '2026-08-10T00:00:00+05:30',
  sourceDocumentId: 'd-grw-1',
}

/** Ledger accounts, plus one snapshot account whose single holding is a fully sold, priced row. */
export function zeroQuantitySnapshotRows(over: Partial<PortfolioRows> = {}): PortfolioRows {
  return portfolioRows({
    accounts: ACCOUNTS.filter((account) => account.id !== 'a-etrade'),
    positions: [ZERO_QUANTITY_POSITION],
    unresolved: [],
    ...over,
  })
}

// ---------------------------------------------------------------------------
// The two legs of a foreign holding, failing one at a time.
//
// `USD_INR` ships all four dates together, which no real install ever holds: `refreshFx` stores
// only 'latest', `backfillFxHistory` is paced, capped by `MAX_FX_HISTORY_REQUESTS`, skipped
// entirely when the provider has no `fetchFxHistory`, and halts on RATE_LIMITED. The two bounds
// differ too — `MAX_FX_BACKFILL_DAYS = 3` against `MAX_FX_LATEST_AGE_DAYS = 7` — so the current
// rate and the acquisition-date rates fail *independently, by design*, and nothing in this corpus
// split them. Each leg breaks a different figure, and each one is a state a user is really in.
// ---------------------------------------------------------------------------

/**
 * Today's rate stored, 2024's and 2025's absent — every install between its first price refresh
 * and the completion of the FX backfill.
 *
 * The dollar holding is **valued** (it has a current rate) and its cost is **not** (its lots have
 * no acquisition-date rate), so it sits inside net worth and outside the cost metric. That is the
 * shape that separates the ledger/snapshot capability split from the cost metric's own population:
 * ₹19,13,066 of ledger-backed value against ₹7,93,871 of measured cost, on one portfolio.
 */
export function latestFxOnlyRows(over: Partial<PortfolioRows> = {}): PortfolioRows {
  return usdLedgerRows({ fxRates: USD_INR.filter((row) => row.asOf === '2026-08-11'), ...over })
}

/**
 * The acquisition dates' rates stored, today's absent — the backfill ran and the latest fetch did
 * not, or the stored 'latest' has aged past `MAX_FX_LATEST_AGE_DAYS`.
 *
 * The mirror image, and the one that breaks the P&L percentage: the dollar holding's cost is
 * measured at each lot's own rate — `costInInr` needs no current price and no current rate — while
 * its market value is not, so ₹9,75,998 of cost sits in the Invested tile with no market value to
 * compare it against. Beside it, two rupee holdings have both. Numerator and denominator therefore
 * come from different sets within one portfolio, which is exactly what a percentage may not do.
 */
export function historicFxOnlyRows(over: Partial<PortfolioRows> = {}): PortfolioRows {
  return usdLedgerRows({ fxRates: USD_INR.filter((row) => row.asOf < '2026-08-01'), ...over })
}

/**
 * A **ledger** holding that cannot be priced, with no foreign currency anywhere in it.
 *
 * `unpricedSnapshotRows` is snapshot-capability only, which is why this divergence stayed
 * invisible: a snapshot pair has no measured cost either, so it drops out of the cost sum and the
 * P&L sum together and the two populations coincide. The shape that matters is a pair with a
 * complete lot chain — measured cost — and no market value, and one line produces it: drop the
 * price rows for Reliance, whose three trades in a ledger account build exactly that pair.
 *
 * This is the state of any install holding an instrument no provider covers, and of every install
 * before its first price refresh. It needs no exchange rate to reproduce.
 */
export function unpricedLedgerRows(over: Partial<PortfolioRows> = {}): PortfolioRows {
  return portfolioRows({
    prices: PRICES.filter((price) => price.instrumentId !== 'i-rel'),
    ...over,
  })
}
