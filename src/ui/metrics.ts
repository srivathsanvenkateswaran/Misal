/**
 * The vocabulary the honesty invariants are written in (spec §5).
 *
 * Components emit these as `data-*` attributes. They exist so H1–H12 can be asserted by a DOM
 * walk rather than by reviewer memory, and so devtools shows the provenance of any figure on the
 * screen.
 */

import type { AssetClass } from '@valuation/types'

export type MetricId =
  | 'net-worth'
  | 'day-change'
  | 'value'
  | 'weight'
  | 'quantity'
  | 'price'
  | 'currency-exposure'
  | 'concentration'
  | 'coverage'
  // history-dependent, below
  | 'cost-basis'
  | 'avg-cost'
  | 'unrealised'
  | 'unrealised-pct'
  | 'realised'
  | 'stcg'
  | 'ltcg'
  | 'xirr'
  | 'holding-period'
  | 'open-lots'

/**
 * H1 — the ledger gate. These may render a numeral only when every account in scope has
 * `capability = 'ledger'`; otherwise the metric is `Measured<T>` in its `measured: false` branch
 * and renders its reason. The type system enforces the absence of a value; this set is what the
 * DOM assertions use to know which metrics must carry coverage (H2).
 */
export const HISTORY_DEPENDENT: ReadonlySet<MetricId> = new Set<MetricId>([
  'cost-basis',
  'avg-cost',
  'unrealised',
  'unrealised-pct',
  'realised',
  'stcg',
  'ltcg',
  'xirr',
  'holding-period',
  'open-lots',
])

export function isHistoryDependent(metric: MetricId): boolean {
  return HISTORY_DEPENDENT.has(metric)
}

export type Basis = 'ledger' | 'snapshot' | 'mixed' | 'derived'

export type Scope = 'portfolio' | 'class' | 'account' | 'position'

/** The categorical slots. Bound to asset class permanently; hue never encodes size or freshness. */
export type SeriesToken = 's1' | 's2' | 's3' | 's4' | 's5' | 'other'

export const SERIES_BY_ASSET_CLASS: Record<AssetClass, SeriesToken> = {
  indian_equity: 's1',
  mutual_fund: 's2',
  crypto: 's3',
  us_equity: 's4',
  gold: 's5',
  // §6.3, acknowledged gap: bond and cash have no validated hue, so they share --other and rely
  // on the direct labelling every context already requires.
  bond: 'other',
  cash: 'other',
}

export const ASSET_CLASS_LABEL: Record<AssetClass, string> = {
  indian_equity: 'Indian equity',
  mutual_fund: 'Mutual funds',
  crypto: 'Crypto',
  us_equity: 'US equity',
  gold: 'Gold',
  bond: 'Bonds',
  cash: 'Cash',
}
