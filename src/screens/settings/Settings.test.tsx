/**
 * Screen 06 — Settings, driven through a stand-in runtime.
 *
 * The assertions that matter are not that a panel renders. They are:
 *
 *   - a key is entered and never rendered back, in any state, anywhere in the DOM;
 *   - a malformed price is refused before it reaches the core, with a sentence naming the problem;
 *   - the network disclosure is whatever the core reported, not a list this file believes;
 *   - a manual override is presented as taking precedence, with the fetched value it outranks
 *     still shown as kept rather than replaced;
 *   - a dismissed review entry is still on screen, still labelled, and still inside the withheld
 *     total — the failure migration 0006 split the columns to prevent;
 *   - an irreversible delete states what it destroys, in figures, and cannot be reached by the
 *     reflex that opened it.
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { fullCoverage, measured, notMeasured } from '@domain/measured'
import { minor } from '@domain/numeric'
import { assertHonest } from '@ui/testing/assert-honest'
import { moneyFigure } from '@ui/figure'
import type {
  AccountDeletionOutcome,
  AccountDeletionPreview,
  ReviewQueueEntry,
  SettingsSnapshot,
} from '../../data/settings'
import {
  Settings,
  type AccountSummary,
  type InstrumentOption,
  type SettingsRuntime,
} from './Settings'

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

const ACCOUNTS: AccountSummary[] = [
  {
    id: 'a-dcx',
    label: 'CoinDCX main',
    providerId: 'coindcx',
    shortCode: 'DCX',
    capability: 'snapshot',
    value: measured(moneyFigure(minor('118640000')), fullCoverage(minor('118640000'))),
    valueUnavailable: null,
  },
  {
    id: 'a-cas',
    label: 'HDFC folio',
    providerId: 'cams-cas',
    shortCode: 'CAS',
    capability: 'ledger',
    value: notMeasured('no_price', minor('4200000')),
    valueUnavailable: null,
  },
]

const PREVIEW: AccountDeletionPreview = {
  accountId: 'a-dcx',
  label: 'CoinDCX main',
  providerId: 'coindcx',
  capability: 'snapshot',
  transactions: 412,
  holdings: 9,
  positionRows: 31,
  queueEntries: 1,
  documentsRemoved: 6,
  documentsShared: 2,
  hasCredential: true,
  syncCursors: 3,
}

const OUTCOME: AccountDeletionOutcome = {
  label: 'CoinDCX main',
  transactions: 412,
  positions: 31,
  queueEntries: 1,
  documentsRemoved: 6,
  documentsKeptShared: 2,
  credentialForgotten: true,
}

function entry(over: Partial<ReviewQueueEntry> = {}): ReviewQueueEntry {
  return {
    id: 'u1',
    accountId: 'a-cas',
    accountLabel: 'HDFC folio',
    providerShortCode: 'CAS',
    rawIdentifier: 'isin:INF179K01YV8',
    rawName: 'Some Unlisted Fund',
    assetClassHint: 'mutual_fund',
    observedQuantity: '1234.5670',
    observedValueMinor: '11864000',
    currency: 'INR',
    firstSeenAt: '2026-07-01T00:00:00Z',
    lastSeenAt: '2026-08-01T00:00:00Z',
    ignoredAt: null,
    mappedAt: null,
    mappedInstrumentId: null,
    mappedInstrumentName: null,
    state: 'open',
    ...over,
  }
}

const QUEUE: ReviewQueueEntry[] = [
  entry(),
  entry({
    id: 'u2',
    rawIdentifier: 'provider-local:XYZ',
    rawName: 'Dismissed thing',
    observedValueMinor: '5000000',
    ignoredAt: '2026-07-14T00:00:00Z',
    state: 'dismissed',
  }),
  entry({
    id: 'u3',
    rawIdentifier: 'amfi:120503',
    rawName: 'Named but not landed',
    observedValueMinor: '2500000',
    mappedAt: '2026-07-20T00:00:00Z',
    mappedInstrumentId: 'i-ppfc',
    mappedInstrumentName: 'Parag Parikh Flexi Cap',
    state: 'mapped',
  }),
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
    listAccounts: vi.fn().mockResolvedValue(ACCOUNTS),
    previewDeletion: vi.fn().mockResolvedValue(PREVIEW),
    deleteAccount: vi.fn().mockResolvedValue(OUTCOME),
    loadReviewQueue: vi.fn().mockResolvedValue(QUEUE),
    restoreReviewEntry: vi.fn().mockResolvedValue(undefined),
    dismissReviewEntry: vi.fn().mockResolvedValue(undefined),
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
    // Scoped to the field's own row rather than a positional index into every Save button on the
    // screen. The index broke the moment the panel gained a sibling, which says nothing about
    // whether saving works.
    const ttlSave = ttl.closest('.set-field')?.querySelector('button')
    fireEvent.click(ttlSave as HTMLElement)

    await waitFor(() => {
      expect(deps.writeSetting).toHaveBeenCalledWith('price_cache_ttl_minutes', '720')
    })
    expect(await screen.findByText(/Saved\. Price cache lifetime is 720 minutes\./u)).toBeInTheDocument()
    assertHonest(container)
  })

  it('refuses a fractional count before it reaches the core, and says why', async () => {
    const { container, deps } = await open()

    const field = screen.getByLabelText(/Stale-price threshold/u)
    fireEvent.change(field, { target: { value: '2.5' } })
    // Scoped to this field's own row. Positionally this test asserted a negative - that no write
    // happened - which a click on an unrelated button would also satisfy, so it could have passed
    // while proving nothing.
    fireEvent.click(field.closest('.set-field')?.querySelector('button') as HTMLElement)

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

/**
 * The queue's reason to exist is a rupee figure that survives a dismissal.
 *
 * Before migration 0006, dismissing an entry set `resolved_at` and the withheld total fell to zero —
 * the dashboard then stated, of a holding it had never identified, that every identifier in every
 * document was mapped. These assertions are that failure written as tests: a dismissed entry stays
 * on screen, stays labelled, stays counted, and can be put back.
 */
