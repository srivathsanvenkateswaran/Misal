/**
 * The refresh plan and the refresh report.
 *
 * Two claims are asserted here over and over, because they are the two the screen exists to make:
 * what a refresh *would* do before the user commits to it, and what it *did* to each instrument
 * afterwards. A plan that quietly omits the instruments no provider covers, or a report that calls
 * a refused write a refresh, would be wrong in exactly the way this product cares about.
 *
 * No test opens a socket. `buildPlan` constructs the real providers — their `supports()` predicate
 * is pure — with a fetcher that rejects if it is ever called, and `tests/setup.ts` fails anything
 * that reaches for a socket regardless.
 */

import { describe, expect, it } from 'vitest'
import type { PortfolioRows, PriceRow } from '../../data/client'
import type { RefreshOutcome } from '../../data/refresh'
import { buildPlan, buildReport, countByStatus } from './plan'
import type { RefreshRun } from './plan'

const NOW = '2026-08-13T09:00:00.000+05:30'

function price(over: Partial<PriceRow> & Pick<PriceRow, 'instrumentId' | 'asOf' | 'close'>): PriceRow {
  return {
    currency: 'INR',
    source: 'yahoo',
    fetchedAt: NOW,
    ...over,
  }
}

/**
 * One of each population the screen has to speak about.
 *
 * Yahoo covers the two equities by their tickers, CoinGecko the coin by its resolved id, AMFI the
 * fund by its ISIN. The gold bond and the SGB have no alias any provider can name, which is the
 * whole point of their presence: they are the manual-price population.
 */
function rows(over: Partial<PortfolioRows> = {}): PortfolioRows {
  return {
    accounts: [
      {
        id: 'a-kite',
        providerId: 'zerodha-kite',
        label: 'Kite',
        externalRef: null,
        identityKey: null,
        capability: 'ledger',
        baseCurrency: 'INR',
        createdAt: NOW,
        providerShortCode: 'KIT',
      },
    ],
    instruments: [
      {
        id: 'i-infy',
        assetClass: 'indian_equity',
        taxRegime: 's112a_listed_equity',
        displayName: 'Infosys',
        isin: 'INE009A01021',
        currency: 'INR',
        precision: 4,
        fmv31Jan2018: null,
      },
      {
        id: 'i-aapl',
        assetClass: 'us_equity',
        taxRegime: 'foreign_equity',
        displayName: 'Apple',
        isin: null,
        currency: 'USD',
        precision: 4,
        fmv31Jan2018: null,
      },
      {
        id: 'i-btc',
        assetClass: 'crypto',
        taxRegime: 's115bbh_vda',
        displayName: 'Bitcoin',
        isin: null,
        currency: 'INR',
        precision: 8,
        fmv31Jan2018: null,
      },
      {
        id: 'i-fund',
        assetClass: 'mutual_fund',
        taxRegime: 's112a_equity_fund',
        displayName: 'Parag Parikh Flexi Cap',
        isin: 'INF879O01027',
        currency: 'INR',
        precision: 4,
        fmv31Jan2018: null,
      },
      {
        id: 'i-tcs',
        assetClass: 'indian_equity',
        taxRegime: 's112a_listed_equity',
        displayName: 'TCS',
        isin: 'INE467B01029',
        currency: 'INR',
        precision: 4,
        fmv31Jan2018: null,
      },
      {
        // No alias, no ISIN a fund provider would take: nothing can price this automatically.
        id: 'i-gold',
        assetClass: 'gold',
        taxRegime: 'other_asset',
        displayName: 'Physical gold',
        isin: null,
        currency: 'INR',
        precision: 4,
        fmv31Jan2018: null,
      },
      {
        id: 'i-sgb',
        assetClass: 'bond',
        taxRegime: 'other_asset',
        displayName: 'SGB 2031',
        isin: null,
        currency: 'INR',
        precision: 4,
        fmv31Jan2018: null,
      },
    ],
    aliases: [
      { instrumentId: 'i-infy', scheme: 'nse', value: 'INFY', providerId: null },
      { instrumentId: 'i-aapl', scheme: 'ticker', value: 'AAPL', providerId: null },
      { instrumentId: 'i-btc', scheme: 'coingecko', value: 'bitcoin', providerId: null },
      { instrumentId: 'i-tcs', scheme: 'nse', value: 'TCS', providerId: null },
    ],
    transactions: [],
    positions: [],
    prices: [
      // Very stale: nine trading days behind, well past the seven-day threshold for an equity.
      price({ instrumentId: 'i-infy', asOf: '2026-08-01', close: '1100.00' }),
      // Stale: five trading days behind.
      price({ instrumentId: 'i-aapl', asOf: '2026-08-06', close: '302.25', currency: 'USD' }),
      // Fresh: crypto is judged on calendar time and this is today's.
      price({ instrumentId: 'i-btc', asOf: '2026-08-13', close: '6061005.01', source: 'coingecko' }),
      // A manual price on an instrument a provider does cover, and one on an instrument none does.
      price({ instrumentId: 'i-tcs', asOf: '2026-08-01', close: '3200.00', source: 'manual' }),
      price({ instrumentId: 'i-gold', asOf: '2026-08-10', close: '7412.00', source: 'manual' }),
    ],
    fxRates: [],
    unresolved: [],
    settings: new Map([
      ['base_currency', 'INR'],
      ['price_cache_ttl_minutes', '360'],
    ]),
    ...over,
  }
}

