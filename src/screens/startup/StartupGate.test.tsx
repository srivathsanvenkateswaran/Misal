/**
 * Startup, end to end from the command boundary up.
 *
 * These tests exist because the defect they cover could not have been caught by the ones that
 * came before them: every other test in this repository injects a database key directly, so the
 * real startup path — keychain, prompt, refusal — was never executed by anything. The keychain is
 * mocked here at the one place it crosses into the frontend, the `startup_open_store` command, so
 * a refusal can be produced on a machine whose keychain is perfectly happy.
 *
 * The claim under test is not "an error is handled". It is that the application reaches a
 * *rendered, explanatory* state — a screen that names what was being asked for, why, and what to
 * do — rather than hanging on a blank window or dying.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const { StartupGate } = await import('./StartupGate')

function TheApp(): ReactNode {
  return <p>The dashboard</p>
}

function mount(): void {
  render(
    <StartupGate>
      <TheApp />
    </StartupGate>,
  )
}

beforeEach(() => {
  invoke.mockReset()
})

describe('startup', () => {
  it('explains what is being asked for while the keychain is still deciding', async () => {
    // The keychain never answers - a locked Mac, or a Linux box waiting on a daemon that will
    // never reply. This is the exact case that used to render nothing at all.
    invoke.mockReturnValue(new Promise(() => {}))
    mount()

    expect(await screen.findByRole('status')).toBeInTheDocument()
    expect(screen.getByText(/Opening your encrypted database/)).toBeInTheDocument()
    expect(
      screen.getByText(/needs access to its encryption key/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/what decrypts your local database; without it your data cannot be read/),
    ).toBeInTheDocument()
    // And the app itself is not mounted against a store that is not open.
    expect(screen.queryByText('The dashboard')).not.toBeInTheDocument()
  })

  it('reaches an explanatory screen when the keychain refuses, and offers a retry', async () => {
    invoke.mockResolvedValue({
      status: 'keychain-denied',
      detail: 'The operation could not be completed',
    })
    mount()

    const panel = await screen.findByRole('alert')
    expect(panel).toHaveTextContent('The keychain request was refused')
    // What was asked for, and why it matters.
    expect(panel).toHaveTextContent(/needs access to its encryption key/)
    expect(panel).toHaveTextContent(/without it your data cannot be read/)
    // That denying changed nothing - the thing the old silent failure could never say.
    expect(panel).toHaveTextContent(/Nothing has been changed and nothing has been deleted/)
    // The platform's own words, for a bug report.
    expect(panel).toHaveTextContent('The operation could not be completed')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    // Never an instruction that would destroy the database. "Nothing has been deleted" is a
    // statement about what did not happen; "delete the database" is the advice being banned.
    expect(panel.textContent ?? '').not.toMatch(
      /(delete|remove|reset)( the| your)? (database|key)|reinstall/i,
    )
  })

  it('lets the application through when a retry succeeds', async () => {
    invoke.mockResolvedValueOnce({ status: 'keychain-denied', detail: 'refused' })
    mount()
    const retry = await screen.findByRole('button', { name: 'Retry' })

    invoke.mockResolvedValueOnce({ status: 'ready' })
    fireEvent.click(retry)

    expect(await screen.findByText('The dashboard')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('tells an absent keyring daemon apart from a refusal', async () => {
    invoke.mockResolvedValue({
      status: 'keychain-unavailable',
      detail: 'failed to connect to the D-Bus session bus',
    })
    mount()

    const panel = await screen.findByRole('alert')
    expect(panel).toHaveTextContent('No keychain answered')
    expect(panel).toHaveTextContent(/This is not a refusal/)
    // Different situation, different door: the passphrase fallback is reachable only here.
    expect(screen.getByLabelText('Database passphrase')).toBeInTheDocument()
  })

  it('does not offer a passphrase when the keychain answered and said no', async () => {
    // A passphrase there would key a second, divergent database rather than open the existing one.
    invoke.mockResolvedValue({ status: 'keychain-denied', detail: 'refused' })
    mount()

    await screen.findByRole('alert')
    expect(screen.queryByLabelText('Database passphrase')).not.toBeInTheDocument()
  })

  it('sends a typed passphrase to the command and keeps no copy of it', async () => {
    invoke.mockResolvedValue({ status: 'keychain-unavailable', detail: 'no daemon' })
    mount()

    const field = await screen.findByLabelText('Database passphrase')
    expect(field).toHaveAttribute('type', 'password')
    fireEvent.change(field, { target: { value: 'correct horse battery staple' } })

    invoke.mockResolvedValueOnce({ status: 'ready' })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))

    await waitFor(() => {
      expect(invoke).toHaveBeenLastCalledWith('startup_open_store', {
        passphrase: 'correct horse battery staple',
      })
    })
    expect(await screen.findByText('The dashboard')).toBeInTheDocument()
    // The field is cleared the moment it has been used, and the secret appears nowhere on screen.
    expect((field as HTMLInputElement).value).toBe('')
    expect(document.body.textContent ?? '').not.toContain('correct horse battery staple')
  })

  it('refuses to replace a malformed key, and says so', async () => {
    invoke.mockResolvedValue({ status: 'malformed-key' })
    mount()

    const panel = await screen.findByRole('alert')
    expect(panel).toHaveTextContent('The stored key is not a key')
    expect(panel).toHaveTextContent(/Misal will not replace it/)
    expect(panel).toHaveTextContent(/permanently unreadable/)
    // A passphrase cannot help: the database is keyed by whatever that entry used to hold.
    expect(screen.queryByLabelText('Database passphrase')).not.toBeInTheDocument()
  })

  it('says a wrong key changed nothing, and offers the passphrase that might be right', async () => {
    invoke.mockResolvedValue({ status: 'wrong-key' })
    mount()

    const panel = await screen.findByRole('alert')
    expect(panel).toHaveTextContent('That key does not open this database')
    expect(panel).toHaveTextContent(/nothing was deleted, nothing was re-keyed/)
    expect(screen.getByLabelText('Database passphrase')).toBeInTheDocument()
  })

  it('renders a screen even when the command itself rejects', async () => {
    // A command that throws is the one path with no outcome to branch on, and it is precisely the
    // path that used to end as a blank window.
    invoke.mockRejectedValue(new Error('state not managed'))
    mount()

    const panel = await screen.findByRole('alert')
    expect(panel).toHaveTextContent('Misal could not open its database')
    expect(panel).toHaveTextContent('state not managed')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('asks for nothing at all when the store opens first time', async () => {
    invoke.mockResolvedValue({ status: 'ready' })
    mount()

    expect(await screen.findByText('The dashboard')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('startup_open_store', { passphrase: null })
  })
})
