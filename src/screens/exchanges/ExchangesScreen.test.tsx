/**
 * Screen 07 — Exchanges, driven through a stand-in runtime.
 *
 * The assertions that matter here are not that a panel renders. They are:
 *
 *   - the CoinDCX disclosure is above the field a key is pasted into, says what a CoinDCX key can
 *     do in those words, and cannot be walked past without an acknowledgement;
 *   - Binance is not described the same way, because its permission gate is real;
 *   - neither the key nor the secret reaches the DOM — not in a value, not in an attribute, and
 *     not in an error message, including one an exchange echoed the secret into;
 *   - a running sync always shows something moving, with the count the runner reported;
 *   - the fold-versus-balance gap is printed digit for digit, and the Binance Convert blind spot is
 *     stated rather than left to be inferred from a balance with no trades behind it;
 *   - disconnecting is about the keychain entry, and a failure says the key is still there;
 *   - a second key for an exchange already connected replaces the first rather than founding a
 *     second account holding the same coins.
 */

import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ProgressReporter, ScopeReport, SyncOutcome } from '@adapters/index'
import { AdapterError } from '@adapters/index'
import { addDec, dec, ZERO_DEC } from '@domain/numeric'
import { derivePortfolioPositions } from '@valuation/index'
import { assertHonest } from '@ui/testing/assert-honest'
import type { AccountRow, PortfolioRows, PositionRow } from '../../data/client'
import { buildAccounts, buildInstruments } from '../../data/portfolio'
import { ExchangesScreen } from './ExchangesScreen'
import type { ConnectionView, ConnectRequest, ExchangeRuntime } from './runtime'

const KEY = 'sentinel-key-4b81f0c2d3e5'
const SECRET = 'sentinel-secret-9f2c1a4e9b7d'

const READ_ONLY: ScopeReport = {
  verification: 'introspected',
  canRead: true,
  canTrade: false,
  canWithdraw: false,
  canTransferInternally: false,
  ipRestricted: true,
}

const TRADE_CAPABLE: ScopeReport = { ...READ_ONLY, canTrade: true, ipRestricted: false }

const UNSCOPABLE: ScopeReport = {
  verification: 'unscopable',
  canRead: true,
  canTrade: true,
  canWithdraw: false,
  canTransferInternally: 'unknown',
  ipRestricted: 'unknown',
}

/**
 * A sync that landed, with one holding that reconciles and one that does not.
 *
 * The gap is eighteen decimals wide on purpose: it is the value a float64 would round away, and it
 * has to survive the whole way to the screen intact.
 */
const OUTCOME: SyncOutcome = {
  status: 'completed',
  partial: false,
  scope: READ_ONLY,
  balancesCommitted: 2,
  fillsCommitted: 41,
  fillsDuplicate: 3,
  rowsFailed: 0,
  issues: [
    { severity: 'warning', code: 'coverage_note', message: 'A note the report shows separately.' },
    { severity: 'warning', code: 'unresolved_asset', message: 'FOOBAR is not in the catalogue.' },
  ],
  coverage: [
    {
      instrumentId: 'i-eth',
      folded: dec('4.250000000000000000'),
      reported: dec('4.250000000000000000'),
      difference: dec('0'),
      matches: true,
    },
    {
      instrumentId: 'i-btc',
      folded: dec('0.310000000000000000'),
      reported: dec('0.310000000000000001'),
      difference: dec('0.000000000000000001'),
      matches: false,
    },
  ],
  errorCode: null,
}

const CONNECTIONS: readonly ConnectionView[] = [
  {
    accountId: 'acct-binance',
    providerId: 'binance',
    label: 'Binance spot',
    baseCurrency: 'USD',
    capability: 'snapshot',
    credentialStored: true,
    balancesAsOf: '2026-08-12',
  },
  {
    accountId: 'acct-coindcx',
    providerId: 'coindcx',
    label: 'CoinDCX main',
    baseCurrency: 'INR',
    capability: 'snapshot',
    credentialStored: false,
    balancesAsOf: null,
  },
]

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function runtime(over: Partial<ExchangeRuntime> = {}): ExchangeRuntime {
  return {
    listConnections: vi.fn().mockResolvedValue([]),
    instrumentNames: vi.fn().mockResolvedValue(new Map([['i-btc', 'Bitcoin'], ['i-eth', 'Ether']])),
    connect: vi.fn().mockResolvedValue({
      status: 'connected',
      scope: READ_ONLY,
      risk: { blocking: [], advisory: [] },
      accountId: 'acct-new',
    }),
    sync: vi.fn().mockResolvedValue(OUTCOME),
    disconnect: vi.fn().mockResolvedValue(undefined),
    newAccountId: () => 'acct-new',
    now: () => new Date('2026-08-13T09:00:00.000Z'),
    ...over,
  }
}

