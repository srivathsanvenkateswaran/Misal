/**
 * Screen 07 — Refresh, driven through a stand-in runtime.
 *
 * The assertions that matter are not that a panel renders. They are:
 *
 *   - the population no provider covers is named before anything is fetched, and the only route to
 *     a value for it is stated and linked;
 *   - the cache lifetime holds a refresh back, says when the next one is due, and has an escape
 *     hatch that is a deliberate tick rather than a hidden default;
 *   - progress is a count of requests that actually came back, not an animation;
 *   - every instrument is accounted for afterwards, including the ones a manual price held and the
 *     ones that failed, with the provider's own reason;
 *   - the host list is whatever the core reported, never a list this file believes.
 *
 * No test opens a socket: the runtime is injected in every one of them, and `tests/setup.ts` fails
 * anything that reaches for one anyway.
 */

import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { assertHonest } from '@ui/testing/assert-honest'
import type { PortfolioRows, PriceRow } from '../../data/client'
import type { RefreshOutcome } from '../../data/refresh'
import { RefreshPanel } from './RefreshPanel'
import type { NetworkStatement, RefreshRuntime } from './RefreshPanel'
import type { RefreshRun } from './plan'

const NOW = '2026-08-13T09:00:00.000+05:30'

function price(over: Partial<PriceRow> & Pick<PriceRow, 'instrumentId' | 'asOf' | 'close'>): PriceRow {
  return { currency: 'INR', source: 'yahoo', fetchedAt: NOW, ...over }
}

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
      { instrumentId: 'i-tcs', scheme: 'nse', value: 'TCS', providerId: null },
    ],
    transactions: [],
    positions: [],
    prices: [
      price({ instrumentId: 'i-infy', asOf: '2026-08-01', close: '1100.00' }),
      price({ instrumentId: 'i-tcs', asOf: '2026-08-01', close: '3200.00', source: 'manual' }),
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

const NETWORK: NetworkStatement = {
  destinations: [
    {
      host: 'portal.amfiindia.com',
      pathPrefix: '/spages/',
      purpose: 'AMFI’s official daily NAV file, for every Indian mutual fund.',
      sends: 'Nothing identifying. The whole all-schemes file is downloaded and matched locally.',
      requiresKey: false,
    },
    {
      host: 'api.twelvedata.com',
      pathPrefix: '/',
      purpose: 'Twelve Data quotes, reached only if you have entered a key.',
      sends: 'The exchange symbol of each instrument being priced, and your API key.',
      requiresKey: true,
    },
  ],
  keyStored: false,
}

function outcome(over: Partial<RefreshOutcome> = {}): RefreshOutcome {
  return {
    status: 'ran',
    startedAt: NOW,
    finishedAt: NOW,
    prices: {
      startedAt: NOW,
      finishedAt: NOW,
      requested: 3,
      updated: 1,
      unchanged: 0,
      failed: 2,
      failures: [
        { instrumentId: 'i-fund', error: { code: 'RATE_LIMITED', retryAfterMs: 0 } },
        { instrumentId: 'i-sgb', error: { code: 'NOT_SUPPORTED' } },
      ],
      creditsConsumed: 0,
      rateLimited: true,
    },
    pricesWritten: 1,
    fx: [],
    fxWritten: 0,
    rateLimited: true,
    notes: [
      {
        code: 'FX_UNAVAILABLE',
        message: 'No provider is available for exchange rates.',
        subjects: ['USD'],
      },
    ],
    nextEligibleAt: null,
    ...over,
  }
}

const RUN: RefreshRun = {
  outcome: outcome(),
  saved: [
    {
      instrumentId: 'i-infy',
      asOf: '2026-08-13',
      close: '1163.6',
      currency: 'INR',
      source: 'yahoo',
      fetchedAt: NOW,
    },
  ],
  heldByManual: [],
  unknown: [],
  cancelled: false,
}

function runtime(over: Partial<RefreshRuntime> = {}): RefreshRuntime {
  return {
    loadRows: vi.fn().mockResolvedValue(rows()),
    loadNetwork: vi.fn().mockResolvedValue(NETWORK),
    run: vi.fn().mockResolvedValue(RUN),
    now: () => NOW,
    ...over,
  }
}

async function open(
  over: Partial<RefreshRuntime> = {},
  props: { onRefreshed?: () => void } = {},
): Promise<{ container: HTMLElement; deps: RefreshRuntime }> {
  const deps = runtime(over)
  const view = render(<RefreshPanel runtime={deps} {...props} />)
  await screen.findByText(/What a refresh would do/)
  return { container: view.container, deps }
}

describe('before anything is fetched', () => {
  it('counts what is stale, what was never priced, and what nothing can price', async () => {
    const { container } = await open()
    const text = container.textContent
    expect(text).toContain('Never priced')
    expect(text).toContain('No provider at all')
    // Infosys is stale, the fund was never priced, TCS is held by a manual price, and the SGB has
    // no provider at all.
    expect(screen.getByText('SGB 2031')).toBeInTheDocument()
    assertHonest(container)
  })

  it('says a refresh will never price the uncovered instruments, and links the only thing that will', async () => {
    const { container } = await open()
    expect(container.textContent).toContain('A refresh will never value these')
    const link = screen.getByRole('link', { name: /Set a manual price in Settings/ })
    expect(link).toHaveAttribute('href', '#/settings')
    expect(container.textContent).toContain('no price at all')
  })

  it('says plainly when there is nothing to do, rather than offering an empty table', async () => {
    const fresh = rows({
      instruments: rows().instruments.filter((instrument) => instrument.id === 'i-infy'),
      prices: [price({ instrumentId: 'i-infy', asOf: '2026-08-13', close: '1163.6' })],
    })
    const { container } = await open({ loadRows: vi.fn().mockResolvedValue(fresh) })
    expect(container.textContent).toContain('Nothing is stale')
    expect(container.textContent).toContain('Every instrument has a provider')
    assertHonest(container)
  })

  it('lists what would be asked about, and does not promise a provider it cannot use', async () => {
    const { container } = await open()
    expect(screen.getByText('Infosys')).toBeInTheDocument()
    // The keyed provider is named only as something this screen cannot reach for.
    expect(container.textContent).toContain('has no command that reads a key back')
  })
})

describe('the cache lifetime', () => {
  const held = (): Partial<RefreshRuntime> => ({
    loadRows: vi.fn().mockResolvedValue(
      rows({
        settings: new Map([
          ['base_currency', 'INR'],
          ['price_cache_ttl_minutes', '360'],
          ['last_price_refresh_at', '2026-08-13T08:00:00.000+05:30'],
        ]),
      }),
    ),
  })

  it('holds the refresh back and says when the next one is due', async () => {
    const { container, deps } = await open(held())
    expect(screen.getByRole('button', { name: /Refresh prices and rates/ })).toBeDisabled()
    expect(container.textContent).toContain('Held by the cache lifetime')
    expect(container.textContent).toContain('13 Aug 2026 14:00')
    expect(deps.run).not.toHaveBeenCalled()
  })

  it('lets the user override it explicitly, and passes that through as force', async () => {
    const { deps } = await open(held())
    fireEvent.click(screen.getByRole('checkbox'))
    const button = screen.getByRole('button', { name: /Refresh prices and rates/ })
    expect(button).toBeEnabled()

    fireEvent.click(button)
    await waitFor(() => {
      expect(deps.run).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(deps.run).mock.calls[0]?.[0].force).toBe(true)
  })

  it('does not force a refresh nobody asked to force', async () => {
    const { deps } = await open()
    fireEvent.click(screen.getByRole('button', { name: /Refresh prices and rates/ }))
    await waitFor(() => {
      expect(deps.run).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(deps.run).mock.calls[0]?.[0].force).toBe(false)
  })
})

describe('while it runs', () => {
  it('counts the requests that have actually come back', async () => {
    let finish: ((run: RefreshRun) => void) | null = null
    const pending = new Promise<RefreshRun>((resolve) => {
      finish = resolve
    })
    const { container } = await open({
      run: vi.fn().mockImplementation((request: { onProgress: (p: unknown) => void }) => {
        request.onProgress({ requests: 0, host: 'query1.finance.yahoo.com' })
        request.onProgress({ requests: 7, host: 'query1.finance.yahoo.com' })
        return pending
      }),
    })

    fireEvent.click(screen.getByRole('button', { name: /Refresh prices and rates/ }))
    await waitFor(() => {
      expect(container.textContent).toContain('7 requests have come back')
    })
    expect(container.textContent).toContain('Contacting query1.finance.yahoo.com')
    // A stop is offered, because a few hundred paced requests is a long time to be trapped.
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()

    await act(async () => {
      finish?.(RUN)
      await pending
    })
  })
})

describe('what happened', () => {
  const finished = async () => {
    const onRefreshed = vi.fn()
    const opened = await open({}, { onRefreshed })
    fireEvent.click(screen.getByRole('button', { name: /Refresh prices and rates/ }))
    await screen.findByText('What happened')
    return { ...opened, onRefreshed }
  }

  it('accounts for every instrument, with the provider’s own reason for a failure', async () => {
    const { container } = await finished()
    expect(container.textContent).toContain('1 refreshed')
    expect(container.textContent).toContain('₹1163.6')
    // The rate limit is reported, not retried.
    expect(container.textContent).toContain('rate limiting us')
    // And the instrument nothing covers is named as such rather than as a mystery.
    expect(container.textContent).toContain('No price provider covers these')
    expect(container.textContent).toContain('Partial success is the ordinary outcome')
    assertHonest(container)
  })

  it('states that a manual price of yours won, rather than swallowing it', async () => {
    const { container } = await finished()
    // TCS is a target with a manual price and no fetched row of its own: held, not missing.
    expect(container.textContent).toContain('Held by your manual price')
    expect(container.textContent).toContain('refused before it left the app')
  })

  it('repeats the orchestrator’s notes rather than paraphrasing them', async () => {
    const { container } = await finished()
    expect(container.textContent).toContain('No provider is available for exchange rates.')
    expect(container.textContent).toContain('fx unavailable')
  })

  it('tells the shell that stored figures moved', async () => {
    const { onRefreshed, deps } = await finished()
    expect(onRefreshed).toHaveBeenCalled()
    // And re-reads the database, so the gate and the stale list reflect the run that just happened.
    expect(vi.mocked(deps.loadRows).mock.calls.length).toBeGreaterThan(1)
  })

  it('reports a run the cache lifetime skipped as nothing having happened', async () => {
    const { container } = await open(
      {
        run: vi.fn().mockResolvedValue({
          outcome: outcome({
            status: 'skipped_by_ttl',
            prices: null,
            pricesWritten: 0,
            notes: [],
            rateLimited: false,
            nextEligibleAt: '2026-08-13T14:00:00.000+05:30',
          }),
          saved: [],
          heldByManual: [],
          unknown: [],
          cancelled: false,
        } satisfies RefreshRun),
      },
    )
    fireEvent.click(screen.getByRole('button', { name: /Refresh prices and rates/ }))
    const panel = await screen.findByText('Nothing was fetched')
    expect(panel).toBeInTheDocument()
    expect(container.textContent).toContain('no request was made and nothing was changed')
    expect(container.textContent).toContain('13 Aug 2026 14:00')
  })
})

describe('what leaves this machine', () => {
  it('states the hosts the core reported, not a list of its own', async () => {
    const { container } = await open()
    expect(screen.getByText('portal.amfiindia.com')).toBeInTheDocument()
    expect(container.textContent).toContain('never contacted — no key')
    // Yahoo is not in this stand-in allowlist, so it must not appear: the table is generated, and a
    // screen that added a host from memory would be describing a Misal that does not exist.
    expect(container.textContent).not.toContain('query1.finance.yahoo.com')
  })
})

describe('when the database cannot be read', () => {
  it('says so and offers a retry, rather than showing an empty plan', async () => {
    const deps = runtime({ loadRows: vi.fn().mockRejectedValue(new Error('database is locked')) })
    const view = render(<RefreshPanel runtime={deps} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('database is locked')
    expect(view.container.textContent).not.toContain('What a refresh would do')
  })
})
