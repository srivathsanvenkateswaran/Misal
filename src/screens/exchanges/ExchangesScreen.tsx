/**
 * Screen 07 — Exchanges.
 *
 * The whole flow: choose an exchange, read what a key there can do *before* pasting one, connect
 * through the staging path so a refused key is never written, watch the sync, and read what it
 * could and could not see. Then the accounts already connected, with the one action that removes a
 * key from the operating system's keychain.
 *
 * The sequence this screen exists to make visible is the one in `src-tauri/src/sync.rs`: the key is
 * staged in memory, the probe signs with a handle rather than with the key, and
 * `exchange_commit_credential` is the only path to the keychain. A key that can withdraw is refused
 * before that command is ever reached, so "nothing was written" is a property of the shape of the
 * flow rather than a promise about the order things happen in — and the screen says so where the
 * key is entered rather than in a settings page nobody reads.
 *
 * What is deliberately not here:
 *
 *   - **No secret is ever React state.** Both credential fields are uncontrolled refs in
 *     `ConnectPanel`, read once at submit and cleared in the same synchronous block. What crosses
 *     into this file is a function argument that lives in one call's locals, is handed to the
 *     connect flow, and is used once more to scrub the error message before it is rendered.
 *   - **No float touches a quantity.** Coverage differences are printed as the exact decimal
 *     strings the fold produced. The only arithmetic on this screen is elapsed time, in BigInt.
 *   - **No progress claim the runner did not make.** Phase, count and detail come from `ctx.report`;
 *     the elapsed and last-update clocks are the screen's own, and are labelled as time rather than
 *     as progress.
 */

import type { ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AdapterError } from '@adapters/index'
import type { ProviderId, ScopeReport, SyncOutcome, SyncProgress } from '@adapters/index'
import type { RiskReport } from '@adapters/connect'
import { ErrorState, ScreenHead } from '../chrome'
import { ConnectPanel, type CredentialSubmission } from './ConnectPanel'
import { Connections } from './Connections'
import { providerDisclosure } from './disclosure'
import { describeSafely } from './redact'
import {
  AcknowledgementRequest,
  NoConnections,
  RefusalNotice,
  SyncProgressView,
  SyncReportView,
} from './SyncReport'
import { defaultRuntime, type ConnectionView, type ExchangeRuntime } from './runtime'
import './exchanges.css'

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'connecting'; readonly providerId: ProviderId }
  | {
      readonly kind: 'needs-ack'
      readonly providerId: ProviderId
      readonly scope: ScopeReport
      readonly risk: RiskReport
    }
  | { readonly kind: 'refused'; readonly message: string }
  | {
      readonly kind: 'syncing'
      readonly accountId: string
      readonly providerId: ProviderId
      readonly label: string
      readonly startedAt: number
      readonly updatedAt: number
      readonly progress: SyncProgress | null
    }
  | {
      readonly kind: 'synced'
      readonly accountId: string
      readonly providerId: ProviderId
      readonly label: string
      readonly outcome: SyncOutcome
    }

interface Note {
  readonly text: string
  readonly bad: boolean
}

export interface ExchangesScreenProps {
  readonly runtime?: ExchangeRuntime
  /**
   * Called after a sync commits anything.
   *
   * The shell uses it to invalidate the portfolio query. Without it a user connects an exchange,
   * watches the report say twelve balances were committed, walks to the dashboard and finds the
   * figures they had before — which reads as the sync having failed.
   */
  readonly onSynced?: () => void
  /** How often the elapsed clock redraws. A prop only so a test need not wait a second. */
  readonly tickMillis?: number
}