describe('Settings — review queue', () => {
  it('keeps a dismissed entry visible, labelled and counted in the withheld total', async () => {
    const { container } = await open()

    // ₹1,18,640 open + ₹50,000 dismissed + ₹25,000 mapped, all three withheld.
    expect(await screen.findByText('₹1,93,640')).toBeInTheDocument()
    expect(screen.getByText('Dismissed thing', { exact: false })).toBeInTheDocument()

    const dismissed = container.querySelector('[data-queue-state="dismissed"]')
    expect(dismissed).not.toBeNull()
    expect(dismissed?.textContent).toContain('₹50,000')
    expect(dismissed?.textContent).toContain('withheld from every total')
    expect(
      screen.getByText(/dismissing stopped the question, not the withholding/u),
    ).toBeInTheDocument()
    assertHonest(container)
  })

  it('shows a mapped entry as still withholding, because its rows have not landed', async () => {
    const { container } = await open()

    expect(screen.getByText('Mapped — waiting for a statement')).toBeInTheDocument()
    const mapped = container.querySelector('[data-queue-state="mapped"]')
    expect(mapped?.textContent).toContain('Parag Parikh Flexi Cap')
    expect(mapped?.textContent).toContain('₹25,000')
    expect(
      screen.getByText(/the value stays withheld until a document carrying them is imported/u),
    ).toBeInTheDocument()
    assertHonest(container)
  })

  it('puts a dismissed entry back and says what that did and did not change', async () => {
    const { deps } = await open()

    fireEvent.click(await screen.findByRole('button', { name: 'Put back' }))

    await waitFor(() => {
      expect(deps.restoreReviewEntry).toHaveBeenCalledWith('u2')
    })
    expect(
      await screen.findByText(
        /its value was withheld the whole time it was dismissed, and still is/u,
      ),
    ).toBeInTheDocument()
  })

  it('dismisses an open entry from the standing queue as well as from an import', async () => {
    const { deps } = await open()

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))

    await waitFor(() => {
      expect(deps.dismissReviewEntry).toHaveBeenCalledWith('u1')
    })
    expect(
      await screen.findByText(/stays on this list and its value stays out of every total/u),
    ).toBeInTheDocument()
  })

  /**
   * An entry whose source printed no value withholds an unknown amount, not zero.
   *
   * Folding it in as zero would understate the withheld figure while looking like a complete total,
   * which is the precise shape of lie the queue exists to prevent.
   */
  it('names an entry with no stated value rather than counting it as nothing', async () => {
    const { container } = await open({
      loadReviewQueue: vi
        .fn()
        .mockResolvedValue([
          entry({ id: 'u9', observedValueMinor: null, currency: null }),
          entry({ id: 'u10', observedValueMinor: '11864000' }),
        ]),
    })

    expect(await screen.findByText('Amount unknown')).toBeInTheDocument()
    expect(container.textContent).toContain('1 entry whose source stated no value')
    expect(container.textContent).toContain('the amount those withhold is unknown, not zero')
    expect(container.querySelector('.set-withheld-figure')?.textContent).toBe('₹1,18,640')
    assertHonest(container)
  })

  it('reports an empty queue as nothing withheld rather than as an empty panel', async () => {
    const { container } = await open({ loadReviewQueue: vi.fn().mockResolvedValue([]) })
    expect(await screen.findByText('Nothing is being withheld')).toBeInTheDocument()
    assertHonest(container)
  })
})