const names = (list: readonly { displayName: string }[]): string[] =>
  list.map((row) => row.displayName).sort()

describe('the plan, before anything is fetched', () => {
  it('names the instruments no provider covers, whatever their freshness', () => {
    const plan = buildPlan(rows(), NOW)
    expect(names(plan.uncovered)).toEqual(['Physical gold', 'SGB 2031'])
    // The distinction the screen leans on: one already has a value by hand, the other has none.
    expect(plan.uncovered.find((row) => row.instrumentId === 'i-gold')?.manuallyPriced).toBe(true)
    expect(plan.uncovered.find((row) => row.instrumentId === 'i-sgb')?.manuallyPriced).toBe(false)
  })

  it('separates never priced from past its cadence, and leaves fresh alone', () => {
    const plan = buildPlan(rows(), NOW)
    expect(names(plan.neverPriced)).toEqual(['Parag Parikh Flexi Cap'])
    expect(names(plan.stalePriced)).toEqual(['Apple', 'Infosys', 'TCS'])
    expect(names(plan.fresh)).toEqual(['Bitcoin'])
  })

  it('judges freshness per asset class rather than by a single duration', () => {
    const plan = buildPlan(rows(), NOW)
    const byId = new Map(plan.rows.map((row) => [row.instrumentId, row]))
    // Twelve calendar days for both, and the same file calls one very stale and the other fresh —
    // because a crypto price and an equity close are published on different clocks.
    expect(byId.get('i-infy')?.freshness).toBe('very_stale')
    expect(byId.get('i-infy')?.ageDays).toBe(12)
    expect(byId.get('i-aapl')?.freshness).toBe('stale')
    expect(byId.get('i-btc')?.freshness).toBe('fresh')
  })

  it('routes each target to the provider that actually covers it', () => {
    const plan = buildPlan(rows(), NOW)
    const byId = new Map(plan.rows.map((row) => [row.instrumentId, row]))
    expect(byId.get('i-infy')?.providerId).toBe('yahoo')
    expect(byId.get('i-btc')?.providerId).toBe('coingecko')
    expect(byId.get('i-fund')?.providerId).toBe('amfi')
    expect(byId.get('i-gold')?.providerId).toBeNull()
    // Twelve Data is absent: this screen cannot read a key out of the keychain, so it never
    // promises coverage a keyless refresh will not deliver.
    expect(plan.load.map((entry) => entry.providerId).sort()).toEqual(['amfi', 'yahoo'])
    expect(plan.load.find((entry) => entry.providerId === 'yahoo')?.instruments).toBe(3)
  })

  it('targets exactly what the orchestrator would ask about', () => {
    const plan = buildPlan(rows(), NOW)
    // `onlyStale` scope: everything with a provider that is not fresh, and nothing else.
    expect(names(plan.targets)).toEqual(['Apple', 'Infosys', 'Parag Parikh Flexi Cap', 'TCS'])
  })

  it('reports the gate rather than deciding for itself when a refresh is due', () => {
    const eligible = buildPlan(rows(), NOW)
    expect(eligible.gate.eligible).toBe(true)
    expect(eligible.ttlMinutes).toBe('360')

    const held = buildPlan(
      rows({
        settings: new Map([
          ['base_currency', 'INR'],
          ['price_cache_ttl_minutes', '360'],
          ['last_price_refresh_at', '2026-08-13T08:00:00.000+05:30'],
        ]),
      }),
      NOW,
    )
    expect(held.gate.eligible).toBe(false)
    expect(held.gate.nextEligibleAt).toContain('2026-08-13T14:00')
    expect(held.lastRefreshAt).toBe('2026-08-13T08:00:00.000+05:30')
  })

  it('falls back to the seeded cache lifetime rather than showing nonsense', () => {
    const plan = buildPlan(
      rows({ settings: new Map([['price_cache_ttl_minutes', 'soon']]) }),
      NOW,
    )
    expect(plan.ttlMinutes).toBe('360')
  })

  it('names the foreign currencies whose holdings depend on a rate', () => {
    expect(buildPlan(rows(), NOW).foreign).toEqual(['USD'])
  })
})

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function outcome(over: Partial<RefreshOutcome> = {}): RefreshOutcome {
  return {
    status: 'ran',
    startedAt: NOW,
    finishedAt: NOW,
    prices: {
      startedAt: NOW,
      finishedAt: NOW,
      requested: 4,
      updated: 1,
      unchanged: 1,
      failed: 1,
      failures: [{ instrumentId: 'i-fund', error: { code: 'NOT_FOUND' } }],
      creditsConsumed: 0,
      rateLimited: false,
    },
    pricesWritten: 2,
    fx: [],
    fxWritten: 0,
    rateLimited: false,
    notes: [],
    nextEligibleAt: null,
    ...over,
  }
}

