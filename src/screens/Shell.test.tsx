/**
 * The shell, end to end.
 *
 * The Tauri command surface is the only thing mocked. Everything below it — the mapping boundary,
 * the fold, the valuation engine, the coverage report, the view-models and every component — runs
 * for real, so these tests fail if any of them stops telling the truth.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { assertHonest } from '@ui/testing/assert-honest'
import { AS_OF, emptyRows, portfolioRows } from './testing/fixtures'
import type { PortfolioRows } from '../data/client'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const { Shell } = await import('./Shell')
const { createQueryClient } = await import('./queries')

const STATUS = {
  databasePath: '/Users/x/Library/Application Support/Misal/misal.db',
  schemaVersion: 3,
  encrypted: true,
  accountCount: 4,
}

function serve(rows: PortfolioRows, status: unknown = STATUS): void {
  invoke.mockImplementation((command: string) => {
    switch (command) {
      case 'storage_status':
        return status === null ? Promise.reject(new Error('locked')) : Promise.resolve(status)
      case 'list_accounts':
        return Promise.resolve(rows.accounts)
      case 'list_instruments':
        return Promise.resolve(rows.instruments)
      case 'list_aliases':
        return Promise.resolve(rows.aliases)
      case 'list_transactions':
        return Promise.resolve(rows.transactions)
      case 'list_positions':
        return Promise.resolve(rows.positions)
      case 'list_prices':
        return Promise.resolve(rows.prices)
      case 'list_unresolved':
        return Promise.resolve(rows.unresolved)
      case 'get_settings':
        return Promise.resolve([...rows.settings.entries()])
      default:
        return Promise.reject(new Error(`Unexpected command ${command}`))
    }
  })
}

function mount(): { readonly container: HTMLElement; readonly unmount: () => void } {
  const client = createQueryClient()
  const wrapper = ({ children }: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const result = render(<Shell asOf={AS_OF} />, { wrapper })
  return { container: result.container, unmount: result.unmount }
}

async function go(hash: string): Promise<void> {
  await act(async () => {
    globalThis.location.hash = hash
    globalThis.dispatchEvent(new HashChangeEvent('hashchange'))
    await Promise.resolve()
  })
}

beforeEach(() => {
  globalThis.location.hash = '#/'
  invoke.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('Shell', () => {
  it('reads the local-only claim from the real database handle (H11)', async () => {
    serve(portfolioRows())
    const { container } = mount()

    await screen.findByText(STATUS.databasePath)
    expect(screen.getByText(/Local ·/u)).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
    })
    assertHonest(container)
  })

  it('says the claim cannot be verified rather than asserting it, when the handle fails', async () => {
    serve(portfolioRows(), null)
    mount()
    await screen.findByText(/the local-only claim cannot be verified/u)
  })

  it('shows a first-run invitation instead of a dashboard of zeros', async () => {
    serve(emptyRows())
    const { container } = mount()

    await screen.findByText(/nothing leaves the device/u)
    expect(screen.queryByText('Asset allocation')).toBeNull()
    expect(container.textContent).not.toMatch(/₹\s*0\b/u)

    assertHonest(container)
  })

  it('never renders a plausible numeral while loading', async () => {
    serve(portfolioRows())
    const { container } = mount()

    expect(screen.getByText(/Reading the local database/u)).toBeInTheDocument()
    expect(container.querySelectorAll('[data-metric]')).toHaveLength(0)

    await screen.findByRole('heading', { name: 'Dashboard' })
  })

  it('navigates between the four screens without losing focus to the body', async () => {
    serve(portfolioRows())
    const { container } = mount()
    await screen.findByRole('heading', { name: 'Dashboard' })

    for (const [hash, title] of [
      ['#/holdings', 'Holdings'],
      ['#/accounts', 'Accounts'],
      ['#/instruments', 'Instruments'],
      ['#/', 'Dashboard'],
    ] as const) {
      await go(hash)
      const heading = await screen.findByRole('heading', { name: title })
      expect(heading).toHaveFocus()
      expect(globalThis.document.activeElement).not.toBe(globalThis.document.body)
    }

    assertHonest(container)
  })

  it('marks the current screen in the nav', async () => {
    serve(portfolioRows())
    mount()
    await screen.findByRole('heading', { name: 'Dashboard' })

    await go('#/accounts')
    await screen.findByRole('heading', { name: 'Accounts' })
    expect(screen.getByRole('link', { name: 'Accounts' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current')
  })

  it('opens an instrument from the holdings table', async () => {
    serve(portfolioRows())
    const { container } = mount()
    await screen.findByRole('heading', { name: 'Dashboard' })

    await go('#/holdings')
    await screen.findByRole('heading', { name: 'Holdings' })
    const link = screen.getByRole('link', { name: 'Parag Parikh Flexi Cap' })
    expect(link.getAttribute('href')).toBe('#/instruments/i-ppfc')

    await go(link.getAttribute('href') ?? '#/')
    await screen.findByRole('heading', { name: 'Instrument' })
    expect(screen.getByText('Position by account')).toBeInTheDocument()

    assertHonest(container)
  })

  it('names the failure and keeps the frame when the database cannot be read', async () => {
    invoke.mockImplementation((command: string) =>
      command === 'storage_status'
        ? Promise.resolve(STATUS)
        : Promise.reject(new Error('E_STORE_LOCKED')),
    )
    mount()

    await screen.findByRole('alert')
    expect(screen.getByText(/E_STORE_LOCKED/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    // The frame persists, so the user knows what failed.
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument()
  })

  it('names a valuation failure without showing a figure in its place', async () => {
    serve(
      portfolioRows({
        instruments: [{ ...portfolioRows().instruments[0]!, assetClass: 'antiques' }],
      }),
    )
    const { container } = mount()

    await screen.findByRole('alert')
    expect(screen.getByText(/antiques/u)).toBeInTheDocument()
    expect(container.querySelectorAll('[data-metric]')).toHaveLength(0)
  })
})
