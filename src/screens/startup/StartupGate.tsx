/**
 * The gate between "the window exists" and "the store is open".
 *
 * The rest of the application assumes an open database — every command it issues would fail
 * without one — so nothing below this component mounts until the store is open. What replaces it
 * in the meantime is a real screen with real words, not a blank frame.
 *
 * The attempt runs in an effect rather than at module load, so the frame is painted first. That
 * ordering is the fix: the keychain prompt now arrives *after* the explanation of what is asking
 * for it, instead of instead of it.
 */

import type { ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { StartupBlocked } from '../../data/startup'
import { openStore } from '../../data/startup'
import { StartupScreen } from './StartupScreen'

type Phase =
  | { readonly kind: 'opening' }
  | { readonly kind: 'blocked'; readonly outcome: StartupBlocked }
  | { readonly kind: 'ready' }

/** An unexpected rejection is still a startup outcome; it must not become a blank window. */
function asDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function StartupGate({ children }: { readonly children: ReactNode }): ReactNode {
  const [phase, setPhase] = useState<Phase>({ kind: 'opening' })

  // `passphrase` is a parameter and never anything else. It is not stored, not defaulted into
  // state, and not captured for a later retry: retrying re-asks the user rather than replaying a
  // secret the component held on to.
  const attempt = useCallback((passphrase?: string) => {
    setPhase({ kind: 'opening' })
    void openStore(passphrase).then(
      (outcome) => {
        setPhase(outcome.status === 'ready' ? { kind: 'ready' } : { kind: 'blocked', outcome })
      },
      (error: unknown) => {
        setPhase({
          kind: 'blocked',
          outcome: { status: 'failed', detail: asDetail(error) },
        })
      },
    )
  }, [])

  useEffect(() => {
    attempt()
  }, [attempt])

  if (phase.kind === 'ready') return <>{children}</>

  return (
    <StartupScreen
      outcome={phase.kind === 'blocked' ? phase.outcome : undefined}
      busy={phase.kind === 'opening'}
      onRetry={() => {
        attempt()
      }}
      onUnlock={(passphrase) => {
        attempt(passphrase)
      }}
    />
  )
}
