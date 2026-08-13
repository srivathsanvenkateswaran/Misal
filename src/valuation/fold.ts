/**
 * The fold: transactions in, FIFO lot ledger out.
 *
 * Three properties matter more than anything else here, and each is a design choice rather than an
 * implementation detail:
 *
 *  1. It is a pure function of the *whole* transaction set, never incremental. A split imported six
 *     months late lands in its historical position on the next fold and produces the answer we
 *     would have had if it had arrived on time.
 *  2. Corporate actions rank before the same day's trades, because from the ex-date onward
 *     statements already quote adjusted quantities — a buy on the ex-date must not be adjusted
 *     again.
 *  3. Nothing is invented to paper over a defect. An unpriced `transfer_in` opens a lot whose cost
 *     is explicitly unknown; a sale exceeding inventory withholds every cost metric for the pair
 *     rather than fabricating a lot to absorb it.
 */

import {
  type CurrencyCode,
  type Dec,
  type Minor,
  ZERO_DEC,
  ZERO_MINOR,
  absDec,
  addDec,
  addMinor,
  compareDec,
  divDec,
  isZeroDec,
  minorToDec,
  mulDec,
  mulDivMinor,
  subDec,
  subMinor,
  valueOf,
} from '@domain/numeric'
import { commonScale, magnitudeMinor, scaleToInteger } from './arithmetic'
import { localDate } from './calendar'
import {
  type AccountCapability,
  type InstrumentRef,
  type IsoDate,
  type IsoInstant,
  type LotOrigin,
  type MeasurementReason,
  type MeasurementStatus,
  type OpenLot,
  type PositionRow,
  type Result,
  type TxnRow,
  type TxnType,
  type Warning,
  ValuationAssertionError,
  err,
  ok,
} from './types'

/**
 * Corporate actions first, then inflows, then trades, then outflows, then charges.
 *
 * Buys rank before sells so that a same-day buy-and-sell does not transiently exhaust inventory;
 * fees and TDS rank last because they consume no units.
 */
export const TYPE_RANK: Record<TxnType, number> = {
  split: 0,
  bonus: 0,
  transfer_in: 1,
  buy: 2,
  dividend: 3,
  interest: 3,
  sell: 4,
  transfer_out: 5,
  fee: 6,
  tds: 6,
}

export interface FoldInput {
  readonly accountId: string
  readonly capability: AccountCapability
  /** ALL transactions for the account, unfiltered. The fold windows nothing. */
  readonly txns: readonly TxnRow[]
  readonly snapshots: readonly PositionRow[]
  readonly instruments: ReadonlyMap<string, InstrumentRef>
  readonly asOf: IsoInstant
}

export interface OrderedTxn {
  readonly txn: TxnRow
  readonly date: IsoDate
  readonly rank: number
}

export type DisposalKind = 'sell' | 'transfer_out'

/** One lot's contribution to one disposal. Tax classification happens a layer up, in `tax.ts`. */
export interface LotConsumption {
  readonly disposalTxnId: string
  readonly kind: DisposalKind
  readonly lotId: string
  readonly accountId: string
  readonly instrumentId: string
  readonly quantity: Dec
  readonly acquiredOn: IsoDate
  readonly disposedOn: IsoDate
  readonly costMinor: Minor
  readonly costKnown: boolean
  readonly currency: CurrencyCode
  /** Apportioned gross consideration, before transfer expenses. Null when no price is recorded. */
  readonly grossConsiderationMinor: Minor | null
  readonly transferExpensesMinor: Minor
  readonly unitConsideration: Dec | null
  readonly lotOrigin: LotOrigin
}

export type IncomeKind = 'dividend' | 'interest' | 'fee' | 'tds'

/**
 * One income row, kept whole so that a caller can convert it.
 *
 * The totals below are sums over rows that may be in different currencies, so they are only ever
 * meaningful *within* one pair and one currency. Anything that adds income across pairs — the
 * portfolio layer does — must convert first, and conversion needs the date and the currency of each
 * row, which a total has thrown away. `fxRate` is the rate stored on the row itself, used in
 * preference to the daily table exactly as `xirr.ts` and `costInInr` use it.
 */
export interface IncomeEvent {
  readonly txnId: string
  readonly kind: IncomeKind
  readonly date: IsoDate
  /** A magnitude. Direction is the kind's, not the row's sign. */
  readonly amountMinor: Minor
  readonly currency: CurrencyCode
  readonly fxRate: Dec | null
}

