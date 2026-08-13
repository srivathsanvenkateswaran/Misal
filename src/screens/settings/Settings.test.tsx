/**
 * Screen 06 — Settings, driven through a stand-in runtime.
 *
 * The assertions that matter are not that a panel renders. They are:
 *
 *   - a key is entered and never rendered back, in any state, anywhere in the DOM;
 *   - a malformed price is refused before it reaches the core, with a sentence naming the problem;
 *   - the network disclosure is whatever the core reported, not a list this file believes;
 *   - a manual override is presented as taking precedence, with the fetched value it outranks
 *     still shown as kept rather than replaced.
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { assertHonest } from '@ui/testing/assert-honest'
import type { SettingsSnapshot } from '../../data/settings'
import { Settings, type InstrumentOption, type SettingsRuntime } from './Settings'

const SNAPSHOT: SettingsSnapshot = {
  settings: [
    { key: 'base_currency', value: 'INR', updatedAt: '2026-08-12T00:00:00Z' },
    { key: 'concentration_flag_percent', value: '20', updatedAt: '2026-08-12T00:00:00Z' },
    { key: 'price_cache_ttl_minutes', value: '360', updatedAt: '2026-08-12T00:00:00Z' },
    { key: 'stale_price_days', value: '3', updatedAt: '2026-08-12T00:00:00Z' },
  ],
  definitions: [
    {
      key: 'base_currency',
      label: 'Base currency',
      help: 'Every total is converted to this currency.',
      kind: 'currency',
      unit: null,
      min: null,
      max: null,
      choices: ['INR', 'USD'],
    },
    {
      key: 'price_cache_ttl_minutes',
      label: 'Price cache lifetime',
      help: 'How old a stored price may be before a refresh re-fetches it.',
      kind: 'integer',
      unit: 'minutes',
      min: 1,
      max: 20_160,
      choices: [],
    },
    {
      key: 'stale_price_days',
      label: 'Stale-price threshold',
      help: 'Past this age a price is labelled stale wherever it appears.',
      kind: 'integer',
      unit: 'days',
      min: 1,
      max: 365,
      choices: [],
    },
    {
      key: 'concentration_flag_percent',
      label: 'Concentration flag',
      help: 'A holding at or above this share of net worth is flagged.',
      kind: 'integer',
      unit: 'percent',
      min: 1,
      max: 100,
      choices: [],
    },
  ],
  providers: [
    {
      id: 'twelvedata',
      displayName: 'Twelve Data',
      covers: 'US equities, crypto and FX rates, on the free Basic plan.',
      withoutKey: 'Indian exchange data is not on the Basic plan even with a key.',
      status: 'absent',
      detail: null,
    },
  ],
  overrides: [
    {
      instrumentId: 'i-gold',
      instrumentName: 'Sovereign gold bond 2031',
      assetClass: 'gold',
      asOf: '2026-08-12',
      close: '7412.00',
      currency: 'INR',
      recordedAt: '2026-08-12T11:02:00Z',
      supersededSource: null,
      supersededClose: null,
    },
    {
      instrumentId: 'i-aapl',
      instrumentName: 'Apple Inc',
      assetClass: 'us_equity',
      asOf: '2026-08-11',
      close: '230.55',
      currency: 'USD',
      recordedAt: '2026-08-11T11:02:00Z',
      supersededSource: 'twelvedata',
      supersededClose: '221.10',
    },
  ],
  network: [
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
}

const INSTRUMENTS: InstrumentOption[] = [
  { id: 'i-gold', displayName: 'Sovereign gold bond 2031', isin: null, currency: 'INR' },
  { id: 'i-aapl', displayName: 'Apple Inc', isin: 'US0378331005', currency: 'USD' },
]

function runtime(over: Partial<SettingsRuntime> = {}): SettingsRuntime {
  return {
    load: vi.fn().mockResolvedValue(SNAPSHOT),
    listInstruments: vi.fn().mockResolvedValue(INSTRUMENTS),
    writeSetting: vi.fn().mockResolvedValue(undefined),
    setProviderKey: vi.fn().mockResolvedValue({ ...SNAPSHOT.providers[0], status: 'present' }),
    clearProviderKey: vi.fn().mockResolvedValue(SNAPSHOT.providers[0]),
    setManualPrice: vi.fn().mockResolvedValue(undefined),
    deleteManualPrice: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

async function open(over: Partial<SettingsRuntime> = {}): Promise<{
  container: HTMLElement
  deps: SettingsRuntime
}> {
  const deps = runtime(over)
  const { container } = render(<Settings runtime={deps} />)
  await screen.findByText('Preferences')
  return { container, deps }
}

describe('Settings — preferences', () => {
  it('shows every stored value and writes one back through the core', async () => {
    const { container, deps } = await open()

    const ttl = screen.getByLabelText(/Price cache lifetime/u)
    expect(ttl).toHaveValue('360')

    fireEvent.change(ttl, { target: { value: '720' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[1] as HTMLElement)

    await waitFor(() => {
      expect(deps.writeSetting).toHaveBeenCalledWith('price_cache_ttl_minutes', '720')
    })
    expect(await screen.findByText(/Saved\. Price cache lifetime is 720 minutes\./u)).toBeInTheDocument()
    assertHonest(container)
  })

  it('refuses a fractional count before it reaches the core, and says why', async () => {
    const { container, deps } = await open()

    fireEvent.change(screen.getByLabelText(/Stale-price threshold/u), { target: { value: '2.5' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[2] as HTMLElement)

    expect(
      await screen.findByText(/must be a whole number of days; “2\.5” is not/u),
    ).toBeInTheDocument()
    expect(deps.writeSetting).not.toHaveBeenCalled()
    assertHonest(container)
  })

  /**
   * The preferences are stored and read back correctly, and nothing in the engine consults them
   * yet. Saying so is the same discipline as H11 on the status line: a screen does not imply an
   * effect it cannot produce. Delete this assertion when the engine starts reading them — and the
   * sentence with it.
   */
  it('does not imply an effect these settings do not yet have', async () => {
    // Updated when the refresh screen landed and began consulting the cache lifetime: one of the
    // four is now live and the copy says so. The discipline is unchanged - a screen must not imply
    // an effect it cannot produce - but it cuts both ways, and understating what a setting does is
    // the same failure as overstating it.
    await open()
    expect(
      screen.getByText(/Only the cache lifetime changes behaviour today/u),
    ).toBeInTheDocument()
  })

  it('offers only the currencies the core listed', async () => {
    await open()
    const select = screen.getByLabelText(/Base currency/u)
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['INR', 'USD'])
  })
})