function run(over: Partial<RefreshRun> = {}): RefreshRun {
  return {
    outcome: outcome(),
    saved: [
      { instrumentId: 'i-infy', asOf: '2026-08-13', close: '1163.6', currency: 'INR', source: 'yahoo', fetchedAt: NOW },
      // Same day and the same figure the store already had, written in a different but equal form.
      { instrumentId: 'i-aapl', asOf: '2026-08-06', close: '302.250', currency: 'USD', source: 'yahoo', fetchedAt: NOW },
    ],
    heldByManual: [],
    unknown: [],
    cancelled: false,
    ...over,
  }
}

describe('the report, after a run', () => {
  const report = (over: Partial<RefreshRun> = {}) => {
    const before = rows()
    return buildReport(buildPlan(before, NOW), run(over), before.prices)
  }
  const find = <T extends { instrumentId: string }>(list: readonly T[], id: string): T | undefined =>
    list.find((row) => row.instrumentId === id)

  it('calls a new price refreshed and an identical one unchanged', () => {
    const rowsOut = report()
    expect(find(rowsOut, 'i-infy')?.status).toBe('refreshed')
    expect(find(rowsOut, 'i-infy')?.close).toBe('1163.6')
    // '302.250' and '302.25' are the same price. Compared as decimals, never as text and never as
    // floats, so a provider changing its trailing zeros does not read as a price movement.
    expect(find(rowsOut, 'i-aapl')?.status).toBe('unchanged')
  })

  it('reports a failure with the provider’s reason rather than a count', () => {
    const failed = find(report(), 'i-fund')
    expect(failed?.status).toBe('failed')
    expect(failed?.code).toBe('NOT_FOUND')
    expect(failed?.detail).toContain('does not carry these symbols')
    // Nothing was invented for it.
    expect(failed?.close).toBeNull()
  })

  it('surfaces a write the core refused because a manual price holds that day', () => {
    const held = find(report({ heldByManual: ['i-infy 2026-08-13'] }), 'i-infy')
    expect(held?.status).toBe('held')
    expect(held?.detail).toContain('2026-08-13')
    expect(held?.code).toBe('MANUAL_OVERRIDE_HELD')
    // The refusal outranks the write: the row was sent, and calling that "refreshed" would report
    // the opposite of what the database did.
    expect(held?.status).not.toBe('refreshed')
  })

  it('explains the instrument whose row never left the app, rather than calling it a defect', () => {
    // TCS is a target with a manual price. Nothing came back for it and nothing failed, because the
    // in-app store refused the fetched row before `save_prices` was ever called.
    const tcs = find(report(), 'i-tcs')
    expect(tcs?.status).toBe('held')
    expect(tcs?.detail).toContain('refused before it left the app')
  })

  it('reports an instrument with no outcome at all as exactly that', () => {
    const noResult = find(
      report({
        outcome: outcome({
          prices: {
            startedAt: NOW,
            finishedAt: NOW,
            requested: 4,
            updated: 0,
            unchanged: 0,
            failed: 0,
            failures: [],
            creditsConsumed: 0,
            rateLimited: false,
          },
        }),
      }),
      'i-fund',
    )
    expect(noResult?.status).toBe('no_result')
    expect(noResult?.detail).toContain('should not be possible')
  })

  it('says a stopped run was stopped rather than blaming the instrument', () => {
    const stopped = find(
      report({
        cancelled: true,
        outcome: outcome({
          prices: {
            startedAt: NOW,
            finishedAt: NOW,
            requested: 4,
            updated: 0,
            unchanged: 0,
            failed: 0,
            failures: [],
            creditsConsumed: 0,
            rateLimited: false,
          },
        }),
      }),
      'i-fund',
    )
    expect(stopped?.status).toBe('no_result')
    expect(stopped?.detail).toContain('stopped before this instrument was reached')
  })

  it('accounts for every instrument that was in scope, and no fresh one', () => {
    const rowsOut = report()
    const ids = rowsOut.map((row) => row.instrumentId).sort()
    // The four targets, plus the SGB — which has no provider and no price, so the orchestrator
    // takes it in scope and reports NOT_SUPPORTED for it. Bitcoin is fresh and gold is priced by
    // hand, so neither is asked about or reported on.
    expect(ids).toEqual(['i-aapl', 'i-fund', 'i-infy', 'i-sgb', 'i-tcs'])
    expect(ids).not.toContain('i-btc')
  })

  it('leads with what failed', () => {
    const rowsOut = report()
    expect(rowsOut[0]?.status).toBe('failed')
    expect(countByStatus(rowsOut)).toEqual({
      refreshed: 1,
      unchanged: 1,
      held: 1,
      failed: 1,
      no_result: 1,
    })
  })

  it('names an instrument that no longer exists as a defect in Misal', () => {
    const rowsOut = report({ unknown: ['i-ghost 2026-08-13'] })
    const ghost = rowsOut.find((row) => row.instrumentId === 'i-ghost')
    expect(ghost?.status).toBe('failed')
    expect(ghost?.code).toBe('UNKNOWN_INSTRUMENT')
    expect(ghost?.detail).toContain('defect in Misal')
  })
})
