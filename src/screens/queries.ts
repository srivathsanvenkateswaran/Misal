/**
 * The query layer (spec §2.2, §12).
 *
 * Components never call `invoke`. Everything server-shaped — anything originating in the Rust core
 * or the valuation engine — arrives through a hook here, which is what makes the invalidation
 * graph complete and auditable rather than scattered across `useEffect`s.
 *
 * Two configuration decisions are deliberate and are not defaults:
 *
 *   `refetchOnWindowFocus: false` — a local database changes only when the user changes it. There
 *   is no server drift to chase, and refetching on focus could make a figure flicker between two
 *   values while the user is reading it.
 *
 *   `staleTime: Infinity` — valuation output is a pure function of positions, transactions, prices
 *   and fx. Every one of those has a known mutation that invalidates it, so time-based staleness
 *   would be a guess where we have exact knowledge.
 */

import { QueryClient, useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { loadPortfolioRows, storageStatus } from '../data/client'
import type { StorageStatus } from '../data/client'
import { buildPortfolioView } from './view-model'
import type { PortfolioView } from './view-model'

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        staleTime: Number.POSITIVE_INFINITY,
        retry: false,
      },
    },
  })
}

/**
 * Prefix shared by every portfolio query, and the only thing anything should invalidate.
 *
 * Exported as a constant because it was got wrong: the post-import invalidation named
 * `['portfolio']` while the query itself was keyed `['valuation', ...]`, so it matched nothing and
 * an import left stale figures on the dashboard - the precise failure the invalidation was added
 * to prevent. Two string literals in two files cannot be kept in step by intention.
 */
export const PORTFOLIO_QUERY_PREFIX = 'valuation' as const

export const portfolioKey = (asOf: string): readonly unknown[] => [
  PORTFOLIO_QUERY_PREFIX,
  { asOf },
]
export const storageKey: readonly unknown[] = ['storage']

/**
 * Every table the screens depend on, fetched together and valued once.
 *
 * Fetched together rather than per component so the whole screen renders one consistent view of
 * the database: staggered fetches would let a total and its constituent rows disagree on screen
 * during an import, which for a net-worth figure reads as a bug rather than as loading.
 */
export function usePortfolio(asOf: string): UseQueryResult<PortfolioView> {
  return useQuery({
    queryKey: portfolioKey(asOf),
    queryFn: async (): Promise<PortfolioView> => {
      const rows = await loadPortfolioRows()
      return buildPortfolioView(rows, asOf)
    },
  })
}

/** H11: the local-only claim is read from the real database handle, never asserted as copy. */
export function useStorageStatus(): UseQueryResult<StorageStatus> {
  return useQuery({ queryKey: storageKey, queryFn: storageStatus })
}