async function open(over: Partial<ExchangeRuntime> = {}): Promise<{
  container: HTMLElement
  deps: ExchangeRuntime
}> {
  const deps = runtime(over)
  const { container } = render(<ExchangesScreen runtime={deps} tickMillis={50_000} />)
  await screen.findByText('Connect an exchange account')
  return { container, deps }
}

function chooseCoindcx(): void {
  fireEvent.click(screen.getByRole('radio', { name: /CoinDCX/u }))
}

function paste(key = KEY, secret = SECRET): void {
  fireEvent.change(screen.getByLabelText(/API key/u), { target: { value: key } })
  fireEvent.change(screen.getByLabelText(/API secret/u), { target: { value: secret } })
}

// ---------------------------------------------------------------------------
// The disclosure
// ---------------------------------------------------------------------------

describe('Exchanges — the CoinDCX disclosure', () => {
  it('is rendered above the field the key is pasted into, not below it and not behind a toggle', async () => {
    const { container } = await open()
    chooseCoindcx()

    const disclosure = container.querySelector('[data-provider="coindcx"]')
    const field = screen.getByLabelText(/API key/u)
    expect(disclosure).not.toBeNull()
    // DOCUMENT_POSITION_FOLLOWING: the field comes after the disclosure in document order.
    expect(
      (disclosure as Element).compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // Nothing here is a <details>: a warning that must be opened is one the hurried user skips.
    expect(disclosure?.querySelector('details')).toBeNull()
    assertHonest(container)
  })

  it('says a CoinDCX key can trade and withdraw, and names the allowlist as the only thing in the way', async () => {
    await open()
    chooseCoindcx()

    expect(
      screen.getByText(/CoinDCX issues no read-only API keys\. This key will be able to trade and withdraw\./u),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/no endpoint that reports what a key is permitted to do/u),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/the only thing standing between this key and your money is Misal’s own request allowlist/u),
    ).toBeInTheDocument()
    // And it names where to check the claim rather than asking to be believed.
    expect(screen.getByText(/src\/adapters\/coindcx\/allowlist\.ts/u)).toBeInTheDocument()
  })

  it('does not describe Binance the same way, because Binance actually refuses an over-scoped key', async () => {
    await open()

    expect(
      screen.getByText(/Binance keys carry real permissions, and Misal checks them before storing anything\./u),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/A key that can withdraw is refused outright/u),
    ).toBeInTheDocument()
    expect(screen.queryByText(/issues no read-only API keys/u)).not.toBeInTheDocument()
  })

  it('will not send a CoinDCX key until the acknowledgement is ticked, and says why', async () => {
    const { deps } = await open()
    chooseCoindcx()
    paste()
    fireEvent.click(screen.getByRole('button', { name: 'Check this key and connect' }))

    expect(deps.connect).not.toHaveBeenCalled()
    expect(await screen.findByText(/the acknowledgement above is not a formality/u)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox'))
    paste()
    fireEvent.click(screen.getByRole('button', { name: 'Check this key and connect' }))

    await waitFor(() => {
      expect(deps.connect).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'coindcx', acknowledgedRisk: true }),
      )
    })
  })

  it('accepts a Binance key with no acknowledgement, because a read-only key needs none', async () => {
    const { deps } = await open()
    paste()
    fireEvent.click(screen.getByRole('button', { name: 'Check this key and connect' }))

    await waitFor(() => {
      expect(deps.connect).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'binance', acknowledgedRisk: false }),
      )
    })
  })
})

