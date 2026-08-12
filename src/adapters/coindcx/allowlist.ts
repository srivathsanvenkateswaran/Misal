/**
 * CoinDCX's request allowlist.
 *
 * This list is the entire safety story for CoinDCX. The exchange issues one key class with full
 * trade authority - its own FAQ states plainly that read-only APIs are not offered and that all
 * API users have the same permissions - so nothing about the key restricts what Misal could do.
 * Only this list does.
 *
 * `orders/trade_history` reads; `orders/create` and `orders/cancel` are not here, and the path
 * classifier would reject them if they were.
 */

import type { AllowedRequest } from '../contract'

export const COINDCX_ALLOWLIST: readonly AllowedRequest[] = [
  // Market catalogue. Public, but served from the authenticated host.
  { method: 'GET', pathPattern: '/exchange/v1/markets_details', host: 'primary' },
  // Authenticated reads are POSTs because the signature covers the request body. A POST here
  // is not a mutation; the classifier judges the path, which is the part that names the action.
  { method: 'POST', pathPattern: '/exchange/v1/users/balances', host: 'primary' },
  { method: 'POST', pathPattern: '/exchange/v1/orders/trade_history', host: 'primary' },
]
