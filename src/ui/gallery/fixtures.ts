/**
 * The gallery and component fixtures.
 *
 * `mockupPortfolio` reproduces the approved mockup's numbers exactly, so what the gallery renders
 * can be compared against `docs/design/mockups/final-consolidated.html` figure by figure. The
 * hostile fixtures beside it — nothing measured, everything measured, everything stale — are the
 * cases a "sensible default" would break first.
 *
 * Every amount is written as paise by appending the two minor digits to the rupee figure, so no
 * fixture value is ever the product of arithmetic on a JavaScript number.
 */

import type { Coverage, Measured } from '@domain/measured'
import { fullCoverage, measured, notMeasured, partialCoverage } from '@domain/measured'
import type { Dec, Minor } from '@domain/numeric'
import { ZERO_MINOR, dec, minor } from '@domain/numeric'
import type { Figure } from '../figure'
import { moneyFigure, pctFigure, qtyFigure } from '../figure'
import type { CalibrationSegment } from '../charts/CalibrationBar'
import type { ConcentrationRow } from '../charts/ConcentrationChart'
import type { StackMonth } from '../charts/NetWorthStackChart'
import type { SourceStampProps } from '../provenance/SourceStamp'

/** Rupees to paise, in exact integer maths. `R('4832150')` is ₹48,32,150. */
export function R(rupees: string): Minor {
  return minor(BigInt(rupees) * 100n)
}

export const NET_WORTH = R('4832150')
export const LEDGER_BACKED = R('3473722')
export const SNAPSHOT_ONLY = R('1358428')

export const PORTFOLIO_COVERAGE: Coverage = partialCoverage(LEDGER_BACKED, NET_WORTH, [
  'etrade-morgan-stanley',
  'augmont-digital-gold',
])

export const FULL: Coverage = fullCoverage(NET_WORTH)

export const CALIBRATION_SEGMENTS: readonly CalibrationSegment[] = [
  { assetClass: 'mutual_fund', value: R('1642380'), share: dec('33.99'), basis: 'ledger' },
  { assetClass: 'indian_equity', value: R('1284600'), share: dec('26.58'), basis: 'ledger' },
  { assetClass: 'crypto', value: R('546742'), share: dec('11.31'), basis: 'ledger' },
  { assetClass: 'us_equity', value: R('1118428'), share: dec('23.15'), basis: 'snapshot' },
  { assetClass: 'gold', value: R('240000'), share: dec('4.97'), basis: 'snapshot' },
]

export const ALL_SNAPSHOT_SEGMENTS: readonly CalibrationSegment[] = CALIBRATION_SEGMENTS.map(
  (segment) => ({ ...segment, basis: 'snapshot' as const }),
)

export const ALL_LEDGER_SEGMENTS: readonly CalibrationSegment[] = CALIBRATION_SEGMENTS.map(
  (segment) => ({ ...segment, basis: 'ledger' as const }),
)

// ---------------------------------------------------------------------------
// Source stamps
// ---------------------------------------------------------------------------

export const CAS_STAMP: SourceStampProps = {
  code: 'CAS',
  reference: 'p.4-9',
  variant: 'ledger',
  description:
    'Source: CAMS/KFintech consolidated statement, pages 4–9. Full transaction history since April 2023.',
  document: {
    id: 'doc-11',
    name: 'CAS_JUL2026.pdf',
    hashShort: 'sha256:9f2a…c108',
    importedAt: '12 Aug 2026 10:44',
    pageRef: 'p.4-9',
    runId: '47',
  },
}

export const ETR_STAMP: SourceStampProps = {
  code: 'ETR',
  reference: 'csv p.2',
  variant: 'snapshot',
  description:
    'Source: E*TRADE positions CSV, page 2. Snapshot only — no transaction history, so cost basis and P&L are not measured.',
  document: {
    id: 'doc-14',
    name: 'etrade-positions-2026-08-09.csv',
    hashShort: 'sha256:41bd…7e30',
    importedAt: '09 Aug 2026 21:03',
  },
}