export interface IncomeTotals {
  /**
   * In the transaction currency of the rows that produced them. Never sum these across pairs — see
   * `events`, which carries what a conversion needs.
   */
  readonly dividendMinor: Minor
  readonly interestMinor: Minor
  readonly feeMinor: Minor
  readonly tdsMinor: Minor
  readonly events: readonly IncomeEvent[]
}

export interface CorporateActionRef {
  readonly txnId: string
  readonly kind: 'split' | 'bonus'
  readonly date: IsoDate
  /** The split multiplier. Null for a bonus, which is expressed in units credited. */
  readonly multiplier: Dec | null
}

export interface LotLedger {
  readonly accountId: string
  readonly instrumentId: string
  /** FIFO order: `acquiredOn`, then `openingTxnId`. */
  readonly open: readonly OpenLot[]
  readonly consumptions: readonly LotConsumption[]
  /** Net signed quantity from the transaction stream. Negative only on a ledger defect. */
  readonly quantity: Dec
  readonly measurement: MeasurementStatus
  readonly reason: MeasurementReason | null
  readonly warnings: readonly Warning[]
  readonly provenance: readonly string[]
  readonly income: IncomeTotals
  readonly corporateActions: readonly CorporateActionRef[]
  /**
   * Running quantity after each day that changed it. Cross-account corporate-action detection
   * needs to know whether an account held the instrument on an ex-date, and reconstructing that
   * by re-walking the transactions in a second place would be a second implementation to keep in
   * step with this one.
   */
  readonly quantityHistory: readonly QuantityPoint[]
}

export interface QuantityPoint {
  readonly date: IsoDate
  readonly quantity: Dec
}

const STATUS_SEVERITY: Record<MeasurementStatus, number> = {
  measured: 0,
  partially_measured: 1,
  not_measured: 2,
}

interface MutableLot {
  lotId: string
  openingTxnId: string
  acquiredOn: IsoDate
  quantity: Dec
  costMinor: Minor
  currency: CurrencyCode
  fxRate: Dec | null
  costKnown: boolean
  origin: LotOrigin
}

/**
 * A deterministic lot id: FNV-1a over the tuple the spec names.
 *
 * Deterministic rather than random because a re-fold must produce the same ids for the same
 * transactions — the UI holds onto them across refreshes, and the determinism property test
 * compares folded output byte for byte.
 */
export function lotIdOf(accountId: string, instrumentId: string, openingTxnId: string): string {
  const input = `${accountId}\u0000${instrumentId}\u0000${openingTxnId}`
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (const char of input) {
    const code = char.codePointAt(0)
    if (code === undefined) throw new ValuationAssertionError('Unreadable lot id input')
    hash = ((hash ^ BigInt(code)) * prime) & mask
  }
  return `lot_${hash.toString(16).padStart(16, '0')}`
}

/**
 * Sort the entire transaction set by local calendar day, then type rank, then natural key.
 *
 * The natural key is a hash, so the final tiebreak is arbitrary but stable across machines and
 * re-imports — which is the only property required of it, and the one that makes the fold
 * order-independent with respect to import sequence.
 */
export function sortTxns(txns: readonly TxnRow[]): readonly OrderedTxn[] {
  return txns
    .map((txn) => ({ txn, date: localDate(txn.occurredAt, txn.occurredTz), rank: TYPE_RANK[txn.type] }))
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1
      if (a.rank !== b.rank) return a.rank - b.rank
      if (a.txn.naturalKey !== b.txn.naturalKey) return a.txn.naturalKey < b.txn.naturalKey ? -1 : 1
      return a.txn.id < b.txn.id ? -1 : a.txn.id > b.txn.id ? 1 : 0
    })
}

function fifoOrder(lots: readonly MutableLot[]): MutableLot[] {
  return [...lots].sort((a, b) => {
    if (a.acquiredOn !== b.acquiredOn) return a.acquiredOn < b.acquiredOn ? -1 : 1
    return a.openingTxnId < b.openingTxnId ? -1 : a.openingTxnId > b.openingTxnId ? 1 : 0
  })
}

/**
 * The quantity a transaction moves, as a magnitude.
 *
 * Direction comes from the transaction type, not from the sign on the row: ingestion adapters
 * disagree about whether a sale is recorded as -10 or 10, and inferring direction from the sign
 * would make the fold depend on which broker's CSV happened to produce the row.
 *
 * The identical rule governs the *money* on the same row — see `magnitudeMinor` in `arithmetic.ts`,
 * which every amount below goes through. Applying this reasoning to one column of a CAMS redemption
 * and not the other is what booked a ₹1,000 gain as a ₹19,000 loss.
 */
