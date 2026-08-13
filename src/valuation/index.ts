/**
 * Subsystem D — the valuation engine and price service.
 *
 * The engine is pure: given a database snapshot and a valuation instant it computes a result, and
 * it never fetches. Fetching lives in the price service, which writes into `price` and `fx_rate`
 * and runs only on an explicit refresh. That split is what makes the application work offline and
 * what makes every number here testable without a network.
 */

export * from './types'
export * from './arithmetic'
export * from './calendar'
export * from './fold'
export * from './positions'
export * from './grandfather'
export * from './tax-rules'
export * from './tax'
export * from './xirr'
export * from './xirr-scope'
export * from './coverage'
export * from './fx'
export * from './portfolio'
export * from './price/types'
export * from './price/staleness'
export * from './price/service'
export * from './price/amfi'
export * from './price/twelvedata'
export * from './price/yahoo'
export * from './price/coingecko'