export const GRW_STALE_STAMP: SourceStampProps = {
  code: 'GRW',
  reference: 'csv 15 d',
  variant: 'snapshot',
  alert: true,
  description:
    'Source: Augmont holdings CSV via Groww. Snapshot only, and the price behind this figure is 15 days old.',
}

export const DRV_STAMP: SourceStampProps = {
  code: 'DRV',
  reference: '6 accts',
  variant: 'derived',
  description:
    'Derived from the ledger rows of all six accounts. Nothing on this panel was observed directly.',
}

// ---------------------------------------------------------------------------
// Readout figures
// ---------------------------------------------------------------------------

export const netWorthValue: Measured<Figure> = measured(moneyFigure(NET_WORTH), FULL)

export const dayChangeValue: Measured<Figure> = measured(
  moneyFigure(R('18506'), { signed: true }),
  FULL,
)

export const dayChangePctValue: Measured<Figure> = measured(
  pctFigure(dec('0.38'), { signed: true }),
  FULL,
)

export const costBasisValue: Measured<Figure> = measured(
  moneyFigure(R('2825329')),
  PORTFOLIO_COVERAGE,
)

export const unrealisedValue: Measured<Figure> = measured(
  moneyFigure(R('648393'), { signed: true }),
  PORTFOLIO_COVERAGE,
)

export const unrealisedPctValue: Measured<Figure> = measured(
  pctFigure(dec('22.95'), { signed: true }),
  PORTFOLIO_COVERAGE,
)

export const xirrValue: Measured<Figure> = measured(pctFigure(dec('18.42')), PORTFOLIO_COVERAGE)

export const realisedValue: Measured<Figure> = measured(
  moneyFigure(R('142380'), { signed: true }),
  PORTFOLIO_COVERAGE,
)

export const stcgValue: Measured<Figure> = measured(
  moneyFigure(R('38900'), { signed: true }),
  PORTFOLIO_COVERAGE,
)

export const ltcgValue: Measured<Figure> = measured(
  moneyFigure(R('103480'), { signed: true }),
  PORTFOLIO_COVERAGE,
)

export const currencyExposureValue: Measured<Figure> = measured(moneyFigure(R('3713722')), FULL)

export const concentrationValue: Measured<Figure> = measured(pctFigure(dec('68.70')), FULL)

export const largestPositionValue: Measured<Figure> = measured(pctFigure(dec('23.15')), FULL)

/** The `all-snapshot` case: nothing history-dependent can be computed at all. */
export const notMeasuredCost: Measured<Figure> = notMeasured('no_transaction_history', NET_WORTH)

export const notMeasuredXirr: Measured<Figure> = notMeasured('no_transaction_history', NET_WORTH)

export const notPriced: Measured<Figure> = notMeasured('no_price', R('240000'))

export const notCounted: Measured<Figure> = notMeasured('unresolved_instrument', R('118428'))

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

interface MonthSpec {
  readonly label: string
  readonly year: string
  /** Indian equity, mutual funds, crypto, US equity, gold — in rupees. */
  readonly values: readonly [string, string, string, string, string]
}

const MONTHS: readonly MonthSpec[] = [
  { label: 'SEP', year: '25', values: ['791000', '991000', '267000', '755000', '166000'] },
  { label: 'OCT', year: '25', values: ['827000', '1035000', '291000', '791000', '174000'] },
  { label: 'NOV', year: '25', values: ['852000', '1073000', '315000', '810000', '182000'] },
  { label: 'DEC', year: '25', values: ['874000', '1117000', '341000', '838000', '188000'] },
  { label: 'JAN', year: '26', values: ['910000', '1150000', '377000', '867000', '196000'] },
  { label: 'FEB', year: '26', values: ['889000', '1127000', '345000', '851000', '191000'] },
  { label: 'MAR', year: '26', values: ['951000', '1197000', '390000', '895000', '203000'] },
  { label: 'APR', year: '26', values: ['997000', '1261000', '417000', '937000', '213000'] },
  { label: 'MAY', year: '26', values: ['1045000', '1327000', '441000', '973000', '221000'] },
  { label: 'JUN', year: '26', values: ['1101000', '1401000', '457000', '1011000', '228000'] },
  { label: 'JUL', year: '26', values: ['1168000', '1497000', '477000', '1043000', '236000'] },
  { label: 'AUG', year: '26', values: ['1284600', '1642380', '546742', '1118428', '240000'] },
]