function magnitude(quantity: Dec): Dec {
  return absDec(quantity)
}

function purchaseCost(txn: TxnRow): { costMinor: Minor; known: boolean } {
  const fees = magnitudeMinor(txn.feesMinor)
  if (txn.amountMinor !== null) {
    return { costMinor: addMinor(magnitudeMinor(txn.amountMinor), fees), known: true }
  }
  if (txn.price !== null) {
    const gross = valueOf(magnitude(txn.quantity), txn.price, txn.currency)
    return { costMinor: addMinor(gross, fees), known: true }
  }
  // Cost is genuinely unknown. Zero is stored so the field has a value; `known: false` is what
  // every downstream consumer reads, and no code path is allowed to spend this zero as a cost.
  return { costMinor: ZERO_MINOR, known: false }
}

/**
 * Consideration per unit for a disposal: the recorded price, or the recorded amount divided by the
 * quantity. Needed per unit because grandfathering compares FMV against consideration per unit.
 *
 * The amount is taken as a magnitude, and `quantity` arrives as one, so a redemption printed in
 * brackets by a CAS cannot produce a negative price per unit — which grandfathering would then
 * compare against a positive FMV.
 */
function unitConsiderationOf(txn: TxnRow, quantity: Dec): Dec | null {
  if (txn.price !== null) return txn.price
  if (txn.amountMinor !== null && !isZeroDec(quantity)) {
    return divDec(minorToDec(magnitudeMinor(txn.amountMinor), txn.currency), quantity)
  }
  return null
}

/**
 * Total gross consideration of a disposal, when the row records one.
 *
 * A magnitude, never the row's own sign. The store legitimately holds a negative amount for a sale
 * — `normalizeTransaction` passes a CAS redemption's `(10,000.00)` through as `-1000000` and the
 * parser tests pin that as correct — and "money received" is the disposal's direction, which
 * `txn.type` has already settled.
 */
function grossOf(txn: TxnRow, quantity: Dec): Minor | null {
  if (txn.amountMinor !== null) return magnitudeMinor(txn.amountMinor)
  if (txn.price !== null) return valueOf(quantity, txn.price, txn.currency)
  return null
}

interface Slice {
  readonly lot: MutableLot
  readonly quantity: Dec
  readonly costMinor: Minor
  readonly costKnown: boolean
}

/**
 * Consume `quantity` units FIFO, splitting lot cost by exact integer allocation.
 *
 * The residual is always `lotCost - consumed`, never a second multiplication. That is the single
 * choice that makes `Σ consumed + residual === original` hold exactly for any sequence of partial
 * disposals, which is the first FIFO property test.
 */
function consumeFifo(lots: MutableLot[], quantity: Dec): { slices: Slice[]; shortfall: Dec } {
  const slices: Slice[] = []
  let remaining = quantity
  for (const lot of fifoOrder(lots)) {
    if (compareDec(remaining, ZERO_DEC) <= 0) break
    if (compareDec(lot.quantity, ZERO_DEC) <= 0) continue
    const take = compareDec(lot.quantity, remaining) <= 0 ? lot.quantity : remaining
    let consumedCost: Minor
    if (compareDec(take, lot.quantity) === 0) {
      consumedCost = lot.costMinor
    } else {
      const k = commonScale(take, lot.quantity)
      consumedCost = mulDivMinor(lot.costMinor, scaleToInteger(take, k), scaleToInteger(lot.quantity, k))
    }
    slices.push({ lot, quantity: take, costMinor: consumedCost, costKnown: lot.costKnown })
    lot.costMinor = subMinor(lot.costMinor, consumedCost)
    lot.quantity = subDec(lot.quantity, take)
    remaining = subDec(remaining, take)
  }
  return { slices, shortfall: compareDec(remaining, ZERO_DEC) > 0 ? remaining : ZERO_DEC }
}

/**
 * Apportion a total (gross consideration, or transfer expenses) across slices, pro rata by units,
 * with the last slice taken by subtraction so the total is allocated exactly.
 */
