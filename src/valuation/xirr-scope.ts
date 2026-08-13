/**
 * XIRR at a scope: portfolio, account, or (account, instrument).
 *
 * Each scope requires *every* constituent pair to be measured. A scope containing a pair we cannot
 * measure returns `SCOPE_NOT_MEASURED` listing the offenders rather than an XIRR over the
 * measurable subset — a partial XIRR silently answers a different question from the one the label
 * implies, and the label is what the user reads.
 */

import { type Minor, ZERO_MINOR, addMinor } from '@domain/numeric'
import { instantToDate } from './calendar'
import type { FoldInput } from './fold'
import type { FxService } from './fx'
import type { PriceService } from './price/service'
import type { PairValue } from './portfolio'
import type { IsoInstant, PairRef, TxnRow } from './types'
import { type XirrOutcome, type XirrResult, buildCashflows, xirr } from './xirr'

export type XirrScope =
  | { readonly kind: 'portfolio' }
  | { readonly kind: 'account'; readonly accountId: string }
  | { readonly kind: 'pair'; readonly accountId: string; readonly instrumentId: string }

export interface XirrScopeInput {
  readonly scope: XirrScope
  readonly pairs: readonly PairValue[]
  readonly accounts: readonly FoldInput[]
  readonly fx: FxService
  readonly prices: PriceService
  readonly asOf: IsoInstant
}

function inScope(pair: PairRef, scope: XirrScope): boolean {
  switch (scope.kind) {
    case 'portfolio':
      return true
    case 'account':
      return pair.accountId === scope.accountId
    case 'pair':
      return pair.accountId === scope.accountId && pair.instrumentId === scope.instrumentId
  }
}

export function xirrForScope(input: XirrScopeInput): XirrResult<XirrOutcome> {
  const pairs = input.pairs.filter((pair) => inScope(pair, input.scope))
  const unmeasured = pairs.filter((pair) => pair.measurement !== 'measured')
  if (unmeasured.length > 0) {
    return {
      ok: false,
      error: {
        code: 'SCOPE_NOT_MEASURED',
        pairs: unmeasured.map((pair) => ({
          accountId: pair.accountId,
          instrumentId: pair.instrumentId,
        })),
      },
    }
  }

  const unpriced = pairs.filter((pair) => !pair.marketValue.measured)
  if (unpriced.length > 0) {
    return {
      ok: false,
      error: {
        code: 'MISSING_PRICE',
        instrumentIds: [...new Set(unpriced.map((pair) => pair.instrumentId))],
      },
    }
  }

  let terminalMinor: Minor = ZERO_MINOR
  for (const pair of pairs) {
    if (pair.marketValue.measured) terminalMinor = addMinor(terminalMinor, pair.marketValue.value)
  }

  const wanted = new Set(pairs.map((pair) => `${pair.accountId}|${pair.instrumentId}`))
  const txns: TxnRow[] = []
  for (const account of input.accounts) {
    for (const txn of account.txns) {
      if (wanted.has(`${txn.accountId}|${txn.instrumentId}`)) txns.push(txn)
    }
  }

  const valuationDate = instantToDate(input.asOf)
  const flows = buildCashflows({
    txns,
    terminal: { date: valuationDate, amountMinor: terminalMinor },
    fxOn: (currency, date) => {
      const rate = input.fx.on(currency, 'INR', date)
      return rate.ok ? rate.value.rate : null
    },
    priceOn: (instrumentId, date) => {
      const price = input.prices.priceAt(instrumentId, date)
      if (price.ok) return price.value.close
      // The one caller that genuinely wants last-known-price semantics, said out loud. A cashflow
      // is dated by the day it happened, and most of those days have no published close —
      // weekends, exchange holidays, and any day the instrument simply did not trade. Carrying the
      // previous close forward is the standard convention for discounting a flow; refusing would
      // make XIRR unmeasurable for nearly every portfolio, which is a worse answer than a close
      // from the last session. Unlike a valuation figure this never reaches the screen as "today's
      // price" — it only scales one historical flow.
      if (price.error.code === 'PRICE_NOT_ON_DATE') return price.error.lastKnown.close
      return null
    },
  })
  if (!flows.ok) return flows
  return xirr(flows.value)
}