describe('Settings — provider keys', () => {
  it('never renders the key, in the field or anywhere else', async () => {
    const { container, deps } = await open()
    const field = screen.getByLabelText('API key')

    fireEvent.change(field, { target: { value: 'td-sentinel-8f2c1a4e9b7d' } })
    fireEvent.click(screen.getByRole('button', { name: 'Store' }))

    await waitFor(() => {
      expect(deps.setProviderKey).toHaveBeenCalledWith('twelvedata', 'td-sentinel-8f2c1a4e9b7d')
    })

    // Cleared the moment the write returns, and nowhere in the rendered markup — including every
    // attribute, which is where a "helpfully" reflected value would sit.
    await waitFor(() => {
      expect(field).toHaveValue('')
    })
    expect(container.innerHTML).not.toContain('td-sentinel')
    expect(await screen.findByText(/Stored in the keychain/u)).toBeInTheDocument()
    assertHonest(container)
  })

  it('states whether a key is held without offering any way to read it back', async () => {
    const held: SettingsSnapshot = {
      ...SNAPSHOT,
      providers: [{ ...SNAPSHOT.providers[0]!, status: 'present' }],
    }
    const { container } = await open({ load: vi.fn().mockResolvedValue(held) })

    expect(screen.getByText('Key stored')).toBeInTheDocument()
    // Nothing on the screen reveals, shows or copies a key; the only verbs are store and clear.
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent ?? '')
    expect(labels.some((label) => /show|reveal|copy|view/iu.test(label))).toBe(false)
    expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password')
    assertHonest(container)
  })

  it('says what works with no key at all, and names AMFI as official', async () => {
    await open()
    expect(
      screen.getByText(/AMFI’s official daily file, which is free, keyless and authoritative/u),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Indian exchange data is not on the Basic plan even with a key\./u),
    ).toBeInTheDocument()
  })

  it('reports an unreadable keychain as its own state rather than as "no key"', async () => {
    const broken: SettingsSnapshot = {
      ...SNAPSHOT,
      providers: [
        {
          ...SNAPSHOT.providers[0]!,
          status: 'unavailable',
          detail: 'secret service is not running',
        },
      ],
    }
    await open({ load: vi.fn().mockResolvedValue(broken) })

    expect(screen.getByText('Keychain unreadable')).toBeInTheDocument()
    expect(screen.getByText(/it cannot say whether a key is stored/u)).toBeInTheDocument()
    // Clearing a key it cannot see would be a guess about the user's keychain.
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled()
  })
})

