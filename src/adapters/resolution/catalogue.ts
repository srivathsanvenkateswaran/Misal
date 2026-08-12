/**
 * The seed catalogue: `(exchange, asset code) -> CoinGecko id`.
 *
 * Crypto has no ISIN, no CUSIP and no registrar, so the core resolution ladder's first three
 * steps do not exist here. CoinGecko ids are the anchor instead - free, keyless, stable across
 * renames, and covering both exchanges' listings.
 *
 * Nothing resolves on ticker symbol alone, and that is the entire point. Ticker collisions in
 * crypto are routine rather than exceptional: CoinGecko's own list contains many duplicate
 * `symbol` values pointing at unrelated assets, and a wrong merge double-counts net worth, which
 * is the worst failure this application has. Matching `(exchange, code)` against a curated table
 * is safe only because a human decided that this exchange's XYZ and CoinGecko's xyz are the same
 * thing.
 *
 * The table is deliberately incomplete. The top listings by both exchanges resolve the
 * overwhelming majority of real balances; everything else goes to the review queue, where the
 * user resolves it once and a provider-local alias makes it permanent. An incomplete catalogue
 * produces a visible question. A fuzzy one produces a wrong number.
 */

import type { ProviderId } from '../contract'

export interface CatalogueEntry {
  readonly coingeckoId: string
  readonly displayName: string
  /**
   * Stablecoins are 'crypto', not 'cash': USDT carries issuer and depeg risk and is traded, and
   * classifying it as cash would present it as risk-free in the allocation chart. Fiat balances
   * are 'cash'.
   */
  readonly assetClass: 'crypto' | 'cash'
  /** The exchange codes that resolve to it, per provider. */
  readonly codes: Partial<Record<ProviderId, readonly string[]>>
}

export type Catalogue = readonly CatalogueEntry[]

const BOTH = (code: string): Partial<Record<ProviderId, readonly string[]>> => ({
  binance: [code],
  coindcx: [code],
})

