/**
 * Transaction classification for registrar statements.
 *
 * The description column is free text with heavy per-AMC and per-RTA variation, so this is an
 * ordered rule list over the description plus the sign of the units column — not a lookup table.
 * Every string matched below was observed in a real statement; none is invented.
 *
 * Order is load-bearing. `Redemption - Reversal` is a reversal, not a redemption, and only
 * because the reversal rule is tested first.
 */

import { classificationForm } from './text'
import type { TxnType } from './types'

export type UnitsSign = 'positive' | 'negative' | 'none'

export type Classification =
  /** A financial event to emit. `alsoBuy` marks a dividend reinvestment, which is two facts. */
  | { readonly kind: 'transaction'; readonly type: TxnType; readonly alsoBuy: boolean }
  /** A levy printed on its own row, to be folded into the trade above it. */
  | { readonly kind: 'levy'; readonly bucket: 'stampDuty' | 'stt' }
  /** A non-financial event row: address change, nominee registration, KYC update. */
  | { readonly kind: 'event' }
  | { readonly kind: 'unclassified' }

/** `*** Dividend @ Rs. 1.50 per unit ***`, in all the spacings the corpus uses. */
const DIVIDEND_RATE = /@\s*rs\.?\s*[\d,.]+\s*per\s*unit/

const DIVIDEND_WORDS = /(dividend|idcw|div\.)/

/** All observed in real statements. A reversal inverts the transaction it reverses. */
const REVERSAL_WORDS =
  /(reversal|rejection|dishonour|dishonor|mismatch|insufficient balance|payment not received)/

/** `S T P In` is letter-spaced by the issuer, so the rule must tolerate the spacing. */
const SWITCH_WORDS = /(switch|s\s*t\s*p|systematic transfer)/

const SIP_WORDS = /(sip|systematic|instal\s*ment|sys\.\s*invest)/

export function classifyDescription(description: string, units: UnitsSign, hasAmount: boolean): Classification {
  const text = classificationForm(description)

  // 1. Dividend, however it is spelled. A reinvestment is a dividend *and* a purchase; both are
  //    facts the user needs, and emitting only the buy would hide the income at tax time.
  if (DIVIDEND_RATE.test(text) || DIVIDEND_WORDS.test(text)) {
    return { kind: 'transaction', type: 'dividend', alsoBuy: units === 'positive' }
  }

  if (units === 'none') {
    // 2. No units and no money: an address change, a nominee registration, a KYC update. These
    //    are skipped rather than failed — they are not transactions and never were.
    if (!hasAmount) return { kind: 'event' }
    // 3. A levy row, folded into the trade it belongs to rather than emitted. Under s.55 stamp
    //    duty is part of the cost of acquisition, and the purchase amount above it is already net
    //    of the levy.
    if (/stamp/.test(text)) return { kind: 'levy', bucket: 'stampDuty' }
    if (/\bstt\b|securities transaction tax/.test(text)) return { kind: 'levy', bucket: 'stt' }
    // 4. TDS is emitted as its own transaction: the user needs it as a distinct cashflow.
    if (/\btds\b|tax deducted/.test(text)) return { kind: 'transaction', type: 'tds', alsoBuy: false }
    return { kind: 'unclassified' }
  }

  if (units === 'positive') {
    if (/gift/.test(text)) return { kind: 'transaction', type: 'transfer_in', alsoBuy: false }
    if (SWITCH_WORDS.test(text)) return { kind: 'transaction', type: 'transfer_in', alsoBuy: false }
    // A SIP instalment is a purchase. The spelling varies enough that the counter styles
    // `- Instalment 5/937` (CAMS) and `(5/1000)` (KFintech) both appear; neither is matched on.
    if (SIP_WORDS.test(text)) return { kind: 'transaction', type: 'buy', alsoBuy: false }
    return { kind: 'transaction', type: 'buy', alsoBuy: false }
  }

  if (/gift/.test(text)) return { kind: 'transaction', type: 'transfer_out', alsoBuy: false }
  // A reversed purchase takes the units back out and returns the money, which is what a `sell` at
  // the same NAV models: unit balance stays correct and the round trip yields no gain. Calling it
  // a transfer_out would drop a real cashflow out of XIRR.
  if (REVERSAL_WORDS.test(text)) return { kind: 'transaction', type: 'sell', alsoBuy: false }
  if (SWITCH_WORDS.test(text)) return { kind: 'transaction', type: 'transfer_out', alsoBuy: false }
  return { kind: 'transaction', type: 'sell', alsoBuy: false }
}