function monthFrom(spec: MonthSpec, key: string): StackMonth {
  const [indian, mutual, crypto, us, gold] = spec.values
  return {
    key,
    label: spec.label,
    year: spec.year,
    segments: [
      { assetClass: 'indian_equity', value: R(indian), basis: 'ledger' },
      { assetClass: 'mutual_fund', value: R(mutual), basis: 'ledger' },
      { assetClass: 'crypto', value: R(crypto), basis: 'ledger' },
      { assetClass: 'us_equity', value: R(us), basis: 'snapshot' },
      { assetClass: 'gold', value: R(gold), basis: 'snapshot' },
    ],
  }
}

export const TWELVE_MONTHS: readonly StackMonth[] = MONTHS.map((spec, index) =>
  monthFrom(spec, `2025-${String(index)}`),
)

/**
 * H10's fixture: the first five months predate every stored position, so they are gaps. Nothing is
 * carried backwards, and the annotation names the month history actually begins.
 */
export const MONTHS_WITH_GAPS: readonly StackMonth[] = TWELVE_MONTHS.map((month, index) =>
  index < 5 ? { ...month, segments: null } : month,
)

export const CONCENTRATION_TOP5: readonly ConcentrationRow[] = [
  {
    key: 'cat',
    label: 'Caterpillar Inc (CAT)',
    assetClass: 'us_equity',
    share: dec('23.15'),
    basis: 'snapshot',
  },
  {
    key: 'ppfc',
    label: 'Parag Parikh Flexi Cap',
    assetClass: 'mutual_fund',
    share: dec('16.23'),
    basis: 'ledger',
  },
  {
    key: 'uti',
    label: 'UTI Nifty 50 Index',
    assetClass: 'mutual_fund',
    share: dec('10.57'),
    basis: 'ledger',
  },
  {
    key: 'ril',
    label: 'Reliance Industries',
    assetClass: 'indian_equity',
    share: dec('9.93'),
    basis: 'ledger',
  },
  {
    key: 'hdfc',
    label: 'HDFC Bank',
    assetClass: 'indian_equity',
    share: dec('8.82'),
    basis: 'ledger',
  },
  {
    key: 'other',
    label: 'Other (7 positions)',
    assetClass: null,
    share: dec('31.30'),
    basis: 'ledger',
  },
]

// ---------------------------------------------------------------------------
// Holdings table
// ---------------------------------------------------------------------------

export interface HoldingRow {
  readonly key: string
  readonly name: string
  readonly detail: string
  readonly accounts: string
  readonly quantity: Dec
  readonly quantityUnit?: string
  readonly avgCost: Measured<Figure>
  readonly lastPrice: Measured<Figure>
  readonly priceNote?: string
  readonly staleDays?: number
  readonly value: Measured<Figure>
  readonly unrealised: Measured<Figure>
  readonly unrealisedPct: Measured<Figure>
  readonly weight: Dec
  readonly dayPct: Measured<Figure>
  readonly stamp: SourceStampProps
}

const LEDGER_POSITION = (valueMinor: Minor): Coverage => fullCoverage(valueMinor)

