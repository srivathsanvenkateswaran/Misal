/**
 * Screen 07 — Refresh.
 *
 * `src/data/refresh.ts` has been able to fetch prices and exchange rates for some time; until now
 * nothing in the application called it, so the only prices a user could have were the ones a
 * statement carried or one they typed themselves. This screen is the door to it, and it is
 * deliberately a *screen* rather than a button in the app bar: a refresh is a network operation
 * over a few hundred instruments that partly succeeds, and partial success needs somewhere to be
 * read.
 *
 * Nothing here is a new visual idea. The panel, the label, the badge, the button, the `.dq` counter
 * strip and the plain data table are the ones the other six screens use; this file only arranges
 * them. Four rules govern the arrangement.
 *
 * **What is stale is stated before anything is fetched.** The user should be able to decide whether
 * a refresh is worth it, and — more importantly — should see the population no provider covers,
 * because no amount of refreshing will ever price those. Their only route to a value is a manual
 * price, and this screen says so and points at it.
 *
 * **Progress is observed, not estimated.** The counter below moves when a request actually returns,
 * because the fetcher the orchestrator uses is wrapped on the way in. There is no percentage: a
 * denominator would have to be guessed from each provider's private batching, and a bar that
 * advances by invention is worse than a count that advances by fact.
 *
 * **Every instrument is accounted for.** Refreshed, unchanged, failed with the provider's reason,
 * or held because a manual price of yours covers that day. `save_prices` returns `heldByManual`
 * precisely so this can be said out loud rather than swallowed.
 *
 * **The TTL gate has a documented escape hatch.** The orchestrator stamps the cache lifetime even
 * when every fetch failed — which is right, because hammering a provider that is refusing us earns
 * a longer block — but it means someone who tried while offline is locked out of retrying for six
 * hours after coming back. The override is that person's way out, and it is a deliberate tick
 * rather than a hidden default.
 */

import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { DateTime } from 'luxon'
import { CURRENCY_SYMBOL } from '@ui/index'
import { ASSET_CLASS_LABEL, SERIES_BY_ASSET_CLASS } from '@ui/metrics'
import { loadPortfolioRows } from '../../data/client'
import type { PortfolioRows } from '../../data/client'
import { marketDataFetcher, refreshPrices } from '../../data/refresh'
import type { FxOutcome, MarketDataFetcher, RefreshNote } from '../../data/refresh'
import type { Invoker } from '../../data/import'
import { loadSettings } from '../../data/settings'
import type { NetworkDestination } from '../../data/settings'
import { Badge, ClassDot, EmptyState, ErrorState, Panel, ScreenHead } from '../chrome'
import { formatDate, formatDateTime } from '../view-model'
import {
  STATUS_LABEL,
  buildPlan,
  buildReport,
  countByStatus,
} from './plan'
import type { PlanRow, RefreshPlan, RefreshRun, ReportRow, ReportStatus, SavedPriceRow } from './plan'
import './refresh.css'

const IST = 'Asia/Kolkata'

/** What the panel has seen of a run in flight. Both fields are facts, not estimates. */
export interface RefreshProgress {
  /** Market-data requests that have returned, successfully or not. */
  readonly requests: number
  /** The host of the request currently in flight, or the last one attempted. */
  readonly host: string | null
}

export interface RefreshRequest {
  readonly rows: PortfolioRows
  /** Ignore the cache lifetime. Only ever true because the user ticked the box. */
  readonly force: boolean
  readonly signal: AbortSignal
  readonly onProgress: (progress: RefreshProgress) => void
}

export interface NetworkStatement {
  readonly destinations: readonly NetworkDestination[]
  /** Whether any provider key is stored, which decides whether a keyed host is ever reached. */
  readonly keyStored: boolean
}

/** Everything this screen does to the outside world, in one place so a test can stand in for it. */
export interface RefreshRuntime {
  loadRows: () => Promise<PortfolioRows>
  loadNetwork: () => Promise<NetworkStatement>
  run: (request: RefreshRequest) => Promise<RefreshRun>
  /** The clock the plan is judged against. Injected so a test is not at the mercy of the date. */
  now: () => string
}

