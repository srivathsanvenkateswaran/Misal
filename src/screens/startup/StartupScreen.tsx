/**
 * The startup screen — the first thing Misal shows, and for a few hundred milliseconds usually
 * the only thing.
 *
 * It exists because of a specific failure: the store used to be opened from Tauri's `setup`,
 * before any window existed. Reading the database key raises a system authorization prompt on
 * macOS and blocks on a keyring daemon on Linux, so a new user's first experience was an empty
 * window behind an unexplained password box, and denying it produced no visible outcome at all.
 *
 * Two rules follow from that, and they are the whole design of this file:
 *
 *  - **The explanation is on screen before the system prompt is.** The opening state names what
 *    is being asked for and why, so the OS dialog arrives with context already behind it rather
 *    than as an unattributed demand for a password.
 *  - **Denial and absence are different screens.** A user who clicked Deny has a working keychain
 *    and a decision to revisit. A user with no keyring daemon has nothing to approve and needs a
 *    different door — the passphrase fallback. Telling them the same thing helps neither.
 *
 * Nothing here ever suggests deleting the database, and no failure path re-keys anything: a fresh
 * key makes an existing database permanently unreadable, which is worse than not starting.
 */

import type { ReactNode } from 'react'
import { useRef } from 'react'
import type { StartupBlocked } from '../../data/startup'
import './startup.css'

/** What the key store is called on the machine the user is actually sitting at. */
function keychainName(): string {
  const agent = globalThis.navigator.userAgent
  if (agent.includes('Mac')) return 'your macOS keychain'
  if (agent.includes('Windows')) return 'Windows Credential Manager'
  return 'your system keyring'
}

function isMac(): boolean {
  return globalThis.navigator.userAgent.includes('Mac')
}

interface Words {
  readonly title: string
  /** What happened, in the user's situation rather than the platform's vocabulary. */
  readonly cause: ReactNode
  /** What to do about it. Never "reinstall", never "delete the database". */
  readonly guidance: ReactNode
  /** The platform's own sentence, kept verbatim so it can be quoted in a bug report. */
  readonly detail?: string
  /** Whether a passphrase can help here. It cannot help a refusal — see the module header. */
  readonly passphrase: boolean
}

/**
 * The sentence that has to survive every rewrite of this file: what is being asked for, and why.
 */
function Ask(): ReactNode {
  return (
    <p className="startup-body">
      Misal needs access to its encryption key in {keychainName()}. That key is what decrypts your
      local database; without it your data cannot be read.
    </p>
  )
}

function wordsFor(outcome: StartupBlocked): Words {
  switch (outcome.status) {
    case 'keychain-denied':
      return {
        title: 'The keychain request was refused',
        cause: (
          <>
            <Ask />
            <p className="startup-body">
              The request reached {keychainName()} and the answer was no — either the prompt was
              denied or it was dismissed. Nothing has been changed and nothing has been deleted:
              your database is exactly as it was.
            </p>
          </>
        ),
        guidance: (
          <>
            <p className="startup-body">
              Retry asks again, and the system prompt will reappear. Approving it lets Misal read
              its own key; it grants no access to anything else in {keychainName()}.
            </p>
            {isMac() && (
              <p className="startup-note">
                In a development build this happens often: every rebuild is a newly signed binary,
                which macOS treats as a different application, so an approval granted to the
                previous build does not carry over to this one.
              </p>
            )}
          </>
        ),
        detail: outcome.detail,
        passphrase: false,
      }

    case 'keychain-unavailable':
      return {
        title: 'No keychain answered',
        cause: (
          <>
            <Ask />
            <p className="startup-body">
              Nothing answered the request. This is not a refusal — there was no keychain there to
              refuse it. On Linux this normally means no Secret Service provider is running:
              gnome-keyring, KWallet or KeePassXC would each be one.
            </p>
          </>
        ),
        guidance: (
          <>
            <p className="startup-body">
              Start a keyring daemon and retry, or open the database with a passphrase instead. A
              passphrase keys the database directly, so it works on a machine with no keychain at
              all — but a database that was created with a keychain key cannot be opened with one.
            </p>
            <p className="startup-note">
              If there is no database on this machine yet, the passphrase you type becomes the one
              that opens it from now on. Misal cannot store it, cannot check it, and cannot recover
              it: a passphrase you cannot reproduce is a database nobody can read.
            </p>
          </>
        ),
        detail: outcome.detail,
        passphrase: true,
      }

    case 'wrong-key':
      return {
        title: 'That key does not open this database',
        cause: (
          <p className="startup-body">
            A database is already on this machine, and the key Misal was given does not decrypt it.
            The file has not been touched: nothing was deleted, nothing was re-keyed, and no
            replacement key was generated — a fresh key would make this database permanently
            unreadable.
          </p>
        ),
        guidance: (
          <p className="startup-body">
            If this database was created with a passphrase, enter it below. Otherwise the keychain
            entry Misal read is not the one this database was created with — restoring that entry,
            or the keychain it lived in, is what recovers it.
          </p>
        ),
        passphrase: true,
      }

    case 'malformed-key':
      return {
        title: 'The stored key is not a key',
        cause: (
          <p className="startup-body">
            There is an entry for Misal in {keychainName()}, but it is not 32 bytes of hexadecimal
            — so it cannot be the key this database was encrypted with.
          </p>
        ),
        guidance: (
          <p className="startup-body">
            Misal will not replace it. Writing a new key would make any existing database
            permanently unreadable, and that is a worse outcome than refusing to start. If you have
            a backup of the original entry, restore it and retry.
          </p>
        ),
        passphrase: false,
      }

    case 'failed':
      return {
        title: 'Misal could not open its database',
        cause: (
          <p className="startup-body">
            The encryption key was not the problem. Opening or migrating the database itself
            failed, and Misal has stopped rather than carry on against a store it cannot trust.
          </p>
        ),
        guidance: (
          <p className="startup-body">
            Retry is safe: nothing has been written. The message below is the underlying failure,
            verbatim.
          </p>
        ),
        detail: outcome.detail,
        passphrase: false,
      }
  }
}