// ---------------------------------------------------------------------------
// The secret
// ---------------------------------------------------------------------------

describe('Exchanges — the secret', () => {
  it('sends the key exactly, then renders it nowhere and clears both fields', async () => {
    const { container, deps } = await open()
    paste()
    fireEvent.click(screen.getByRole('button', { name: 'Check this key and connect' }))

    await waitFor(() => {
      expect(deps.connect).toHaveBeenCalledWith(
        expect.objectContaining({ credential: { apiKey: KEY, apiSecret: SECRET } }),
      )
    })
    await screen.findByText(/is connected\. The key is in this machine’s keychain/u)

    // Cleared the moment they were read, and nowhere in the rendered markup — including every
    // attribute, which is where a "helpfully" reflected value would sit.
    expect(screen.getByLabelText(/API key/u)).toHaveValue('')
    expect(screen.getByLabelText(/API secret/u)).toHaveValue('')
    expect(container.innerHTML).not.toContain('sentinel')
    expect(screen.getByLabelText(/API key/u)).toHaveAttribute('type', 'password')
    assertHonest(container)
  })

  /**
   * The one that would otherwise be found in production.
   *
   * Misal never puts the secret in a message, but the message is not always Misal's: an exchange,
   * a proxy or a WAF can echo the request back, and that string is handed straight to an `alert`.
   * So the values are scrubbed out at the point the message is built, and this asserts it with a
   * deliberately hostile error rather than trusting that no upstream will ever do it.
   */
  it('keeps the secret out of a failure message even when the exchange echoes it back', async () => {
    const hostile = new Error(
      `CoinDCX rejected the request signed with ${SECRET} for key ${KEY}: invalid credentials`,
    )
    const { container } = await open({ connect: vi.fn().mockRejectedValue(hostile) })
    paste()
    fireEvent.click(screen.getByRole('button', { name: 'Check this key and connect' }))

    const note = await screen.findByText(/CoinDCX rejected the request signed with/u)
    expect(note).toHaveTextContent(/\[redacted\]/u)
    expect(note.textContent).not.toContain(SECRET)
    expect(note.textContent).not.toContain(KEY)
    expect(container.innerHTML).not.toContain('sentinel')
    // And it does not leave the user guessing what happened to the key they pasted.
    expect(note).toHaveTextContent(/Nothing was stored/u)
    assertHonest(container)
  })

  it('shows the withdrawal refusal as final, with the secret nowhere in it', async () => {
    const refusal = new AdapterError(
      'auth_over_scoped',
      'This API key can withdraw funds. Misal will not store it.',
      { detail: 'enableWithdrawals = true' },
    )
    const { container } = await open({ connect: vi.fn().mockRejectedValue(refusal) })
    paste()
    fireEvent.click(screen.getByRole('button', { name: 'Check this key and connect' }))

    expect(await screen.findByText(/This API key can withdraw funds/u)).toBeInTheDocument()
    expect(screen.getByText(/There is no override for this one/u)).toBeInTheDocument()
    expect(screen.getByText('This key was refused')).toBeInTheDocument()
    expect(container.innerHTML).not.toContain('sentinel')
    assertHonest(container)
  })
})

// ---------------------------------------------------------------------------
// Acknowledgement after the probe
// ---------------------------------------------------------------------------

describe('Exchanges — a key that needs acknowledging', () => {
  it('states that nothing was stored and that the key must be pasted again', async () => {
    const { container } = await open({
      connect: vi.fn().mockResolvedValue({
        status: 'needs_acknowledgement',
        scope: TRADE_CAPABLE,
        risk: {
          blocking: ['This key can place trades.'],
          advisory: ['This key is not restricted to an IP address.'],
        },
      }),
    })
    paste()
    fireEvent.click(screen.getByRole('button', { name: 'Check this key and connect' }))

    expect(await screen.findByText('This key was not stored')).toBeInTheDocument()
    expect(screen.getByText('This key can place trades.')).toBeInTheDocument()
    expect(screen.getByText(/This key is not restricted to an IP address\./u)).toBeInTheDocument()
    expect(screen.getByText(/you will have to paste it again/u)).toBeInTheDocument()
    expect(container.innerHTML).not.toContain('sentinel')
    assertHonest(container)
  })
})

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