describe('Settings — manual prices', () => {
  it('sends a validated price, exactly as typed', async () => {
    const { container, deps } = await open()

    fireEvent.change(screen.getByLabelText('Instrument'), { target: { value: 'i-gold' } })
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-13' } })
    fireEvent.change(screen.getByLabelText(/Price per unit/u), { target: { value: '7412.5000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set price' }))

    await waitFor(() => {
      // Trailing zeros intact. They are the instrument's precision, not noise.
      expect(deps.setManualPrice).toHaveBeenCalledWith('i-gold', '2026-08-13', '7412.5000')
    })
    expect(await screen.findByText(/outranks anything a refresh fetches/u)).toBeInTheDocument()
    assertHonest(container)
  })

  it('refuses a grouped figure at the boundary, naming the separator', async () => {
    const { container, deps } = await open()

    fireEvent.change(screen.getByLabelText('Instrument'), { target: { value: 'i-gold' } })
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-13' } })
    fireEvent.change(screen.getByLabelText(/Price per unit/u), { target: { value: '1,25,000.50' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set price' }))

    expect(await screen.findByText(/contains a comma/u)).toBeInTheDocument()
    expect(deps.setManualPrice).not.toHaveBeenCalled()
    assertHonest(container)
  })

  /**
   * The date control refuses 31 February itself — it is a native date input, and jsdom clears an
   * impossible value exactly as a browser does. What is asserted here is the guard behind it: the
   * screen does not send a price with no date attached. `describeDateInput` covers the calendar
   * check directly, where the input cannot swallow the case first.
   */
  it('will not send a price with no date attached', async () => {
    const { deps } = await open()

    fireEvent.change(screen.getByLabelText('Instrument'), { target: { value: 'i-gold' } })
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-02-31' } })
    fireEvent.change(screen.getByLabelText(/Price per unit/u), { target: { value: '10.00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set price' }))

    expect(screen.getByLabelText('Date')).toHaveValue('')
    expect(await screen.findByText('Choose the date this price is for.')).toBeInTheDocument()
    expect(deps.setManualPrice).not.toHaveBeenCalled()
  })

  it('lists each override and shows the fetched value it outranks as kept, not replaced', async () => {
    const { container } = await open()

    expect(screen.getByText('₹7412.00')).toBeInTheDocument()
    expect(screen.getByText('$230.55')).toBeInTheDocument()
    // The fetched row is still there underneath, and the screen says so.
    expect(screen.getByText('$221.10')).toBeInTheDocument()
    expect(screen.getByText(/twelvedata · kept, not replaced/u)).toBeInTheDocument()
    expect(screen.getByText('no fetched price that day')).toBeInTheDocument()
    assertHonest(container)
  })

  it('removes one override and states what the instrument falls back to', async () => {
    const { deps } = await open()

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0] as HTMLElement)

    await waitFor(() => {
      expect(deps.deleteManualPrice).toHaveBeenCalledWith('i-gold', '2026-08-12')
    })
    expect(
      await screen.findByText(/its value is withheld from every total rather than estimated/u),
    ).toBeInTheDocument()
  })

  it('presents an override as the supported route, not as a workaround', async () => {
    await open()
    expect(screen.getByText(/it is the supported route, not a workaround/u)).toBeInTheDocument()
    expect(
      screen.getByText(/a refresh has no way to overwrite one/u),
    ).toBeInTheDocument()
  })
})

describe('Settings — what leaves this machine', () => {
  it('lists exactly the hosts the core reported, with what each request carries', async () => {
    const { container } = await open()

    const rows = [...container.querySelectorAll('.set-network tbody tr')]
    expect(rows.map((row) => row.querySelector('th')?.textContent?.split('never')[0])).toEqual([
      'portal.amfiindia.com',
      'api.twelvedata.com',
    ])
    expect(screen.getByText('/spages/')).toBeInTheDocument()
    expect(
      screen.getByText(/Nothing identifying\. The whole all-schemes file is downloaded/u),
    ).toBeInTheDocument()
    assertHonest(container)
  })

  it('says which listed hosts are never contacted, because no key is stored', async () => {
    await open()
    expect(screen.getByText('never contacted — no key')).toBeInTheDocument()
    expect(
      screen.getByText(/1 of these is contacted only when a provider key is stored, and none is\./u),
    ).toBeInTheDocument()
  })

  it('reports no account, no telemetry and no scheduled traffic as facts about this build', async () => {
    await open()
    expect(
      screen.getByText(
        /no account, no sign-in, no server and no telemetry\. Nothing is uploaded, and nothing is sent on a schedule\./u,
      ),
    ).toBeInTheDocument()
  })
})

describe('Settings — failure', () => {
  it('says the settings could not be read rather than showing empty panels', async () => {
    const deps = runtime({ load: vi.fn().mockRejectedValue(new Error('database is locked')) })
    render(<Settings runtime={deps} />)

    expect(await screen.findByRole('alert')).toHaveTextContent(/database is locked/u)
    expect(screen.queryByText('Preferences')).not.toBeInTheDocument()
  })
})