export function ExchangesScreen(props: ExchangesScreenProps): ReactNode {
  const runtimeRef = useRef<ExchangeRuntime | null>(props.runtime ?? null)
  runtimeRef.current ??= defaultRuntime()
  const runtime = runtimeRef.current

  const [providerId, setProviderId] = useState<ProviderId>('binance')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [connectNote, setConnectNote] = useState<Note | null>(null)
  const [listNote, setListNote] = useState<Note | null>(null)
  const [connections, setConnections] = useState<readonly ConnectionView[]>([])
  const [instrumentNames, setInstrumentNames] = useState<ReadonlyMap<string, string>>(new Map())
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null)
  // Redraws the elapsed clock. The value is never read: a sync that reports nothing for a minute
  // must still visibly be running, and a frozen clock is how a working sync gets killed.
  const [, setTick] = useState(0)

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [rows, names] = await Promise.all([
        runtime.listConnections(),
        runtime.instrumentNames(),
      ])
      setConnections(rows)
      setInstrumentNames(names)
      setLoadError(null)
    } catch (error) {
      setLoadError(describeSafely(error, []))
    }
  }, [runtime])

  useEffect(() => {
    void reload()
  }, [reload])

  const running = phase.kind === 'syncing'
  const tickMillis = props.tickMillis ?? 1000
  useEffect(() => {
    if (!running) return undefined
    const timer = setInterval(() => {
      setTick((value) => value + 1)
    }, tickMillis)
    return () => {
      clearInterval(timer)
    }
  }, [running, tickMillis])

  const startSync = useCallback(
    (accountId: string, provider: ProviderId, label: string): void => {
      const startedAt = runtime.now().getTime()
      setListNote(null)
      setBusyAccountId(accountId)
      setPhase({
        kind: 'syncing',
        accountId,
        providerId: provider,
        label,
        startedAt,
        updatedAt: startedAt,
        progress: null,
      })

      runtime
        .sync(accountId, provider, (progress) => {
          setPhase((current) =>
            current.kind === 'syncing' && current.accountId === accountId
              ? { ...current, progress, updatedAt: runtime.now().getTime() }
              : current,
          )
        })
        .then((outcome) => {
          setPhase({ kind: 'synced', accountId, providerId: provider, label, outcome })
          // Fired even when the sync failed partway: anything committed has already changed the
          // totals, and a stale dashboard would read as the sync having done nothing.
          props.onSynced?.()
          void reload()
        })
        .catch((error: unknown) => {
          setPhase({ kind: 'idle' })
          setListNote({
            text:
              `The sync of ${label} stopped: ${describeSafely(error, [])} Anything committed ` +
              'before it stopped was kept, and the next sync resumes from there.',
            bad: true,
          })
          void reload()
        })
        .finally(() => {
          setBusyAccountId(null)
        })
    },
    [runtime, reload, props.onSynced],
  )

  const onSubmit = (submission: CredentialSubmission): void => {
    const disclosure = providerDisclosure(providerId)
    const accountId = runtime.newAccountId()
    const label = submission.label === '' ? disclosure.displayName : submission.label
    // Held in this call's locals for one purpose: scrubbing them out of a failure message that an
    // exchange, a proxy or a WAF may have echoed them into. Never assigned to state, never logged,
    // and gone when this closure is.
    const entered = [submission.apiKey, submission.apiSecret]

    setConnectNote(null)
    setPhase({ kind: 'connecting', providerId })

    runtime
      .connect({
        accountId,
        providerId,
        label,
        credential: { apiKey: submission.apiKey, apiSecret: submission.apiSecret },
        acknowledgedRisk: submission.acknowledged,
      })
      .then((outcome) => {
        if (outcome.status === 'needs_acknowledgement') {
          setPhase({ kind: 'needs-ack', providerId, scope: outcome.scope, risk: outcome.risk })
          return
        }
        setConnectNote({
          text:
            `${label} is connected. The key is in this machine’s keychain and nowhere else, and ` +
            'the first sync has started below.',
          bad: false,
        })
        startSync(accountId, providerId, label)
      })
      .catch((error: unknown) => {
        const message = describeSafely(error, entered)
        if (error instanceof AdapterError && error.code === 'auth_over_scoped') {
          setPhase({ kind: 'refused', message })
          return
        }
        setPhase({ kind: 'idle' })
        setConnectNote({
          text: `${message} Nothing was stored: the key was discarded without being written.`,
          bad: true,
        })
      })
  }

  const onDisconnect = (connection: ConnectionView): void => {
    setBusyAccountId(connection.accountId)
    runtime
      .disconnect(connection.accountId)
      .then(() => {
        setListNote({
          text:
            `The key for ${connection.label} has been removed from the keychain. The balances and ` +
            'trades already synced are untouched; this account will not be contacted again.',
          bad: false,
        })
        void reload()
      })
      .catch((error: unknown) => {
        setListNote({
          text:
            `The key was NOT removed and is still in the keychain: ${describeSafely(error, [])} ` +
            'This account can still sync. Nothing was changed.',
          bad: true,
        })
      })
      .finally(() => {
        setBusyAccountId(null)
      })
  }

  const now = runtime.now().getTime()

  return (
    <>
      <ScreenHead
        title="Exchanges"
        note="Read-only by construction · the key never leaves this machine"
      />

      {loadError !== null && (
        <ErrorState
          message={`The connected accounts could not be read: ${loadError}`}
          onRetry={() => {
            void reload()
          }}
        />
      )}

      <div className="exch-screen">
        {phase.kind === 'refused' && <RefusalNotice message={phase.message} />}

        {phase.kind === 'needs-ack' && (
          <AcknowledgementRequest
            providerId={phase.providerId}
            scope={phase.scope}
            blocking={phase.risk.blocking}
            advisory={phase.risk.advisory}
          />
        )}

        {phase.kind === 'syncing' && (
          <SyncProgressView
            providerId={phase.providerId}
            label={phase.label}
            progress={phase.progress}
            elapsedMillis={now - phase.startedAt}
            sinceUpdateMillis={now - phase.updatedAt}
          />
        )}

        {phase.kind === 'synced' && (
          <SyncReportView
            providerId={phase.providerId}
            outcome={phase.outcome}
            instrumentNames={instrumentNames}
            onSyncAgain={() => {
              startSync(phase.accountId, phase.providerId, phase.label)
            }}
          />
        )}

        {connections.length === 0 ? (
          <NoConnections />
        ) : (
          <Connections
            connections={connections}
            busyAccountId={busyAccountId}
            note={listNote}
            onSync={(connection) => {
              startSync(connection.accountId, connection.providerId, connection.label)
            }}
            onDisconnect={onDisconnect}
          />
        )}

        {connections.length === 0 && listNote !== null && (
          <p
            className={listNote.bad ? 'exch-note exch-note-bad' : 'exch-note'}
            role={listNote.bad ? 'alert' : 'status'}
          >
            {listNote.text}
          </p>
        )}

        <ConnectPanel
          providerId={providerId}
          onProvider={(next) => {
            setProviderId(next)
            setConnectNote(null)
            setPhase((current) =>
              current.kind === 'refused' || current.kind === 'needs-ack'
                ? { kind: 'idle' }
                : current,
            )
          }}
          onSubmit={onSubmit}
          busy={phase.kind === 'connecting' || phase.kind === 'syncing'}
          note={connectNote}
        />
      </div>
    </>
  )
}
