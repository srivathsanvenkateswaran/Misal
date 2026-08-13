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
 * Four screens, not the mockup's five.
 *
 * `04 Import review` is being built concurrently in `src/screens/import/` and is deliberately
 * absent here rather than stubbed: a nav item leading to a placeholder would be a claim the
 * product cannot honour, and a stub file would collide with the screen that is actually coming.
 */
export const NAV: readonly NavItem[] = [
  { kind: 'dashboard', label: 'Dashboard', href: '#/' },
  { kind: 'holdings', label: 'Holdings', href: '#/holdings' },
  { kind: 'accounts', label: 'Accounts', href: '#/accounts' },
  { kind: 'instruments', label: 'Instruments', href: '#/instruments' },
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
  }
}

export const TITLE: Record<Route['kind'], string> = {
  dashboard: 'Dashboard',
  holdings: 'Holdings',
  accounts: 'Accounts',
  instruments: 'Instruments',
  instrument: 'Instrument',
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