/**
 * Deletion is irreversible and destroys imported history, so the confirmation is the feature.
 */
describe('Settings — deleting an account', () => {
  async function openConfirmation(over: Partial<SettingsRuntime> = {}): Promise<{
    container: HTMLElement
    deps: SettingsRuntime
  }> {
    const opened = await open(over)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Delete…' }))[0] as HTMLElement)
    return opened
  }

  it('states the label, the transactions, the holdings and the value before offering to delete', async () => {
    const { container, deps } = await openConfirmation()

    await waitFor(() => {
      expect(deps.previewDeletion).toHaveBeenCalledWith('a-dcx')
    })
    const danger = await screen.findByRole('group', { name: 'Delete CoinDCX main' })
    expect(danger.textContent).toContain('412')
    expect(danger.textContent).toContain('transactions')
    expect(danger.textContent).toContain('9')
    expect(danger.textContent).toContain('holdings')
    expect(danger.textContent).toContain('₹11,86,400')
    expect(danger.textContent).toContain('There is no undo and no backup is taken')
    expect(danger.textContent).toContain('6')
    expect(danger.textContent).toContain('2')
    expect(danger.textContent).toContain('not this account’s to destroy')
    expect(danger.textContent).toContain('keychain is deleted first')
    assertHonest(container)
  })

  it('will not delete until the account name is typed exactly', async () => {
    const { deps } = await openConfirmation()

    const button = await screen.findByRole('button', {
      name: 'Delete this account permanently',
    })
    expect(button).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/Type/u), { target: { value: 'CoinDCX' } })
    expect(button).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/Type/u), { target: { value: 'CoinDCX main' } })
    expect(button).toBeEnabled()
    expect(deps.deleteAccount).not.toHaveBeenCalled()

    fireEvent.click(button)
    await waitFor(() => {
      expect(deps.deleteAccount).toHaveBeenCalledWith('a-dcx')
    })
    expect(
      await screen.findByText(/The API key was deleted from your keychain\./u),
    ).toBeInTheDocument()
    expect(screen.getByText(/412 transactions, 31 holdings and 6 statements removed/u))
      .toBeInTheDocument()
  })

  /**
   * The account that broke valuation is the one most likely to need deleting, so a value that
   * cannot be computed must not become a blank in the middle of the warning — nor a reason the
   * delete is unreachable.
   */
  it('says why a value is unknown instead of printing a figure it does not have', async () => {
    const { container } = await open()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Delete…' }))[1] as HTMLElement)

    const danger = await screen.findByRole('group', { name: 'Delete HDFC folio' })
    expect(danger.textContent).toContain('a value Misal could not compute — no price available')
    expect(danger.textContent).not.toContain('₹0.00')
    assertHonest(container)
  })

  it('refuses to offer a delete it could not count first', async () => {
    await openConfirmation({
      previewDeletion: vi.fn().mockRejectedValue(new Error('database is locked')),
    })

    expect(
      await screen.findByText(/could not read what this would destroy/u),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Delete this account permanently' }),
    ).not.toBeInTheDocument()
  })

  it('reports a refused delete without claiming anything was removed', async () => {
    const { deps } = await openConfirmation({
      deleteAccount: vi.fn().mockRejectedValue(new Error('keychain unavailable: locked')),
    })

    fireEvent.change(await screen.findByLabelText(/Type/u), {
      target: { value: 'CoinDCX main' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Delete this account permanently' }))

    expect(await screen.findByText(/keychain unavailable: locked/u)).toBeInTheDocument()
    expect(screen.queryByText(/Deleted CoinDCX main/u)).not.toBeInTheDocument()
    expect(deps.listAccounts).toHaveBeenCalledTimes(1)
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