export const SEED_CATALOGUE: Catalogue = [
  { coingeckoId: 'bitcoin', displayName: 'Bitcoin', assetClass: 'crypto', codes: BOTH('BTC') },
  { coingeckoId: 'ethereum', displayName: 'Ethereum', assetClass: 'crypto', codes: BOTH('ETH') },
  // Wrapped and bridged tokens are separate instruments. WBTC is not BTC: different CoinGecko
  // ids, different issuer risk, and merging them would hide a real exposure.
  {
    coingeckoId: 'wrapped-bitcoin',
    displayName: 'Wrapped Bitcoin',
    assetClass: 'crypto',
    codes: BOTH('WBTC'),
  },
  { coingeckoId: 'tether', displayName: 'Tether USDt', assetClass: 'crypto', codes: BOTH('USDT') },
  { coingeckoId: 'usd-coin', displayName: 'USDC', assetClass: 'crypto', codes: BOTH('USDC') },
  {
    coingeckoId: 'binancecoin',
    displayName: 'BNB',
    assetClass: 'crypto',
    codes: BOTH('BNB'),
  },
  { coingeckoId: 'ripple', displayName: 'XRP', assetClass: 'crypto', codes: BOTH('XRP') },
  { coingeckoId: 'solana', displayName: 'Solana', assetClass: 'crypto', codes: BOTH('SOL') },
  { coingeckoId: 'cardano', displayName: 'Cardano', assetClass: 'crypto', codes: BOTH('ADA') },
  { coingeckoId: 'dogecoin', displayName: 'Dogecoin', assetClass: 'crypto', codes: BOTH('DOGE') },
  { coingeckoId: 'tron', displayName: 'TRON', assetClass: 'crypto', codes: BOTH('TRX') },
  { coingeckoId: 'polkadot', displayName: 'Polkadot', assetClass: 'crypto', codes: BOTH('DOT') },
  { coingeckoId: 'chainlink', displayName: 'Chainlink', assetClass: 'crypto', codes: BOTH('LINK') },
  { coingeckoId: 'litecoin', displayName: 'Litecoin', assetClass: 'crypto', codes: BOTH('LTC') },
  {
    coingeckoId: 'avalanche-2',
    displayName: 'Avalanche',
    assetClass: 'crypto',
    codes: BOTH('AVAX'),
  },
  {
    coingeckoId: 'matic-network',
    displayName: 'Polygon',
    assetClass: 'crypto',
    codes: BOTH('MATIC'),
  },
  { coingeckoId: 'uniswap', displayName: 'Uniswap', assetClass: 'crypto', codes: BOTH('UNI') },
  { coingeckoId: 'stellar', displayName: 'Stellar', assetClass: 'crypto', codes: BOTH('XLM') },
  {
    coingeckoId: 'bitcoin-cash',
    displayName: 'Bitcoin Cash',
    assetClass: 'crypto',
    codes: BOTH('BCH'),
  },
  { coingeckoId: 'cosmos', displayName: 'Cosmos Hub', assetClass: 'crypto', codes: BOTH('ATOM') },
  { coingeckoId: 'near', displayName: 'NEAR Protocol', assetClass: 'crypto', codes: BOTH('NEAR') },
  { coingeckoId: 'aave', displayName: 'Aave', assetClass: 'crypto', codes: BOTH('AAVE') },
  { coingeckoId: 'shiba-inu', displayName: 'Shiba Inu', assetClass: 'crypto', codes: BOTH('SHIB') },
  { coingeckoId: 'the-graph', displayName: 'The Graph', assetClass: 'crypto', codes: BOTH('GRT') },
  { coingeckoId: 'filecoin', displayName: 'Filecoin', assetClass: 'crypto', codes: BOTH('FIL') },
  { coingeckoId: 'algorand', displayName: 'Algorand', assetClass: 'crypto', codes: BOTH('ALGO') },
  { coingeckoId: 'vechain', displayName: 'VeChain', assetClass: 'crypto', codes: BOTH('VET') },
  {
    coingeckoId: 'internet-computer',
    displayName: 'Internet Computer',
    assetClass: 'crypto',
    codes: BOTH('ICP'),
  },
  { coingeckoId: 'ethereum-classic', displayName: 'Ethereum Classic', assetClass: 'crypto', codes: BOTH('ETC') },
  { coingeckoId: 'monero', displayName: 'Monero', assetClass: 'crypto', codes: { binance: ['XMR'] } },
  { coingeckoId: 'first-digital-usd', displayName: 'First Digital USD', assetClass: 'crypto', codes: { binance: ['FDUSD'] } },
  { coingeckoId: 'true-usd', displayName: 'TrueUSD', assetClass: 'crypto', codes: { binance: ['TUSD'] } },

  // Fiat. A CoinDCX INR balance is rupees, and it is the one asset class here that is cash.
  {
    coingeckoId: 'fiat:INR',
    displayName: 'Indian rupee',
    assetClass: 'cash',
    codes: { coindcx: ['INR'] },
  },
  {
    coingeckoId: 'fiat:USD',
    displayName: 'US dollar',
    assetClass: 'cash',
    codes: { binance: ['USD'] },
  },
]

export interface CatalogueHit {
  readonly coingeckoId: string
  readonly displayName: string
  readonly assetClass: 'crypto' | 'cash'
}

/** Look an exchange asset code up. Case-sensitive: exchange codes are upper case by convention. */
export function lookupCatalogue(
  catalogue: Catalogue,
  providerId: ProviderId,
  code: string,
): CatalogueHit | null {
  for (const entry of catalogue) {
    if (entry.codes[providerId]?.includes(code) === true) {
      return {
        coingeckoId: entry.coingeckoId,
        displayName: entry.displayName,
        assetClass: entry.assetClass,
      }
    }
  }
  return null
}