function apportion(total: Minor, slices: readonly Slice[]): Minor[] {
  if (slices.length === 0) return []
  const quantities = slices.map((s) => s.quantity)
  const k = commonScale(...quantities)
  const scaled = quantities.map((q) => scaleToInteger(q, k))
  const denominator = scaled.reduce((acc, v) => acc + v, 0n)
  if (denominator === 0n) return slices.map(() => ZERO_MINOR)
  const allocated: Minor[] = []
  let assigned = ZERO_MINOR
  for (let i = 0; i < slices.length - 1; i++) {
    const share = mulDivMinor(total, scaled[i] ?? 0n, denominator)
    allocated.push(share)
    assigned = addMinor(assigned, share)
  }
  allocated.push(subMinor(total, assigned))
  return allocated
}

class LedgerBuilder {
  readonly lots: MutableLot[] = []
  readonly consumptions: LotConsumption[] = []
  readonly warnings: Warning[] = []
  readonly corporateActions: CorporateActionRef[] = []
  readonly provenance = new Set<string>()
  readonly incomeEvents: IncomeEvent[] = []
  quantity: Dec = ZERO_DEC
  dividendMinor: Minor = ZERO_MINOR
  interestMinor: Minor = ZERO_MINOR
  feeMinor: Minor = ZERO_MINOR
  tdsMinor: Minor = ZERO_MINOR
  status: MeasurementStatus = 'measured'
  reason: MeasurementReason | null = null

  downgrade(reason: MeasurementReason): void {
    if (STATUS_SEVERITY[reason.status] > STATUS_SEVERITY[this.status]) {
      this.status = reason.status
      this.reason = reason
    } else if (this.reason === null) {
      this.reason = reason
    }
  }
}

function openLot(
  builder: LedgerBuilder,
  txn: TxnRow,
  date: IsoDate,
  quantity: Dec,
  costMinor: Minor,
  costKnown: boolean,
  origin: LotOrigin,
): void {
  builder.lots.push({
    lotId: lotIdOf(txn.accountId, txn.instrumentId, txn.id),
    openingTxnId: txn.id,
    acquiredOn: date,
    quantity,
    costMinor,
    currency: txn.currency,
    fxRate: txn.fxRate,
    costKnown,
    origin,
  })
  builder.quantity = addDec(builder.quantity, quantity)
}

function recordIncome(
  builder: LedgerBuilder,
  txn: TxnRow,
  date: IsoDate,
  kind: IncomeKind,
  amountMinor: Minor,
): void {
  builder.incomeEvents.push({
    txnId: txn.id,
    kind,
    date,
    amountMinor,
    currency: txn.currency,
    fxRate: txn.fxRate,
  })
}

function recordDisposal(
  builder: LedgerBuilder,
  txn: TxnRow,
  date: IsoDate,
  kind: DisposalKind,
  quantity: Dec,
): void {
  const { slices, shortfall } = consumeFifo(builder.lots, quantity)
  const gross = grossOf(txn, quantity)
  const grossShares = gross === null ? null : apportion(gross, slices)
  const feeShares = apportion(magnitudeMinor(txn.feesMinor), slices)
  const unitConsideration = unitConsiderationOf(txn, quantity)

  slices.forEach((slice, index) => {
    builder.consumptions.push({
      disposalTxnId: txn.id,
      kind,
      lotId: slice.lot.lotId,
      accountId: txn.accountId,
      instrumentId: txn.instrumentId,
      quantity: slice.quantity,
      acquiredOn: slice.lot.acquiredOn,
      disposedOn: date,
      costMinor: slice.costMinor,
      costKnown: slice.costKnown,
      currency: txn.currency,
      grossConsiderationMinor: grossShares === null ? null : (grossShares[index] ?? ZERO_MINOR),
      transferExpensesMinor: feeShares[index] ?? ZERO_MINOR,
      unitConsideration,
      lotOrigin: slice.lot.origin,
    })
  })

  builder.quantity = subDec(builder.quantity, quantity)

  if (!isZeroDec(shortfall)) {
    builder.warnings.push({
      code: 'NEGATIVE_INVENTORY',
      message:
        `Transaction ${txn.id} disposes of ${quantity} units but only ` +
        `${subDec(quantity, shortfall)} were held. The sale is real; a purchase is missing.`,
      ref: { txnId: txn.id, accountId: txn.accountId, instrumentId: txn.instrumentId },
    })
    builder.downgrade({
      status: 'not_measured',
      code: 'NEGATIVE_INVENTORY',
      message: `Inventory went negative at transaction ${txn.id}; FIFO ordering upstream of the hole is unreliable, so cost basis and P&L are withheld for the whole history of this holding.`,
      userFixable: true,
    })
  }
}