describe('Exchanges — a sync in progress', () => {
  it('shows the phase, the pair being queried and the count the runner reported', async () => {
    let report: ProgressReporter = () => undefined
    const pending = deferred<SyncOutcome>()
    let clock = 0
    const { container } = await open({
      sync: vi.fn((_accountId: string, _providerId: string, onProgress: ProgressReporter) => {
        report = onProgress
        return pending.promise
      }),
      now: () => new Date(new Date('2026-08-13T09:00:00.000Z').getTime() + (clock += 1000)),
    })

    paste()
    fireEvent.click(screen.getByRole('button', { name: 'Check this key and connect' }))
    await screen.findByText(/Syncing Binance/u)

    act(() => {
      report({ phase: 'fills', done: 12, total: 200, detail: 'BTCUSDT' })
    })

    expect(screen.getByText('Walking the trade history')).toBeInTheDocument()
    expect(screen.getByText('BTCUSDT')).toBeInTheDocument()
    const facts = container.querySelector('.exch-progress-facts')
    expect(within(facts as HTMLElement).getByText('12 of 200')).toBeInTheDocument()
    // The bar is the runner's own count, not a guess.
    const bar = container.querySelector('progress')
    expect(bar).toHaveAttribute('value', '12')
    expect(bar).toHaveAttribute('max', '200')
    // And the screen says why this is slow, so minutes of quiet do not read as a hang.
    expect(screen.getByText(/takes minutes and is meant to/u)).toBeInTheDocument()
    expect(screen.getByText(/Running for/u)).toBeInTheDocument()
    expect(screen.getByText(/Last update/u)).toBeInTheDocument()

    act(() => {
      pending.resolve(OUTCOME)
    })
    await screen.findByText('Binance sync report')
  })

  it('says a count is not knowable rather than inventing a total', async () => {
    let report: ProgressReporter = () => undefined
    const pending = deferred<SyncOutcome>()
    const { container } = await open({
      sync: vi.fn((_accountId: string, _providerId: string, onProgress: ProgressReporter) => {
        report = onProgress
        return pending.promise
      }),
    })
    paste()
    fireEvent.click(screen.getByRole('button', { name: 'Check this key and connect' }))
    await screen.findByText(/Syncing Binance/u)

    act(() => {
      report({ phase: 'fills', done: 40, total: null, detail: 'page 3' })
    })

    expect(
      screen.getByText(/40 so far — the exchange does not say how many there will be/u),
    ).toBeInTheDocument()
    expect(container.querySelector('progress')).not.toHaveAttribute('value')

    act(() => {
      pending.resolve(OUTCOME)
    })
    await screen.findByText('Binance sync report')
  })
})

// ---------------------------------------------------------------------------
// Coverage honesty
// ---------------------------------------------------------------------------