const tauriCall: Invoker = (command, args) => invoke(command, args)

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

interface SaveOutcome {
  readonly written: number
  readonly heldByManual: readonly string[]
  readonly unknown: readonly string[]
}

/**
 * Run the orchestrator, watching the two seams it already has.
 *
 * Neither the fetcher nor the invoker is reimplemented here: both are the real ones, wrapped. What
 * the wrapper adds is observation — a request count for the progress line, and the rows that
 * crossed into `save_prices` together with what the write refused, which is what makes a
 * per-instrument account possible without changing the orchestrator's shape.
 */
async function runRefresh(request: RefreshRequest, call: Invoker): Promise<RefreshRun> {
  const saved: SavedPriceRow[] = []
  const heldByManual: string[] = []
  const unknown: string[] = []
  let requests = 0

  const recording: Invoker = async <T,>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> => {
    const result = await call<T>(command, args)
    if (command === 'save_prices') {
      saved.push(...((args?.rows ?? []) as readonly SavedPriceRow[]))
      const outcome = result as unknown as SaveOutcome
      heldByManual.push(...outcome.heldByManual)
      unknown.push(...outcome.unknown)
    }
    return result
  }

  const transport = marketDataFetcher(call)
  const fetcher: MarketDataFetcher = async (url, signal) => {
    const host = hostOf(url)
    request.onProgress({ requests, host })
    try {
      return await transport(url, signal)
    } finally {
      requests += 1
      request.onProgress({ requests, host })
    }
  }

  const outcome = await refreshPrices({
    rows: request.rows,
    call: recording,
    fetcher,
    signal: request.signal,
    force: request.force,
    // Keyless by construction. Misal has no command that reads a provider key back out of the
    // keychain — deliberately, since a key that can be read is a key that can leak into a log or a
    // devtools snapshot — so a screen cannot hand one to Twelve Data. See the note in the panel.
    credentials: null,
  })

  return { outcome, saved, heldByManual, unknown, cancelled: request.signal.aborted }
}