function applySplit(builder: LedgerBuilder, txn: TxnRow, date: IsoDate): void {
  const ratio = txn.quantity
  if (compareDec(ratio, ZERO_DEC) <= 0) {
    builder.warnings.push({
      code: 'INVALID_SPLIT_RATIO',
      message: `Split ${txn.id} carries a non-positive multiplier ${ratio}; it was ignored.`,
      ref: { txnId: txn.id, instrumentId: txn.instrumentId },
    })
    builder.downgrade({
      status: 'not_measured',
      code: 'INVALID_SPLIT_RATIO',
      message: `A corporate action for this holding has an unusable ratio.`,
      userFixable: true,
    })
    return
  }
  for (const lot of builder.lots) {
    // Cost and acquisition date are deliberately untouched: a split is not an acquisition, so
    // total cost is invariant and section 2(42A) holding period continues from the original buy.
    lot.quantity = mulDec(lot.quantity, ratio)
  }
  builder.quantity = mulDec(builder.quantity, ratio)
  builder.corporateActions.push({ txnId: txn.id, kind: 'split', date, multiplier: ratio })
}

function buildPairLedger(
  accountId: string,
  instrumentId: string,
  ordered: readonly OrderedTxn[],
): LotLedger {
  const builder = new LedgerBuilder()
  const quantityHistory: QuantityPoint[] = []

  for (const { txn, date } of ordered) {
    builder.provenance.add(txn.sourceDocumentId)
    const qty = magnitude(txn.quantity)
    switch (txn.type) {
      case 'split':
        applySplit(builder, txn, date)
        break
      case 'bonus': {
        // Section 55(2)(aa)(iiia): bonus units have nil cost, and their holding period runs from
        // their own allotment date. A new dated lot is the only shape that expresses both.
        openLot(builder, txn, date, qty, ZERO_MINOR, true, 'bonus')
        builder.corporateActions.push({ txnId: txn.id, kind: 'bonus', date, multiplier: null })
        break
      }
      case 'buy': {
        const { costMinor, known } = purchaseCost(txn)
        openLot(builder, txn, date, qty, costMinor, known, 'buy')
        if (!known) {
          builder.warnings.push({
            code: 'MISSING_ACQUISITION_COST',
            message: `Purchase ${txn.id} records neither an amount nor a price.`,
            ref: { txnId: txn.id, instrumentId: txn.instrumentId },
          })
          builder.downgrade({
            status: 'partially_measured',
            code: 'MISSING_ACQUISITION_COST',
            message: 'A purchase in this holding has no recorded cost. Enter it to restore cost basis and XIRR.',
            userFixable: true,
          })
        }
        break
      }
      case 'transfer_in': {
        const { costMinor, known } = purchaseCost(txn)
        openLot(builder, txn, date, qty, costMinor, known, 'transfer_in')
        if (!known) {
          builder.warnings.push({
            code: 'MISSING_ACQUISITION_COST',
            message: `Transfer in ${txn.id} carries no price, so its acquisition cost is unknown.`,
            ref: { txnId: txn.id, instrumentId: txn.instrumentId },
          })
          builder.downgrade({
            status: 'partially_measured',
            code: 'MISSING_ACQUISITION_COST',
            message: 'Units were transferred in without a price. Quantity and market value are counted; cost basis, unrealised P&L and XIRR are withheld until an acquisition price is entered.',
            userFixable: true,
          })
        }
        break
      }
      case 'sell':
        recordDisposal(builder, txn, date, 'sell', qty)
        break
      case 'transfer_out':
        recordDisposal(builder, txn, date, 'transfer_out', qty)
        break
      // Every income amount is taken as a magnitude for the same reason a disposal's is: a fee or a
      // TDS deduction printed in brackets is still money out, and the kind already says which way.
      case 'dividend': {
        const amount = magnitudeMinor(txn.amountMinor ?? ZERO_MINOR)
        builder.dividendMinor = addMinor(builder.dividendMinor, amount)
        recordIncome(builder, txn, date, 'dividend', amount)
        break
      }
      case 'interest': {
        const amount = magnitudeMinor(txn.amountMinor ?? ZERO_MINOR)
        builder.interestMinor = addMinor(builder.interestMinor, amount)
        recordIncome(builder, txn, date, 'interest', amount)
        break
      }
      case 'fee': {
        const amount = magnitudeMinor(txn.amountMinor ?? txn.feesMinor)
        builder.feeMinor = addMinor(builder.feeMinor, amount)
        recordIncome(builder, txn, date, 'fee', amount)
        break
      }
      case 'tds': {
        const amount = magnitudeMinor(txn.amountMinor ?? ZERO_MINOR)
        builder.tdsMinor = addMinor(builder.tdsMinor, amount)
        recordIncome(builder, txn, date, 'tds', amount)
        break
      }
    }
    const last = quantityHistory[quantityHistory.length - 1]
    if (last !== undefined && last.date === date) {
      quantityHistory[quantityHistory.length - 1] = { date, quantity: builder.quantity }
    } else {
      quantityHistory.push({ date, quantity: builder.quantity })
    }
  }

  const open: OpenLot[] = fifoOrder(builder.lots)
    .filter((lot) => compareDec(lot.quantity, ZERO_DEC) > 0)
    .map((lot) => ({
      lotId: lot.lotId,
      accountId,
      instrumentId,
      openingTxnId: lot.openingTxnId,
      acquiredOn: lot.acquiredOn,
      quantity: lot.quantity,
      costMinor: lot.costMinor,
      currency: lot.currency,
      fxRate: lot.fxRate,
      costKnown: lot.costKnown,
      origin: lot.origin,
    }))

  return {
    accountId,
    instrumentId,
    // Lots are withheld entirely when the pair is not measured: a partial lot chain reads as a
    // complete one on screen, and that is precisely the plausible-looking wrong answer to avoid.
    open: builder.status === 'not_measured' ? [] : open,
    consumptions: builder.consumptions,
    quantity: builder.quantity,
    measurement: builder.status,
    reason: builder.reason,
    warnings: builder.warnings,
    provenance: [...builder.provenance].sort(),
    income: {
      dividendMinor: builder.dividendMinor,
      interestMinor: builder.interestMinor,
      feeMinor: builder.feeMinor,
      tdsMinor: builder.tdsMinor,
      events: builder.incomeEvents,
    },
    corporateActions: builder.corporateActions,
    quantityHistory,
  }
}

