/**
 * The crypto resolution ladder.
 *
 *   1. A provider-local alias. The fast path, and the memory of every previous resolution -
 *      including ones the user confirmed by hand in the review queue.
 *   2. The bundled seed catalogue. A hit creates the provider-local alias, and either links to
 *      the instrument already carrying that CoinGecko alias or creates one.
 *   3. A miss goes to `unresolved_instrument` with its observed quantity, so the UI can state the
 *      exact value withheld from totals. Never a guessed match, never a new instrument.
 *
 * Step 2 is what makes BTC on two exchanges one instrument without any machinery: the alias
 * table's primary key makes ('coingecko', 'bitcoin', NULL) unique, so the second exchange's
 * resolution finds the row the first created and attaches its own provider-local alias to it.
 */

import type { Dec } from '@domain/numeric'
import type { ProviderId } from '../contract'
import { type Catalogue, lookupCatalogue, SEED_CATALOGUE } from './catalogue'

export interface InstrumentSpec {
  readonly assetClass: 'crypto' | 'cash'
  readonly displayName: string
  /**
   * Crypto is priced in USD by the price providers, and the valuation engine already applies
   * USD->INR for US equities. Reusing that path beats a crypto-specific one. Fiat instruments
   * are denominated in themselves.
   */
  readonly currency: string
  /** From the exchange market catalogue's step size, clamped to [0, 18]. The core default of 4
   * would render a Bitcoin balance uselessly. */
  readonly precision: number
  /** Virtual digital asset, for Indian capital-gains treatment. */
  readonly taxRegime: 'vda' | null
}

export interface UnresolvedRecord {
  readonly accountId: string
  readonly sourceDocumentId: string
  readonly rawIdentifier: string
  readonly rawName: string | null
  readonly assetClassHint: string
  readonly observedQuantity: Dec | null
}

export interface InstrumentStore {
  findInstrumentByAlias(
    scheme: 'coingecko' | 'provider-local',
    value: string,
    providerId: ProviderId | null,
  ): Promise<string | null>
  createInstrument(spec: InstrumentSpec): Promise<string>
  addAlias(
    instrumentId: string,
    scheme: 'coingecko' | 'provider-local',
    value: string,
    providerId: ProviderId | null,
  ): Promise<void>
  recordUnresolved(record: UnresolvedRecord): Promise<void>
}

export type Resolution =
  | { readonly resolved: true; readonly instrumentId: string }
  | { readonly resolved: false; readonly reason: 'not_in_catalogue' }

export interface ResolveOptions {
  readonly catalogue?: Catalogue
  /** From the market catalogue, where the asset is a traded base asset. */
  readonly precision?: number
}

export async function resolveAsset(
  store: InstrumentStore,
  providerId: ProviderId,
  code: string,
  options: ResolveOptions = {},
): Promise<Resolution> {
  const existing = await store.findInstrumentByAlias('provider-local', code, providerId)
  if (existing !== null) return { resolved: true, instrumentId: existing }

  const hit = lookupCatalogue(options.catalogue ?? SEED_CATALOGUE, providerId, code)
  if (hit === null) return { resolved: false, reason: 'not_in_catalogue' }

  const byCoingecko = await store.findInstrumentByAlias('coingecko', hit.coingeckoId, null)
  const instrumentId =
    byCoingecko ??
    (await createWithAlias(store, hit.coingeckoId, {
      assetClass: hit.assetClass,
      displayName: hit.displayName,
      currency: hit.assetClass === 'cash' ? fiatCodeOf(hit.coingeckoId, code) : 'USD',
      precision: clamp(options.precision ?? (hit.assetClass === 'cash' ? 2 : 8)),
      taxRegime: hit.assetClass === 'crypto' ? 'vda' : null,
    }))

  await store.addAlias(instrumentId, 'provider-local', code, providerId)
  return { resolved: true, instrumentId }
}

async function createWithAlias(
  store: InstrumentStore,
  coingeckoId: string,
  spec: InstrumentSpec,
): Promise<string> {
  const id = await store.createInstrument(spec)
  await store.addAlias(id, 'coingecko', coingeckoId, null)
  return id
}

function fiatCodeOf(coingeckoId: string, code: string): string {
  return coingeckoId.startsWith('fiat:') ? coingeckoId.slice('fiat:'.length) : code
}

function clamp(precision: number): number {
  if (precision < 0) return 0
  return precision > 18 ? 18 : precision
}
