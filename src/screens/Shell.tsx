/**
 * The shell: the app frame, the router and the four data states.
 *
 * The order of the checks below is the product's argument in miniature:
 *
 *   error   → the panel head persists and the failure is named, never swallowed.
 *   loading → a layout-preserving skeleton. Never a spinner and never a fake numeral: a plausible
 *             digit shown while loading is a lie told in the moment it is most believed.
 *   empty   → `<FirstRun/>` *instead of* the dashboard, not a dashboard of zeros.
 *   ready   → the screens.
 */

import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AppBar, ErrorState } from './chrome'
import { PORTFOLIO_QUERY_PREFIX, usePortfolio, useStorageStatus } from './queries'
import type { Route } from './route'
import { NAV, hrefFor, useRoute } from './route'
import { Dashboard } from './Dashboard'
import { Holdings } from './Holdings'
import { Accounts } from './Accounts'
import { InstrumentDetail, InstrumentIndex } from './Instruments'
import { FirstRun } from './FirstRun'
import { ImportScreen } from './import'
import { Settings } from './settings'
import { RefreshPanel } from './refresh'
import { ExchangesScreen } from './exchanges'
import type { PortfolioData } from './view-model'
import './screens.css'

/** `Cmd/Ctrl + 1…4` jump to the four screens (spec §11.1). */
function useScreenShortcuts(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.metaKey && !event.ctrlKey) return
      // Derived from NAV rather than a fixed list, so adding a screen does not silently leave it
      // without a shortcut. Position in the digit string rather than a parse: nothing here is
      // numeric, and reaching for a parser is how a number gets into code that has no business
      // holding one.
      const index = '123456789'.indexOf(event.key)
      if (index === -1 || index >= NAV.length) return
      const item = NAV[index]
      if (item === undefined) return
      event.preventDefault()
      globalThis.location.hash = item.href
    }
    globalThis.addEventListener('keydown', onKey)
    return () => {
      globalThis.removeEventListener('keydown', onKey)
    }
  }, [])
}

function Skeleton(): ReactNode {
  return (
    <div className="pad" aria-busy="true">
      <span className="skel" style={{ height: '156px', marginBottom: '14px' }} aria-hidden="true" />
      <span className="skel" style={{ height: '180px', marginBottom: '14px' }} aria-hidden="true" />
      <span className="skel" style={{ height: '268px' }} aria-hidden="true" />
      <p className="emptystate">Reading the local database and valuing the portfolio…</p>
    </div>
  )
}

/**
 * Routes that must work whatever state the portfolio is in.
 *
 * Each is a way to change the data or the configuration, which makes them the only exits from an
 * unvaluable portfolio - and the only screens a user with no accounts can usefully open.
 */
type ActionRoute = Extract<Route, { kind: 'import' | 'settings' | 'refresh' | 'exchanges' }>

function isActionRoute(route: Route): route is ActionRoute {
  return (
    route.kind === 'import' ||
    route.kind === 'settings' ||
    route.kind === 'refresh' ||
    route.kind === 'exchanges'
  )
}

/** The action routes, which take no portfolio data and so cannot be blocked by a valuation error. */
function ActionScreen({ route }: { readonly route: ActionRoute }): ReactNode {
  // Exhaustive with no default: the type guard above is what proves only these four arrive, so
  // adding a fifth action route fails to compile until it is handled here.
  switch (route.kind) {
    case 'import':
      return <ImportRoute />
    case 'settings':
      return <SettingsRoute />
    case 'refresh':
      return <RefreshRoute />
    case 'exchanges':
      return <ExchangesRoute />
  }
}

function Screen({ data }: { readonly data: PortfolioData }): ReactNode {
  const route = useRoute()
  switch (route.kind) {
    case 'dashboard':
      return <Dashboard data={data} />
    case 'holdings':
      return <Holdings data={data} group={route.group} />
    case 'accounts':
      return <Accounts data={data} />
    case 'instruments':
      return <InstrumentIndex data={data} />
    case 'instrument':
      return <InstrumentDetail data={data} instrumentId={route.instrumentId} />
    case 'import':
      return <ImportRoute />
    case 'settings':
      return <SettingsRoute />
    case 'refresh':
      return <RefreshRoute />
    case 'exchanges':
      return <ExchangesRoute />
  }
}