export const HOLDING_ROWS: readonly HoldingRow[] = [
  {
    key: 'ppfc',
    name: 'Parag Parikh Flexi Cap',
    detail: 'Direct growth · INF879O01019',
    accounts: 'Zerodha Coin, Groww',
    quantity: dec('11240.556'),
    // NAVs carry four decimals, which is finer than a currency's minor unit — so a price is a
    // `Dec` and is rendered as one, exactly as it was stored.
    avgCost: measured(qtyFigure(dec('55.8400')), LEDGER_POSITION(R('784220'))),
    lastPrice: measured(qtyFigure(dec('69.7670')), LEDGER_POSITION(R('784220'))),
    value: measured(moneyFigure(R('784220'), { symbol: false }), LEDGER_POSITION(R('784220'))),
    unrealised: measured(
      moneyFigure(R('156547'), { signed: true, symbol: false }),
      LEDGER_POSITION(R('784220')),
    ),
    unrealisedPct: measured(pctFigure(dec('24.94'), { signed: true }), LEDGER_POSITION(R('784220'))),
    weight: dec('16.23'),
    dayPct: measured(pctFigure(dec('0.41'), { signed: true }), LEDGER_POSITION(R('784220'))),
    stamp: { ...CAS_STAMP, reference: 'p.4' },
  },
  {
    key: 'cat',
    name: 'Caterpillar Inc',
    detail: 'NYSE:CAT · US1491231015 · RSU',
    accounts: 'E*TRADE — Morgan Stanley',
    quantity: dec('34'),
    avgCost: notMeasured('no_transaction_history', R('1118428')),
    lastPrice: measured(
      { kind: 'money', minor: minor('37620'), currency: 'USD', format: { decimals: 2 } },
      LEDGER_POSITION(R('1118428')),
    ),
    priceNote: '₹32,895.41',
    value: measured(moneyFigure(R('1118428'), { symbol: false }), LEDGER_POSITION(R('1118428'))),
    unrealised: notMeasured('no_transaction_history', R('1118428')),
    unrealisedPct: notMeasured('no_transaction_history', R('1118428')),
    weight: dec('23.15'),
    dayPct: measured(pctFigure(dec('-0.30'), { signed: true }), LEDGER_POSITION(R('1118428'))),
    stamp: ETR_STAMP,
  },
  {
    key: 'augmont',
    name: 'Augmont Digital Gold',
    detail: '999 fine · vaulted',
    accounts: 'Augmont',
    quantity: dec('21.4790'),
    quantityUnit: 'g',
    avgCost: notMeasured('no_transaction_history', R('240000')),
    lastPrice: measured(qtyFigure(dec('11173.65')), LEDGER_POSITION(R('240000'))),
    priceNote: 'per g · 15 d old',
    staleDays: 15,
    value: measured(moneyFigure(R('240000'), { symbol: false }), LEDGER_POSITION(R('240000'))),
    unrealised: notMeasured('no_transaction_history', R('240000')),
    unrealisedPct: notMeasured('no_transaction_history', R('240000')),
    weight: dec('4.97'),
    dayPct: measured(pctFigure(dec('0.31'), { signed: true }), LEDGER_POSITION(R('240000'))),
    stamp: GRW_STALE_STAMP,
  },
]

export const TOTAL_ROW: HoldingRow = {
  key: 'total',
  name: 'Total · 12 positions',
  detail: '6 accounts',
  accounts: '6 accounts',
  quantity: dec('0'),
  avgCost: measured(moneyFigure(R('2825329'), { symbol: false }), PORTFOLIO_COVERAGE),
  lastPrice: notMeasured('no_price', ZERO_MINOR),
  value: measured(moneyFigure(NET_WORTH, { symbol: false }), FULL),
  unrealised: measured(
    moneyFigure(R('648393'), { signed: true, symbol: false }),
    PORTFOLIO_COVERAGE,
  ),
  unrealisedPct: measured(pctFigure(dec('22.95'), { signed: true }), PORTFOLIO_COVERAGE),
  weight: dec('100'),
  dayPct: measured(pctFigure(dec('0.38'), { signed: true }), FULL),
  stamp: { ...DRV_STAMP, reference: '12 pos' },
}