/** Quantity held at the end of `date`, from the ledger's own running history. */
export function quantityOn(ledger: LotLedger, date: IsoDate): Dec {
  let quantity = ZERO_DEC
  for (const point of ledger.quantityHistory) {
    if (point.date > date) break
    quantity = point.quantity
  }
  return quantity
}

/**
 * Fold an account's whole transaction set into one lot ledger per instrument.
 *
 * Returns `Err` only for inputs that are wrong rather than incomplete — a transaction belonging to
 * another account, an instrument the caller did not supply. Incomplete data downgrades measurement
 * and rides along in `warnings`.
 */
export function buildLots(input: FoldInput): Result<ReadonlyMap<string, LotLedger>> {
  const byInstrument = new Map<string, TxnRow[]>()
  for (const txn of input.txns) {
    if (txn.accountId !== input.accountId) {
      return err({
        code: 'ACCOUNT_MISMATCH',
        message: `Transaction ${txn.id} belongs to account ${txn.accountId}, not ${input.accountId}.`,
        ref: { txnId: txn.id, accountId: txn.accountId },
      })
    }
    if (!input.instruments.has(txn.instrumentId)) {
      return err({
        code: 'UNKNOWN_INSTRUMENT',
        message: `No instrument metadata supplied for ${txn.instrumentId}.`,
        ref: { txnId: txn.id, instrumentId: txn.instrumentId },
      })
    }
    const bucket = byInstrument.get(txn.instrumentId)
    if (bucket === undefined) byInstrument.set(txn.instrumentId, [txn])
    else bucket.push(txn)
  }

  const ledgers = new Map<string, LotLedger>()
  const warnings: Warning[] = []
  for (const [instrumentId, txns] of [...byInstrument.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const ledger = buildPairLedger(input.accountId, instrumentId, sortTxns(txns))
    ledgers.set(instrumentId, ledger)
    warnings.push(...ledger.warnings)
  }
  return ok(ledgers, warnings)
}

/** Total remaining cost across a ledger's open lots. Only meaningful when every cost is known. */
export function openCostMinor(ledger: LotLedger): Minor {
  return addMinor(...ledger.open.map((lot) => lot.costMinor))
}

/** Total open quantity. Equals `ledger.quantity` whenever the pair is measured. */
export function openQuantity(ledger: LotLedger): Dec {
  return addDec(...ledger.open.map((lot) => lot.quantity))
}