describe('Exchanges — what the sync could not see', () => {
  it('prints the fold, the reported balance and the difference digit for digit', async () => {
    const { container } = await open()
    paste()
    fireEvent.click(screen.getByRole('button', { name: 'Check this key and connect' }))
    await screen.findByText('Binance sync report')

    const gaps = container.querySelector('.exch-gaps')
    expect(gaps).not.toBeNull()
    const row = within(gaps as HTMLElement).getByRole('row', { name: /Bitcoin/u })
    // Eighteen decimals, unrounded and unregrouped. A float64 would have eaten the last digit.
    expect(row).toHaveTextContent('0.310000000000000000')
    expect(row).toHaveTextContent('0.310000000000000001')
    expect(row).toHaveTextContent('0.000000000000000001')
    // The holding that reconciles is not listed as a gap.
    expect(within(gaps as HTMLElement).queryByText('Ether')).not.toBeInTheDocument()
    expect(screen.getByText(/1 of 2 holdings reconcile exactly/u)).toBeInTheDocument()
    assertHonest(container)
  })

  it('says what a snapshot account withholds instead of showing a cost basis it cannot support', async () => {
    await open()
    paste()
    fireEvent.click(screen.getByRole('button', { name: 'Check this key and connect' }))
    await screen.findByText('Binance sync report')

    expect(
      screen.getByText(/cost basis, realised and unrealised gains and XIRR are withheld/u),
    ).toBeInTheDocument()
    expect(screen.getByText('Snapshot account')).toBeInTheDocument()
  })

  it('names the Binance Convert blind spot rather than leaving a balance with no trades to be guessed at', async () => {
    await open()
    paste()
    fireEvent.click(screen.getByRole('button', { name: 'Check this key and connect' }))
    await screen.findByText('Binance sync report')

    expect(
      screen.getByText('Convert trades are read, but the oldest ones arrive over several syncs'),
    ).toBeInTheDocument()
    expect(screen.getByText(/genuinely absent rather than approximate/u)).toBeInTheDocument()
    // And the adapter's own statement of the gap is shown alongside, read from the adapter.
    expect(
      screen.getByText(/Binance Convert trades never appear in trade history/u),
    ).toBeInTheDocument()
  })

  it('does not show a permission list for an exchange that reports no permissions', async () => {
    const { container } = await open({
      connect: vi
        .fn()
        .mockResolvedValue({
          status: 'connected',
          scope: UNSCOPABLE,
          risk: { blocking: [], advisory: [] },
          accountId: 'acct-new',
        }),
      sync: vi.fn().mockResolvedValue({ ...OUTCOME, scope: UNSCOPABLE }),
    })
    chooseCoindcx()
    fireEvent.click(screen.getByRole('checkbox'))
    paste()
    fireEvent.click(screen.getByRole('button', { name: 'Check this key and connect' }))
    await screen.findByText('CoinDCX sync report')

    // "Withdraw funds: no" here would be a check that never happened, asserted on the authority of
    // a placeholder the adapter had to supply to satisfy a type.
    expect(screen.queryByText('Withdraw funds')).not.toBeInTheDocument()
    expect(screen.getByText(/Unknown, and unknowable/u)).toBeInTheDocument()
    // The Convert note belongs to Binance and is not repeated where it does not apply.
    expect(
      screen.queryByText('Anything you bought with Binance Convert is missing from this history'),
    ).not.toBeInTheDocument()
    assertHonest(container)
  })

  it('reports a quarantined key as a refusal to sync rather than as a failed sync', async () => {
    const { container } = await open({
      sync: vi.fn().mockResolvedValue({
        ...OUTCOME,
        status: 'quarantined',
        balancesCommitted: 0,
        fillsCommitted: 0,
        coverage: [],
        errorCode: 'auth_over_scoped',
      }),
    })
    paste()
    fireEvent.click(screen.getByRole('button', { name: 'Check this key and connect' }))
    await screen.findByText('Binance sync report')

    expect(screen.getByText('Refused to sync')).toBeInTheDocument()
    expect(screen.getByText(/has deleted nothing/u)).toBeInTheDocument()
    assertHonest(container)
  })
})

// ---------------------------------------------------------------------------
// Connected accounts
// ---------------------------------------------------------------------------