function defaultRuntime(): RefreshRuntime {
  return {
    loadRows: () => loadPortfolioRows(),
    loadNetwork: async () => {
      const snapshot = await loadSettings()
      return {
        destinations: snapshot.network,
        keyStored: snapshot.providers.some((provider) => provider.status === 'present'),
      }
    },
    run: (request) => runRefresh(request, tauriCall),
    now: () => DateTime.now().setZone(IST).toISO() ?? new Date().toISOString(),
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly progress: RefreshProgress }
  | { readonly kind: 'done'; readonly run: RefreshRun; readonly report: readonly ReportRow[] }
  | { readonly kind: 'error'; readonly message: string }

export interface RefreshPanelProps {
  readonly runtime?: RefreshRuntime
  /**
   * Called after a run that reached the database.
   *
   * The shell uses it to invalidate the portfolio query. Without it a user refreshes, reads that
   * forty prices were stored, walks to the dashboard and finds the same stale figures — which
   * reads as the refresh having done nothing.
   */
  readonly onRefreshed?: () => void
}

export function RefreshPanel(props: RefreshPanelProps): ReactNode {
  const runtimeRef = useRef<RefreshRuntime | null>(props.runtime ?? null)
  runtimeRef.current ??= defaultRuntime()
  const runtime = runtimeRef.current

  const [rows, setRows] = useState<PortfolioRows | null>(null)
  const [readAt, setReadAt] = useState<string | null>(null)
  const [network, setNetwork] = useState<NetworkStatement | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [override, setOverride] = useState(false)
  const controller = useRef<AbortController | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [nextRows, nextNetwork] = await Promise.all([runtime.loadRows(), runtime.loadNetwork()])
      setRows(nextRows)
      setReadAt(runtime.now())
      setNetwork(nextNetwork)
      setLoadError(null)
    } catch (error) {
      setLoadError(describe(error))
    }
  }, [runtime])

  useEffect(() => {
    void reload()
  }, [reload])

  const plan = useMemo<RefreshPlan | Error | null>(() => {
    if (rows === null || readAt === null) return null
    try {
      return buildPlan(rows, readAt)
    } catch (error) {
      return error instanceof Error ? error : new Error(describe(error))
    }
  }, [rows, readAt])

  const start = (): void => {
    if (rows === null || plan === null || plan instanceof Error) return
    const abort = new AbortController()
    controller.current = abort
    const before = rows
    setPhase({ kind: 'running', progress: { requests: 0, host: null } })

    runtime
      .run({
        rows: before,
        force: override,
        signal: abort.signal,
        onProgress: (progress) => {
          setPhase((current) => (current.kind === 'running' ? { kind: 'running', progress } : current))
        },
      })
      .then(async (run) => {
        // Against the rows as they were before the run: comparing a written price with itself
        // would report every refresh as unchanged.
        setPhase({ kind: 'done', run, report: buildReport(plan, run, before.prices) })
        if (run.outcome.status === 'ran') props.onRefreshed?.()
        await reload()
      })
      .catch((error: unknown) => {
        setPhase({ kind: 'error', message: describe(error) })
      })
      .finally(() => {
        controller.current = null
      })
  }

  const running = phase.kind === 'running'

  return (
    <>
      <ScreenHead
        title="Refresh"
        note="Prices and exchange rates · fetched only when you ask, and only from the hosts listed below"
      />

      {loadError !== null && (
        <ErrorState
          message={`The portfolio could not be read, so there is nothing to plan a refresh against: ${loadError}`}
          onRetry={() => {
            void reload()
          }}
        />
      )}

      {plan instanceof Error && (
        <ErrorState
          message={`The stored rows could not be read as instruments, so no refresh is offered rather than one that would skip them silently: ${plan.message}`}
          onRetry={() => {
            void reload()
          }}
        />
      )}

      {plan === null || plan instanceof Error ? (
        loadError === null && (
          <EmptyState headline="Reading the local database…">
            Prices, instruments and settings are read together, so the screen never reports on half a
            state.
          </EmptyState>
        )
      ) : (
        <div className="rf-screen">
          <BeforeAnything
            plan={plan}
            phase={phase}
            override={override}
            onOverride={setOverride}
            onStart={start}
            onCancel={() => {
              controller.current?.abort()
            }}
          />

          {phase.kind === 'error' && (
            <ErrorState
              message={`The refresh could not be completed: ${phase.message} Anything already written was written; nothing was rolled back and no price was invented.`}
            />
          )}

          {phase.kind === 'done' && <WhatHappened run={phase.run} report={phase.report} />}

          <Uncovered rows={plan.uncovered} />
          <Stale plan={plan} />
          <WhatLeaves network={network} running={running} />
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Before anything is fetched
// ---------------------------------------------------------------------------

function BeforeAnything({
  plan,
  phase,
  override,
  onOverride,
  onStart,
  onCancel,
}: {
  readonly plan: RefreshPlan
  readonly phase: Phase
  readonly override: boolean
  readonly onOverride: (next: boolean) => void
  readonly onStart: () => void
  readonly onCancel: () => void
}): ReactNode {
  const running = phase.kind === 'running'
  const blocked = !plan.gate.eligible && !override

  return (
    <Panel
      title="What a refresh would do"
      meta={`${plan.targets.length.toString()} of ${plan.rows.length.toString()} instruments would be asked about`}
      className="rf-panel"
      foot={
        <>
          Freshness is judged per asset class against each instrument&rsquo;s own publication
          cadence — a NAV four hours old is fresh and a Bitcoin price four hours old is not — using
          the same function the price service consults when it decides what to fetch. A stale price
          is never blanked or replaced by an estimate: it stays, labelled, until a real one arrives.
        </>
      }
    >
      <div className="panel-body">
        <div className="dq rf-counts">
          <div className="dq-cell">
            <span className="lab">Never priced</span>
            <div className="dq-n">{plan.neverPriced.length}</div>
            <div className="cell-note">
              A provider covers these, but no price has ever been stored, so they are held out of
              every total.
            </div>
          </div>
          <div className="dq-cell">
            <span className="lab">Past their cadence</span>
            <div className="dq-n">{plan.stalePriced.length}</div>
            <div className="cell-note">
              Priced, but older than the publication rhythm of their asset class.
            </div>
          </div>
          <div className="dq-cell">
            <span className="lab">No provider at all</span>
            <div className="dq-n">{plan.uncovered.length}</div>
            <div className="cell-note">
              No refresh will ever price these. A manual price is the only route to a value.
            </div>
          </div>
          <div className="dq-cell">
            <span className="lab">Fresh</span>
            <div className="dq-n">{plan.fresh.length}</div>
            <div className="cell-note">Current for their asset class, so they are not asked about.</div>
          </div>
        </div>

        <div className="rf-gate">
          <span className="lab">Cache lifetime</span>
          <p className="rf-line">
            {plan.lastRefreshAt === null || plan.lastRefreshAt === '' ? (
              <>Nothing has been refreshed on this machine yet.</>
            ) : (
              <>
                Last refreshed <b>{formatDateTime(plan.lastRefreshAt)}</b>.
              </>
            )}{' '}
            The stored cache lifetime is <b>{plan.ttlMinutes} minutes</b>, which is what stops six
            clicks becoming six rounds of provider calls.{' '}
            {plan.gate.eligible ? (
              <>A refresh is due now.</>
            ) : (
              <>
                The next one is due <b>{formatDateTime(plan.gate.nextEligibleAt ?? '')}</b>.
              </>
            )}{' '}
            <a className="linkish" href="#/settings">
              Change it in Settings
            </a>
            .
          </p>

          <label className="rf-override">
            <input
              type="checkbox"
              checked={override}
              disabled={running}
              onChange={(event) => {
                onOverride(event.target.checked)
              }}
            />
            <span>
              <b>Ignore the cache lifetime and refresh anyway.</b>
              <span className="sublab">
                The lifetime is stamped even when every fetch fails, on purpose: a provider that is
                refusing us should not be hammered. The cost is that a refresh attempted with no
                connection locks the next one out for the full window, so this tick is how someone
                who has just come back online gets to try again.
              </span>
            </span>
          </label>
        </div>

        <div className="rf-actions">
          <button className="btn btn-strong" type="button" onClick={onStart} disabled={running || blocked}>
            {running ? 'Refreshing…' : 'Refresh prices and rates'}
          </button>
          {running && (
            <button className="btn" type="button" onClick={onCancel}>
              Stop
            </button>
          )}
          <span className="rf-note">
            {blocked
              ? 'Held by the cache lifetime. Tick the box above to refresh anyway.'
              : `${plan.targets.length.toString()} instruments and ${plan.foreign.length.toString()} exchange rates would be requested.`}
          </span>
        </div>

        <p className="rf-status" role="status">
          {phase.kind === 'running' ? (
            <>
              {phase.progress.host === null
                ? 'Starting…'
                : `Contacting ${phase.progress.host}. `}
              {phase.progress.requests.toString()} requests have come back. Yahoo is asked one
              instrument at a time and paces itself between requests, so a few hundred holdings take
              minutes rather than seconds. Stopping is safe: it stops before the next request, and
              anything already stored stays stored.
            </>
          ) : (
            <>
              Nothing is contacted until this button is pressed, and nothing is scheduled. Mutual
              fund NAVs come from AMFI&rsquo;s official file, crypto from CoinGecko and equities and
              the USD rate from Yahoo — all keyless. A stored Twelve Data key cannot be used from
              here: Misal has no command that reads a key back out of the keychain, which is what
              keeps a key from reaching a log or a crash report.
            </>
          )}
        </p>
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// The population no provider covers
// ---------------------------------------------------------------------------

function Uncovered({ rows }: { readonly rows: readonly PlanRow[] }): ReactNode {
  const unpriced = rows.filter((row) => !row.manuallyPriced)

  return (
    <Panel
      title="No provider covers these"
      meta={rows.length === 0 ? 'none' : `${rows.length.toString()} instruments`}
      className="rf-panel"
      foot="Coverage is asked of the providers themselves — AMFI recognises a fund by ISIN or scheme code, CoinGecko by a resolved coin id, Yahoo by an NSE, BSE or US ticker. An instrument none of them can name is not a bug in the refresh; it is an instrument with no public feed, or one whose alias was never resolved at import."
    >
      <div className="panel-body">
        {rows.length === 0 ? (
          <EmptyState headline="Every instrument has a provider">
            Each one can be asked about. Nothing here depends on a price typed by hand.
          </EmptyState>
        ) : (
          <>
            <p className="rf-lede">
              These are the real cost of a keyless build. Twelve Data&rsquo;s free plan does not
              include Indian exchanges at all, so a free-tier user gets US equities and crypto but no
              automatic price for an Indian equity Yahoo cannot name; a fund whose registrar prints
              no code, physical gold and an unlisted share have no feed at any price.{' '}
              <b>A refresh will never value these, however many times it is run.</b> A manual price
              is the supported route, not a workaround: it outranks anything a refresh fetches for
              the same day, and a refresh has no way to overwrite it.{' '}
              <a className="linkish" href="#/settings">
                Set a manual price in Settings
              </a>
              .
            </p>
            <p className="rf-note">
              {unpriced.length === 0
                ? 'Every one of them already has a manual price, so none is missing from your totals.'
                : `${unpriced.length.toString()} of them have no price at all, so their value is withheld from every total rather than estimated.`}
            </p>
            <table className="dtable rf-table">
              <caption className="vh">Instruments no price provider covers</caption>
              <thead>
                <tr>
                  <th scope="col">Instrument</th>
                  <th scope="col">Asset class</th>
                  <th scope="col">Stored price</th>
                  <th scope="col">Route to a value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.instrumentId}>
                    <th scope="row">{row.displayName}</th>
                    <td>
                      <span className="inst">
                        <ClassDot series={SERIES_BY_ASSET_CLASS[row.assetClass]} />
                        {ASSET_CLASS_LABEL[row.assetClass]}
                      </span>
                    </td>
                    <td>
                      {row.asOf === null ? (
                        <span className="muted">none</span>
                      ) : (
                        <>
                          {formatDate(row.asOf)}
                          <span className="acct-prov">
                            {row.source ?? 'unknown'} · {ageText(row.ageDays)}
                          </span>
                        </>
                      )}
                    </td>
                    <td>
                      {row.manuallyPriced ? (
                        <Badge tone="ok">Manual price set</Badge>
                      ) : (
                        <Badge tone="crit">Needs a manual price</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// What is stale
// ---------------------------------------------------------------------------

const FRESHNESS_BADGE: Record<PlanRow['freshness'], { label: string; tone: 'ok' | 'warn' | 'crit' }> =
  {
    fresh: { label: 'Fresh', tone: 'ok' },
    stale: { label: 'Stale', tone: 'warn' },
    very_stale: { label: 'Very stale', tone: 'crit' },
    never_priced: { label: 'Never priced', tone: 'crit' },
  }

function ageText(ageDays: number | null): string {
  if (ageDays === null) return 'no stored price'
  return `${ageDays.toString()} d old`
}

function Stale({ plan }: { readonly plan: RefreshPlan }): ReactNode {
  return (
    <Panel
      title="What would be asked about"
      meta={
        plan.load.length === 0
          ? 'nothing to ask'
          : plan.load
              .map((entry) => `${entry.providerId} ${entry.instruments.toString()}`)
              .join(' · ')
      }
      className="rf-panel"
      foot="One request per instrument for Yahoo, one request for the whole batch for CoinGecko, and one file covering every scheme for AMFI. An instrument is asked about only when its stored price is past its cadence or absent — refreshing what is already current would spend somebody else's rate limit to learn nothing."
    >
      <div className="panel-body">
        {plan.targets.length === 0 ? (
          <EmptyState headline="Nothing is stale">
            Every instrument a provider covers has a current price for its asset class. A refresh
            would make no requests at all.
          </EmptyState>
        ) : (
          <table className="dtable rf-table">
            <caption className="vh">Instruments whose price would be re-fetched</caption>
            <thead>
              <tr>
                <th scope="col">Instrument</th>
                <th scope="col">Asset class</th>
                <th scope="col">Provider</th>
                <th scope="col">Stored price</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {plan.targets.map((row) => (
                <tr key={row.instrumentId}>
                  <th scope="row">{row.displayName}</th>
                  <td>
                    <span className="inst">
                      <ClassDot series={SERIES_BY_ASSET_CLASS[row.assetClass]} />
                      {ASSET_CLASS_LABEL[row.assetClass]}
                    </span>
                  </td>
                  <td>{row.providerId}</td>
                  <td>
                    {row.asOf === null ? (
                      <span className="muted">never fetched</span>
                    ) : (
                      <>
                        {formatDate(row.asOf)}
                        <span className="acct-prov">
                          {row.source ?? 'unknown'} · {ageText(row.ageDays)}
                        </span>
                      </>
                    )}
                  </td>
                  <td>
                    <Badge tone={FRESHNESS_BADGE[row.freshness].tone}>
                      {FRESHNESS_BADGE[row.freshness].label}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// What happened
// ---------------------------------------------------------------------------

const STATUS_TONE: Record<ReportStatus, 'ok' | 'warn' | 'crit' | 'neutral'> = {
  refreshed: 'ok',
  unchanged: 'neutral',
  held: 'warn',
  failed: 'crit',
  no_result: 'warn',
}

function priceText(close: string, currency: string): string {
  const symbol = currency === 'INR' || currency === 'USD' ? CURRENCY_SYMBOL[currency] : `${currency} `
  return `${symbol}${close}`
}

function WhatHappened({
  run,
  report,
}: {
  readonly run: RefreshRun
  readonly report: readonly ReportRow[]
}): ReactNode {
  const outcome = run.outcome
  const counts = countByStatus(report)

  if (outcome.status === 'skipped_by_ttl') {
    return (
      <Panel title="Nothing was fetched" className="rf-panel">
        <div className="panel-body">
          <p className="rf-status" role="status">
            The cache lifetime has not elapsed, so no request was made and nothing was changed. The
            next refresh is due{' '}
            <b>{formatDateTime(outcome.nextEligibleAt ?? '')}</b>. Tick the override above to run
            anyway.
          </p>
        </div>
      </Panel>
    )
  }

  return (
    <Panel
      title="What happened"
      meta={`${outcome.pricesWritten.toString()} prices and ${outcome.fxWritten.toString()} rates written`}
      className="rf-panel"
      foot="Only prices that came back are written, and a manual price is never overwritten. A failure costs you nothing beyond the attempt: the price already stored stays exactly as it was, still labelled with its own age."
    >
      <div className="panel-body">
        <p className="rf-status" role="status">
          {run.cancelled ? (
            <>
              <b>Stopped.</b> Everything fetched before you stopped it was stored; everything after
              is reported as unreachable, because the run ended before it was asked.{' '}
            </>
          ) : (
            <>
              <b>Finished.</b>{' '}
            </>
          )}
          {counts.refreshed.toString()} refreshed, {counts.unchanged.toString()} unchanged,{' '}
          {counts.held.toString()} held by a manual price, {counts.failed.toString()} failed.
          Partial success is the ordinary outcome here — a provider that is down for one asset class
          does not cost you the other four.
          {outcome.rateLimited && (
            <>
              {' '}
              A provider rate-limited us, so the batch stopped rather than retrying into a longer
              block.
            </>
          )}
        </p>

        {outcome.notes.length > 0 && <Notes notes={outcome.notes} />}

        <table className="dtable rf-table">
          <caption className="vh">What happened to each instrument</caption>
          <thead>
            <tr>
              <th scope="col">Instrument</th>
              <th scope="col">Outcome</th>
              <th scope="col">Price stored</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {report.map((row) => (
              <tr key={row.instrumentId}>
                <th scope="row">{row.displayName}</th>
                <td>
                  <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
                </td>
                <td>
                  {row.close === null || row.currency === null ? (
                    <span className="muted">nothing written</span>
                  ) : (
                    <>
                      {priceText(row.close, row.currency)}
                      <span className="acct-prov">
                        {row.source ?? 'unknown'} · as of {row.asOf ?? 'unknown'}
                      </span>
                    </>
                  )}
                </td>
                <td>{row.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <FxReport fx={outcome.fx} />
      </div>
    </Panel>
  )
}

function Notes({ notes }: { readonly notes: readonly RefreshNote[] }): ReactNode {
  return (
    <ul className="rf-notes">
      {notes.map((note) => (
        <li key={`${note.code} ${note.message}`}>
          <span className="lab">{note.code.replaceAll('_', ' ').toLowerCase()}</span>
          <p className="rf-line">{note.message}</p>
          <p className="rf-subjects">{note.subjects.join(' · ')}</p>
        </li>
      ))}
    </ul>
  )
}

function FxReport({ fx }: { readonly fx: readonly FxOutcome[] }): ReactNode {
  if (fx.length === 0) {
    return (
      <p className="rf-note">
        No exchange rate was needed: everything held is already in the base currency.
      </p>
    )
  }
  return (
    <>
      <table className="dtable rf-table">
        <caption className="vh">Exchange rates fetched</caption>
        <thead>
          <tr>
            <th scope="col">Pair</th>
            <th scope="col">Rate</th>
            <th scope="col">As of</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {fx.map((row) => (
            <tr key={`${row.base}/${row.quote}`}>
              <th scope="row">
                {row.base}/{row.quote}
              </th>
              <td>{row.rate ?? <span className="muted">none</span>}</td>
              <td>{row.asOf === null ? <span className="muted">—</span> : formatDate(row.asOf)}</td>
              <td>
                {row.ok ? (
                  <Badge tone="ok">Stored</Badge>
                ) : (
                  <Badge tone="crit">Not available</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="rf-note">
        A missing rate does not make a foreign holding unpriced — it makes it absent from net worth
        entirely, because the engine refuses to convert at a guessed rate. That is why a failure here
        is reported at the same volume as a failed price.
      </p>
    </>
  )
}

// ---------------------------------------------------------------------------
// What leaves this machine
// ---------------------------------------------------------------------------

function WhatLeaves({
  network,
  running,
}: {
  readonly network: NetworkStatement | null
  readonly running: boolean
}): ReactNode {
  return (
    <Panel
      title="Where a refresh sends its requests"
      meta={network === null ? 'reading the allowlist…' : `${network.destinations.length.toString()} hosts`}
      className="rf-panel"
      foot="This table is generated from MARKET_DATA_HOSTS — the allowlist the socket layer checks every request against — rather than written as copy, so it cannot describe a version of Misal that no longer exists. A request to any other host is refused before a socket is opened, and a redirect is refused rather than followed, because following one would leave the allowlist behind on the second hop."
    >
      <div className="panel-body">
        {network === null ? (
          <EmptyState headline="Reading the allowlist…">
            The list of hosts is read from the core rather than written here, so it is not shown
            until it has been read.
          </EmptyState>
        ) : (
          <>
            <p className="rf-lede">
              A refresh is the only thing in Misal that opens a connection on your behalf, and it
              reaches exactly these hosts.{' '}
              {running ? 'It is running now.' : 'It is not running.'} There is no account, no
              sign-in, no telemetry and nothing on a schedule; what is sent is a symbol, never a
              holding, a quantity or a total.
            </p>
            <table className="dtable rf-table">
              <caption className="vh">Hosts a refresh may contact, and what each request contains</caption>
              <thead>
                <tr>
                  <th scope="col">Host</th>
                  <th scope="col">Path</th>
                  <th scope="col">Why</th>
                  <th scope="col">What is sent</th>
                </tr>
              </thead>
              <tbody>
                {network.destinations.map((destination) => (
                  <tr key={destination.host}>
                    <th scope="row">
                      {destination.host}
                      {destination.requiresKey && (
                        <span className="acct-prov">
                          {network.keyStored
                            ? 'key stored — but a refresh started here cannot read it'
                            : 'never contacted — no key'}
                        </span>
                      )}
                    </th>
                    <td className="rf-mono">{destination.pathPrefix}</td>
                    <td>{destination.purpose}</td>
                    <td>{destination.sends}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </Panel>
  )
}
