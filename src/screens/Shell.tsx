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
import { AppBar, ErrorState } from './chrome'
import { usePortfolio, useStorageStatus } from './queries'
import { NAV, hrefFor, useRoute } from './route'
import { Dashboard } from './Dashboard'
import { Holdings } from './Holdings'
import { Accounts } from './Accounts'
import { InstrumentDetail, InstrumentIndex } from './Instruments'
import { FirstRun } from './FirstRun'
import type { PortfolioData } from './view-model'
import './screens.css'

/** `Cmd/Ctrl + 1…4` jump to the four screens (spec §11.1). */
function useScreenShortcuts(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.metaKey && !event.ctrlKey) return
      const index = ['1', '2', '3', '4'].indexOf(event.key)
      if (index === -1) return
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
  }
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