describe('Exchanges — connected accounts', () => {
  it('lists each account, whether a key is held, and the balances it carries', async () => {
    const { container } = await open({
      listConnections: vi.fn().mockResolvedValue(CONNECTIONS),
    })
    await screen.findByText('Connected accounts')

    expect(screen.getByText('Binance spot')).toBeInTheDocument()
    expect(screen.getByText('In the keychain')).toBeInTheDocument()
    expect(screen.getByText('2026-08-12')).toBeInTheDocument()
    // An account whose key is gone cannot be synced, and the button says so by being disabled.
    expect(screen.getByText('No key stored')).toBeInTheDocument()
    expect(screen.getByText('no balances committed yet')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Sync now' })[1]).toBeDisabled()
    assertHonest(container)
  })

  it('syncs an account that is already connected', async () => {
    const { deps } = await open({ listConnections: vi.fn().mockResolvedValue(CONNECTIONS) })
    await screen.findByText('Connected accounts')

    fireEvent.click(screen.getAllByRole('button', { name: 'Sync now' })[0] as HTMLElement)

    await waitFor(() => {
      expect(deps.sync).toHaveBeenCalledWith('acct-binance', 'binance', expect.any(Function))
    })
    expect(await screen.findByText('Binance sync report')).toBeInTheDocument()
  })

  it('asks before removing a key, and says the removal is from the keychain', async () => {
    const { deps } = await open({ listConnections: vi.fn().mockResolvedValue(CONNECTIONS) })
    await screen.findByText('Connected accounts')

    fireEvent.click(screen.getAllByRole('button', { name: 'Disconnect' })[0] as HTMLElement)
    expect(deps.disconnect).not.toHaveBeenCalled()
    expect(
      screen.getByText(/Remove the key for Binance spot from the keychain\?/u),
    ).toBeInTheDocument()
    expect(screen.getByText(/balances and trades already synced stay exactly where they are/u)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remove the key' }))

    await waitFor(() => {
      expect(deps.disconnect).toHaveBeenCalledWith('acct-binance')
    })
    expect(
      await screen.findByText(/has been removed from the keychain/u),
    ).toBeInTheDocument()
  })

  it('says the key is still in the keychain when the removal fails', async () => {
    const { deps } = await open({
      listConnections: vi.fn().mockResolvedValue(CONNECTIONS),
      disconnect: vi.fn().mockRejectedValue(new Error('the keychain is locked')),
    })
    await screen.findByText('Connected accounts')

    fireEvent.click(screen.getAllByRole('button', { name: 'Disconnect' })[0] as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'Remove the key' }))

    await waitFor(() => {
      expect(deps.disconnect).toHaveBeenCalled()
    })
    // Not "disconnected" with a quiet failure underneath: the key is still there and it says so.
    expect(
      await screen.findByText(/The key was NOT removed and is still in the keychain/u),
    ).toBeInTheDocument()
    expect(screen.getByText(/the keychain is locked/u)).toBeInTheDocument()
  })

  it('names what is absent when nothing is connected, rather than showing an empty table', async () => {
    const { container } = await open()
    expect(screen.getByText('No exchange account is connected')).toBeInTheDocument()
    expect(screen.queryByText('Connected accounts')).not.toBeInTheDocument()
    assertHonest(container)
  })

  it('reports an unreadable account list rather than showing none', async () => {
    await open({ listConnections: vi.fn().mockRejectedValue(new Error('database is locked')) })
    expect(await screen.findByRole('alert')).toHaveTextContent(/database is locked/u)
  })
})

// ---------------------------------------------------------------------------
// Replacing a key
// ---------------------------------------------------------------------------

/**
 * The smallest core that can still show the defect.
 *
 * `connect` files the account under the id it is handed and nothing else, which is exactly what
 * `exchange_commit_credential` used to do: its `ON CONFLICT (id)` cannot fire on an id that was
 * minted a millisecond ago, and it wrote no identity, so any number of anonymous duplicates were
 * legal. `sync` commits a balance snapshot for whichever account it is given, appending rather than
 * replacing, because that is what `commit_positions` does — the snapshot an account committed last
 * year is still the newest row for its instruments today.
 *
 * So this fixture is the *un*fixed core on purpose. What it exercises is the screen's half of the
 * problem: which account id the connect panel proposes. The core's own guard — the identity, and
 * the resolution that folds a replacement onto the account already carrying it — is tested against
 * a real database in `src-tauri/src/sync.rs`.
 */
interface FakeCore {
  readonly accounts: Map<string, AccountRow>
  readonly positions: PositionRow[]
  readonly runtime: ExchangeRuntime
}

function accountRow(id: string, label: string): AccountRow {
  return {
    id,
    providerId: 'binance',
    label,
    externalRef: null,
    identityKey: null,
    capability: 'snapshot',
    baseCurrency: 'USD',
    createdAt: '2026-01-01',
    providerShortCode: 'BIN',
  }
}

