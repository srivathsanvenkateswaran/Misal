/**
 * Binance's request allowlist.
 *
 * This is the list a security-minded reviewer should read first. Every request Misal can make to
 * Binance is here; `POST /api/v3/order` is unreachable not because the key forbids it but because
 * no code path can express it.
 */

import type { AllowedRequest } from '../contract'

export const BINANCE_ALLOWLIST: readonly AllowedRequest[] = [
  // Clock, on the authenticated host: the offset must be measured against the host we sign to.
  { method: 'GET', pathPattern: '/api/v3/time', host: 'primary' },
  // Market catalogue, on the data-only host, so its weight stays off the authenticated IP budget.
  { method: 'GET', pathPattern: '/api/v3/exchangeInfo', host: 'public' },
  // Read for `permissions` and `uid` only. Its canTrade/canWithdraw describe the ACCOUNT, not
  // the key, and are never used for a scope decision - see describeScope.
  { method: 'GET', pathPattern: '/api/v3/account', host: 'primary' },
  { method: 'GET', pathPattern: '/api/v3/myTrades', host: 'primary' },
  // The authoritative scope report for the key itself. Weight 1.
  { method: 'GET', pathPattern: '/sapi/v1/account/apiRestrictions', host: 'primary' },
  { method: 'GET', pathPattern: '/sapi/v1/capital/deposit/hisrec', host: 'primary' },
  // Reads withdrawal history. The mutating sibling is /capital/withdraw/apply, which the
  // path classifier rejects on the 'apply' terminal even if someone added it here.
  { method: 'GET', pathPattern: '/sapi/v1/capital/withdraw/history', host: 'primary' },
  // Convert history, the only place Convert fills ever appear. Its siblings /convert/getQuote and
  // /convert/acceptQuote perform the conversion and are refused by the classifier: the 'convert'
  // segment is mutating and only the 'tradeFlow' terminal earns the read exemption.
  { method: 'GET', pathPattern: '/sapi/v1/convert/tradeFlow', host: 'primary' },
  // Read-only despite the verb. The richer balance source: positive balances only, with
  // freeze, withdrawing and ipoable alongside free and locked.
  { method: 'POST', pathPattern: '/sapi/v3/asset/getUserAsset', host: 'primary' },
]