/**
 * The passphrase field.
 *
 * The value is read from the DOM node at submit and handed straight to the command. It is never
 * put in React state, never held in a closure after the call, and the field is cleared the moment
 * it has been used — a passphrase in component state is a passphrase in a React DevTools tree, in
 * a state snapshot, and in every error report that serialises one.
 */
function PassphraseForm({
  busy,
  onUnlock,
}: {
  readonly busy: boolean
  readonly onUnlock: (passphrase: string) => void
}): ReactNode {
  const field = useRef<HTMLInputElement | null>(null)

  return (
    <form
      className="startup-form"
      onSubmit={(event) => {
        event.preventDefault()
        const node = field.current
        if (node === null) return
        const typed = node.value
        node.value = ''
        if (typed === '') return
        onUnlock(typed)
      }}
    >
      <label className="startup-label" htmlFor="startup-passphrase">
        Database passphrase
      </label>
      <input
        id="startup-passphrase"
        className="startup-input"
        type="password"
        ref={field}
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
      />
      <button className="btn btn-strong" type="submit" disabled={busy}>
        Unlock
      </button>
    </form>
  )
}

export function StartupScreen({
  outcome,
  busy,
  onRetry,
  onUnlock,
}: {
  /** `undefined` while the attempt is still running. */
  readonly outcome: StartupBlocked | undefined
  readonly busy: boolean
  readonly onRetry: () => void
  readonly onUnlock: (passphrase: string) => void
}): ReactNode {
  const words = outcome === undefined ? undefined : wordsFor(outcome)

  return (
    <main className="app startup">
      <div className="startup-panel">
        <span className="startup-mark">Misal</span>

        {words === undefined ? (
          <div role="status">
            <h1 className="startup-title">Opening your encrypted database</h1>
            <Ask />
            <p className="startup-body">
              Your operating system may ask you to approve this. That prompt is this request, and
              nothing else is being asked for: Misal reads one entry, its own.
            </p>
          </div>
        ) : (
          <div role="alert">
            <h1 className="startup-title">{words.title}</h1>
            {words.cause}
            {words.guidance}
            {words.detail !== undefined && words.detail !== '' && (
              <p className="startup-detail">
                <span className="startup-detail-lab">Reported by the system</span>
                {words.detail}
              </p>
            )}
            {words.passphrase && <PassphraseForm busy={busy} onUnlock={onUnlock} />}
            <div className="startup-actions">
              <button className="btn btn-strong" type="button" onClick={onRetry} disabled={busy}>
                {busy ? 'Retrying…' : 'Retry'}
              </button>
            </div>
          </div>
        )}

        <p className="startup-note">
          Everything Misal holds stays on this machine. Nothing is uploaded, and no data can be
          read — by Misal or by anything else — without the key above.
        </p>
      </div>
    </main>
  )
}