function fakeCore(): FakeCore {
  const accounts = new Map<string, AccountRow>([['acct-binance', accountRow('acct-binance', 'Binance spot')]])
  // One bitcoin, committed by the sync that ran before the key was rotated.
  const positions: PositionRow[] = [
    {
      id: 'pos-1',
      accountId: 'acct-binance',
      instrumentId: 'i-btc',
      quantity: '1',
      asOf: '2026-08-12',
      sourceDocumentId: 'doc-1',
    },
  ]
  let day = 12

  const core: FakeCore = {
    accounts,
    positions,
    runtime: runtime({
      listConnections: () =>
        Promise.resolve(
          [...accounts.values()].map(
            (account): ConnectionView => ({
              accountId: account.id,
              providerId: 'binance',
              label: account.label,
              baseCurrency: account.baseCurrency,
              capability: 'snapshot',
              credentialStored: true,
              balancesAsOf:
                positions
                  .filter((row) => row.accountId === account.id)
                  .map((row) => row.asOf)
                  .sort()
                  .at(-1) ?? null,
            }),
          ),
        ),
      connect: vi.fn((request: ConnectRequest) => {
        accounts.set(request.accountId, accountRow(request.accountId, request.label))
        return Promise.resolve({
          status: 'connected' as const,
          scope: READ_ONLY,
          risk: { blocking: [], advisory: [] },
          accountId: request.accountId,
        })
      }),
      sync: vi.fn((accountId: string) => {
        day += 1
        positions.push({
          id: `pos-${accountId}-${String(day)}`,
          accountId,
          instrumentId: 'i-btc',
          quantity: '1',
          asOf: `2026-08-${String(day)}`,
          sourceDocumentId: `doc-${String(day)}`,
        })
        return Promise.resolve(OUTCOME)
      }),
      newAccountId: vi.fn(() => 'acct-a-fresh-uuid'),
    }),
  }
  return core
}

/**
 * What the dashboard would show, through the code that computes it.
 *
 * Not a hand-rolled sum: `derivePortfolioPositions` keys on `(accountId, instrumentId)` and takes
 * the newest snapshot within each, which is precisely the step that counts a stale account and a
 * new one as two separate holdings.
 */
function bitcoinHeld(core: FakeCore): string {
  const rows: PortfolioRows = {
    accounts: [...core.accounts.values()],
    instruments: [
      {
        id: 'i-btc',
        assetClass: 'crypto',
        taxRegime: 'vda',
        displayName: 'Bitcoin',
        isin: null,
        currency: 'USD',
        precision: 8,
        fmv31Jan2018: null,
      },
    ],
    aliases: [],
    transactions: [],
    positions: core.positions,
    prices: [],
    fxRates: [],
    unresolved: [],
    settings: new Map(),
  }
  const instruments = buildInstruments(rows, [])
  const derived = derivePortfolioPositions(buildAccounts(rows, instruments, '2026-08-31'))
  if (!derived.ok) throw new Error('the fixture could not be valued')
  return derived.value
    .filter((position) => position.instrumentId === 'i-btc')
    .reduce((sum, position) => addDec(sum, position.quantity), ZERO_DEC)
    .toString()
}