/**
 * Refreshing prices changes every valued figure, so the cached valuation goes.
 */
function RefreshRoute(): ReactNode {
  const client = useQueryClient()
  return (
    <RefreshPanel
      onRefreshed={() => {
        void client.invalidateQueries({ queryKey: [PORTFOLIO_QUERY_PREFIX] })
      }}
    />
  )
}

/**
 * Connecting or syncing an exchange writes transactions and positions.
 */
function ExchangesRoute(): ReactNode {
  const client = useQueryClient()
  return (
    <ExchangesScreen
      onSynced={() => {
        void client.invalidateQueries({ queryKey: [PORTFOLIO_QUERY_PREFIX] })
      }}
    />
  )
}

/**
 * Settings, with the portfolio refreshed after a change.
 *
 * A manual price or a changed base currency alters what every figure on the dashboard means, so
 * the cached valuation has to go.
 */
function SettingsRoute(): ReactNode {
  const client = useQueryClient()
  return (
    <Settings
      onChanged={() => {
        void client.invalidateQueries({ queryKey: [PORTFOLIO_QUERY_PREFIX] })
      }}
    />
  )
}

/**
 * Import, with the portfolio refreshed once it finishes.
 *
 * Without the invalidation a user imports a statement, watches the review report rows committed,
 * navigates to the dashboard and sees the numbers they had before - which reads as the import
 * having failed. The query is configured `staleTime: Infinity`, so nothing refetches on its own.
 */
function ImportRoute(): ReactNode {
  const client = useQueryClient()
  return (
    <ImportScreen
      onImported={() => {
        // Prefix match, so every cached asOf is invalidated, not just today's.
        void client.invalidateQueries({ queryKey: [PORTFOLIO_QUERY_PREFIX] })
      }}
    />
  )
}

export function Shell({ asOf }: { readonly asOf: string }): ReactNode {
  const route = useRoute()
  const storage = useStorageStatus()
  const portfolio = usePortfolio(asOf)
  useScreenShortcuts()

  const view = portfolio.data

  return (
    <main className="app">
      <AppBar route={route} status={storage.data} statusError={storage.isError} />

      {portfolio.isError ? (
        <ErrorState
          message={`The portfolio could not be read from the local database. ${
            portfolio.error instanceof Error ? portfolio.error.message : String(portfolio.error)
          }`}
          onRetry={() => {
            void portfolio.refetch()
          }}
        />
      ) : view === undefined ? (
        <Skeleton />
      ) : isActionRoute(route) ? (
        // Deliberately ahead of the !view.ok test below.
        //
        // These four are the only ways out of a broken state: import more data, change a setting,
        // refresh a price, disconnect an exchange. Gating them behind a successful valuation means
        // one unvaluable row locks the user out of every screen that could fix it, and the only
        // remaining recovery is deleting the encrypted database along with every statement ever
        // imported. A valuation failure must never be able to take the repair tools with it.
        <ActionScreen route={route} />
      ) : !view.ok ? (
        <ErrorState
          message={`The portfolio could not be valued, so no figure is shown rather than a wrong one. ${view.message}`}
          onRetry={() => {
            void portfolio.refetch()
          }}
        />
      ) : view.data.accounts.length === 0 ? (
        <FirstRun status={storage.data} />
      ) : (
        <Screen data={view.data} />
      )}

      {view !== undefined && view.ok && view.data.warnings.length > 0 && (
        <details className="foot">
          <summary>
            {view.data.warnings.length} diagnostic
            {view.data.warnings.length === 1 ? '' : 's'} from the valuation engine
          </summary>
          <ul style={{ textTransform: 'none', letterSpacing: 0, margin: '8px 0 0' }}>
            {view.data.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      )}

      <a className="vh" href={hrefFor({ kind: 'dashboard' })}>
        Back to the dashboard
      </a>
    </main>
  )
}
