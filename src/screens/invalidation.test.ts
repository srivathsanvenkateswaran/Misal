/**
 * The invalidation key must match the query key.
 *
 * It did not. The post-import invalidation named `['portfolio']` while the query was keyed
 * `['valuation', { asOf }]`, so it matched nothing: a user could import a statement, watch the
 * review report confirm rows committed, return to the dashboard and see the figures they had
 * before. Which reads as the import having failed — the exact outcome the invalidation was added
 * to prevent, present for as long as the invalidation existed.
 *
 * Nothing caught it because both halves were internally consistent; only their relationship was
 * wrong, and no test looked at the relationship. This one does.
 */

import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { PORTFOLIO_QUERY_PREFIX, portfolioKey } from './queries'

describe('portfolio query invalidation', () => {
  it('the prefix actually matches a real portfolio query key', () => {
    const key = portfolioKey('2026-08-13T00:00:00.000Z')
    expect(key[0]).toBe(PORTFOLIO_QUERY_PREFIX)
  })

  it('invalidating by the prefix marks a cached portfolio stale', async () => {
    // The behavioural assertion, not just a shape check: TanStack matches by key prefix, so this
    // is what actually decides whether a dashboard refetches after an import.
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    })
    const key = portfolioKey('2026-08-13T00:00:00.000Z')
    client.setQueryData(key, { marker: 'before-import' })

    expect(client.getQueryState(key)?.isInvalidated).toBe(false)
    await client.invalidateQueries({ queryKey: [PORTFOLIO_QUERY_PREFIX] })
    expect(client.getQueryState(key)?.isInvalidated).toBe(true)
  })

  it('invalidates every cached asOf, not only the current one', async () => {
    // Prefix rather than exact match on purpose. A stored row that changed invalidates the
    // portfolio as of any date, so leaving other asOf entries fresh would serve a figure computed
    // from data that no longer exists.
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    })
    const today = portfolioKey('2026-08-13T00:00:00.000Z')
    const yesterday = portfolioKey('2026-08-12T00:00:00.000Z')
    client.setQueryData(today, { marker: 'a' })
    client.setQueryData(yesterday, { marker: 'b' })

    await client.invalidateQueries({ queryKey: [PORTFOLIO_QUERY_PREFIX] })

    expect(client.getQueryState(today)?.isInvalidated).toBe(true)
    expect(client.getQueryState(yesterday)?.isInvalidated).toBe(true)
  })

  it('the old key would not have matched, which is why this test exists', () => {
    const key = portfolioKey('2026-08-13T00:00:00.000Z')
    expect(key[0]).not.toBe('portfolio')
  })
})