describe('Exchanges — replacing the key on an account already connected', () => {
  /**
   * The defect, end to end.
   *
   * Misal's own sync report tells a user whose key has gained withdrawal permission to make a new
   * key and connect it, and this panel is the only place a key can be pasted. Before the fix the
   * screen minted a fresh uuid for it, the core happily created a second account, and the first
   * account's last balance snapshot went on being the newest row for its own instruments: one
   * bitcoin, reported as two, with nothing anywhere saying so.
   */
  it('does not create a second account, and does not report one bitcoin as two', async () => {
    const core = fakeCore()
    render(<ExchangesScreen runtime={core.runtime} tickMillis={50_000} />)
    await screen.findByText('Connected accounts')
    expect(bitcoinHeld(core)).toBe('1')

    paste()
    fireEvent.click(screen.getByRole('button', { name: /^Check this key and/u }))
    await screen.findByText('Binance sync report')

    // First, because it is the whole of the defect: reverting the reuse in `onSubmit` makes this
    // line read 2, and every other assertion here is an explanation of why.
    expect(bitcoinHeld(core)).toBe('1')
    expect([...core.accounts.keys()]).toEqual(['acct-binance'])
    expect(core.runtime.newAccountId).not.toHaveBeenCalled()
    expect(core.runtime.connect).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-binance' }),
    )
    // The sync after the rotation is the same account's next snapshot, not a second holding.
    expect(core.runtime.sync).toHaveBeenCalledWith('acct-binance', 'binance', expect.any(Function))
  })

  it('syncs the account the core filed the key under rather than the one the screen proposed', async () => {
    // The core has the last word: it resolves the account from the identity the exchange reports,
    // and a screen that ignored the answer would sync an account that may not exist.
    const { deps } = await open({
      connect: vi.fn().mockResolvedValue({
        status: 'connected',
        scope: READ_ONLY,
        risk: { blocking: [], advisory: [] },
        accountId: 'acct-the-core-chose',
      }),
    })
    paste()
    fireEvent.click(screen.getByRole('button', { name: 'Check this key and connect' }))

    await waitFor(() => {
      expect(deps.sync).toHaveBeenCalledWith('acct-the-core-chose', 'binance', expect.any(Function))
    })
  })

  it('says it is replacing a key, and which account it belongs to, rather than saying connect', async () => {
    const core = fakeCore()
    const { container } = render(<ExchangesScreen runtime={core.runtime} tickMillis={50_000} />)
    await screen.findByText('Connected accounts')

    expect(screen.getByText('Replace the key for Binance spot')).toBeInTheDocument()
    expect(screen.queryByText('Connect an exchange account')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check this key and replace' })).toBeInTheDocument()
    // And it says what a replacement does to everything already synced, which is the part a user
    // reading the word "connect" would have guessed wrong.
    expect(
      screen.getByText(/keeps the balances and trades it has already synced/u),
    ).toBeInTheDocument()
    assertHonest(container)

    paste()
    fireEvent.click(screen.getByRole('button', { name: 'Check this key and replace' }))
    expect(await screen.findByText(/The key for Binance spot has been replaced/u)).toBeInTheDocument()
  })

  /**
   * What a *failed* replacement is told, which is not what a failed first connection is told.
   *
   * "Nothing was stored: the key was discarded without being written" is true of a first
   * connection and cannot be said here. `commit_credential` writes the keychain entry and commits
   * the rows in one window, and on a rotation the row it would roll back to already exists: a
   * commit that fails after the write leaves the slot holding the previous key or the one just
   * entered. Emptying it instead would leave an account that still reads as connected and can no
   * longer sync — the outcome this sentence used to describe as the key having been discarded.
   */
  it('does not tell a failed replacement that nothing was stored', async () => {
    const core = fakeCore()
    vi.mocked(core.runtime.connect).mockRejectedValue(
      new Error('binance refused the request: the replacement could not be recorded.'),
    )
    const { container } = render(<ExchangesScreen runtime={core.runtime} tickMillis={50_000} />)
    await screen.findByText('Connected accounts')

    paste()
    fireEvent.click(screen.getByRole('button', { name: 'Check this key and replace' }))

    const note = await screen.findByText(/the replacement could not be recorded/u)
    expect(note).toHaveTextContent(/keeps the key it already had/u)
    expect(note.textContent).not.toContain('Nothing was stored')
    assertHonest(container)
  })

  it('still offers a first connection for an exchange that has none', async () => {
    const core = fakeCore()
    render(<ExchangesScreen runtime={core.runtime} tickMillis={50_000} />)
    await screen.findByText('Connected accounts')

    // Binance is connected; CoinDCX is not, and a key for it is a new account rather than a
    // replacement — the guard is per exchange, not "any account will do".
    chooseCoindcx()
    expect(screen.getByText('Connect an exchange account')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox'))
    paste()
    fireEvent.click(screen.getByRole('button', { name: 'Check this key and connect' }))

    await waitFor(() => {
      expect(core.runtime.connect).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'coindcx', accountId: 'acct-a-fresh-uuid' }),
      )
    })
  })
})

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

describe('Exchanges — telling the rest of the app', () => {
  it('announces a finished sync so the portfolio is not left showing the figures from before', async () => {
    const onSynced = vi.fn()
    const deps = runtime()
    render(<ExchangesScreen runtime={deps} onSynced={onSynced} tickMillis={50_000} />)
    await screen.findByText('Connect an exchange account')

    paste()
    fireEvent.click(screen.getByRole('button', { name: 'Check this key and connect' }))

    await waitFor(() => {
      expect(onSynced).toHaveBeenCalled()
    })
  })
})
