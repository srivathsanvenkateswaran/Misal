/**
 * The router.
 *
 * The spec asks for `createHashRouter` from React Router v6, for a reason that still holds: a hash
 * route needs no rewrite rules under the Tauri asset protocol, in the Vite dev server, or in a
 * later static build. React Router is not a dependency of this project and `package.json` is not
 * mine to change, so the hash router is written out here instead — forty lines against the
 * five routes v1 actually has.
 *
 * View state that a user would want to return to lives in the hash query string, exactly as the
 * spec requires: `#/holdings?group=account`. Nothing derived from core data is stored here.
 */

import { useEffect, useState } from 'react'

export type Route =
  | { readonly kind: 'dashboard' }
  | { readonly kind: 'holdings'; readonly group: HoldingsGroup }
  | { readonly kind: 'accounts' }
  | { readonly kind: 'instruments' }
  | { readonly kind: 'import' }
  | { readonly kind: 'settings' }
  | { readonly kind: 'refresh' }
  | { readonly kind: 'exchanges' }
  | { readonly kind: 'instrument'; readonly instrumentId: string }

export type HoldingsGroup = 'asset_class' | 'account' | 'instrument' | 'none'

const GROUPS: readonly HoldingsGroup[] = ['asset_class', 'account', 'instrument', 'none']

export const GROUP_LABEL: Record<HoldingsGroup, string> = {
  asset_class: 'Asset class',
  account: 'Account',
  instrument: 'Instrument',
  none: 'No grouping',
}

export interface NavItem {
  readonly kind: Route['kind']
  readonly label: string
  readonly href: string
}

/**
 * The five screens of v1.
 *
 * Import is last because it is a task rather than a view: everything to its left answers "what do
 * I have", and it answers "add more". It is also the only route a first-run user needs, which is
 * why the empty state links straight to it rather than relying on the nav.
 */
export const NAV: readonly NavItem[] = [
  { kind: 'dashboard', label: 'Dashboard', href: '#/' },
  { kind: 'holdings', label: 'Holdings', href: '#/holdings' },
  { kind: 'accounts', label: 'Accounts', href: '#/accounts' },
  { kind: 'instruments', label: 'Instruments', href: '#/instruments' },
  { kind: 'import', label: 'Import', href: '#/import' },
  { kind: 'exchanges', label: 'Exchanges', href: '#/exchanges' },
  { kind: 'refresh', label: 'Refresh', href: '#/refresh' },
  { kind: 'settings', label: 'Settings', href: '#/settings' },
]

function isGroup(raw: string | null): raw is HoldingsGroup {
  return raw !== null && (GROUPS as readonly string[]).includes(raw)
}

/** Parse a hash such as `#/holdings?group=account`. Anything unrecognised is the dashboard. */
export function parseRoute(hash: string): Route {
  const withoutHash = hash.startsWith('#') ? hash.slice(1) : hash
  const [path = '', query = ''] = withoutHash.split('?', 2)
  const params = new URLSearchParams(query)
  const segments = path.split('/').filter((segment) => segment !== '')

  const first = segments[0]
  if (first === undefined) return { kind: 'dashboard' }

  if (first === 'holdings') {
    const raw = params.get('group')
    return { kind: 'holdings', group: isGroup(raw) ? raw : 'asset_class' }
  }
  if (first === 'accounts') return { kind: 'accounts' }
  if (first === 'import') return { kind: 'import' }
  if (first === 'settings') return { kind: 'settings' }
  if (first === 'refresh') return { kind: 'refresh' }
  if (first === 'exchanges') return { kind: 'exchanges' }
  if (first === 'instruments') {
    const id = segments[1]
    if (id === undefined) return { kind: 'instruments' }
    return { kind: 'instrument', instrumentId: decodeURIComponent(id) }
  }
  return { kind: 'dashboard' }
}

export function hrefFor(route: Route): string {
  switch (route.kind) {
    case 'dashboard':
      return '#/'
    case 'holdings':
      return route.group === 'asset_class' ? '#/holdings' : `#/holdings?group=${route.group}`
    case 'accounts':
      return '#/accounts'
    case 'instruments':
      return '#/instruments'
    case 'instrument':
      return `#/instruments/${encodeURIComponent(route.instrumentId)}`
    case 'import':
      return '#/import'
    case 'settings':
      return '#/settings'
    case 'refresh':
      return '#/refresh'
    case 'exchanges':
      return '#/exchanges'
  }
}

export const TITLE: Record<Route['kind'], string> = {
  dashboard: 'Dashboard',
  holdings: 'Holdings',
  accounts: 'Accounts',
  instruments: 'Instruments',
  instrument: 'Instrument',
  import: 'Import',
  settings: 'Settings',
  refresh: 'Refresh',
  exchanges: 'Exchanges',
}

/** The current route, kept in sync with the address bar's hash. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(globalThis.location.hash))

  useEffect(() => {
    const onChange = (): void => {
      setRoute(parseRoute(globalThis.location.hash))
    }
    globalThis.addEventListener('hashchange', onChange)
    return () => {
      globalThis.removeEventListener('hashchange', onChange)
    }
  }, [])

  return route
}

export function navigate(route: Route): void {
  globalThis.location.hash = hrefFor(route)
}
