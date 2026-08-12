# Subsystem D — Valuation engine and price service

**Status:** draft
**Date:** 2026-08-12
**Depends on:** [Subsystem A — core schema and storage](2026-08-12-core-schema-storage.md),
[v1 design](2026-08-12-misal-v1-design.md)
**Blocks:** Subsystem E (desktop UI), Subsystem H (MCP layer)

This subsystem turns rows in `txn`, `position`, `price` and `fx_rate` into every number the UI
displays: net worth, cost basis, unrealised and realised P&L, XIRR, allocation, and the coverage
figures that qualify all of them.

It is pure. Given a database snapshot and a valuation instant it computes a result; it never
fetches. Fetching lives in the price service, which writes into `price` and `fx_rate` and is
invoked only by an explicit refresh. This split is what makes the application work offline and
what makes the engine testable without a network.

The core schema is a fixed contract. Where this subsystem needs something the schema does not
carry, it is recorded in [Open questions for core](#open-questions-for-core) rather than invented.

## Non-negotiables

1. **No `Number` touches a quantity, price, amount or rate.** Money is `bigint` minor units;
   quantities, prices and FX rates are `Decimal` (decimal.js). The lint rule from Subsystem A
   applies to this package with no exemptions, including test fixtures.
2. **A number that cannot be computed is absent, not zero.** Every computation returns a
   discriminated result. There is no code path that substitutes `0` for a missing price, a missing
   FX rate, or an unknown cost.
3. **The fold is a pure function of the whole transaction set.** Never incremental. A corporate
   action imported six months late must produce the same answer as one imported on time.
4. **Rounding happens once, at the display boundary.** The engine returns `Decimal` and `bigint`;
   formatting rounds. The one exception is lot-cost allocation, which rounds to minor units by
   design and is specified exactly in [Partial disposals](#partial-disposals) so that it cannot
   drift.
5. **Tax rules are data, not branches.** They change every February. They live in a versioned
   rules table keyed by effective date.

## Numeric foundation

```ts
import Decimal from 'decimal.js';

// Configured once for the package. XIRR needs headroom for repeated fractional exponentiation.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 40 });

/** Integer minor units. Paise for INR, cents for USD. Matches the int64 column exactly. */
type Minor = bigint;

/** ISO-4217. The exponent comes from the static currency table, never from the data. */
type Currency = 'INR' | 'USD' | (string & {});

type IsoDate    = string;   // 'YYYY-MM-DD'
type IsoInstant = string;   // 'YYYY-MM-DDTHH:mm:ss±HH:mm'
type DecStr     = string;   // canonical decimal string, as stored

interface Money { readonly minor: Minor; readonly currency: Currency; }

/** A price or NAV: money per unit, at higher precision than minor units allow. */
interface UnitPrice { readonly value: Decimal; readonly currency: Currency; }
```

`Minor` is `bigint` rather than `number` because a portfolio in paise crosses `Number.MAX_SAFE_
INTEGER` (₹9.007 × 10^13) at about ₹900 crore — implausible for one user, but so is discovering
the ceiling by silent corruption. `bigint` also matches the int64 column with no conversion.

Quantities and prices cross the IPC boundary as strings and are parsed into `Decimal` at the edge.
`Money` crosses as `{ minor: string, currency: string }`. Nothing crosses as a JSON number.

### Result types

Everything fallible returns one of these. Callers destructure; nothing throws for absent data.
Exceptions are reserved for programmer error (a malformed decimal string that got past ingestion).

```ts
type Ok<T>  = { readonly ok: true;  readonly value: T; readonly warnings: readonly Warning[] };
type Err<E> = { readonly ok: false; readonly error: E; readonly warnings: readonly Warning[] };
type Result<T, E = ValuationError> = Ok<T> | Err<E>;

interface Warning { readonly code: WarningCode; readonly message: string; readonly ref?: RowRef; }
interface RowRef  { readonly txnId?: string; readonly accountId?: string;
                    readonly instrumentId?: string; readonly sourceDocumentId?: string; }
```

Warnings ride alongside successes. A valuation with three stale prices is still a valuation; the
UI needs both the number and the caveat. Errors terminate a *specific* computation, not the run —
one instrument whose cost basis is unknowable must not blank the net-worth figure.

---

## 1. Position derivation

### Two paths, chosen by account capability, never mixed

```ts
type AccountCapability = 'ledger' | 'snapshot';

interface DerivedPosition {
  readonly accountId: string;
  readonly instrumentId: string;
  readonly quantity: Decimal;          // signed; negative is an error condition, not a short
  readonly asOf: IsoInstant;
  readonly basis: 'folded' | 'snapshot';
  readonly measurement: MeasurementStatus;
  readonly lots: readonly OpenLot[];   // empty when measurement !== 'measured'
  readonly provenance: readonly string[];  // source_document ids, for the UI stamp
}

function derivePositions(input: FoldInput): Result<readonly DerivedPosition[], ValuationError>;

interface FoldInput {
  readonly accountId: string;
  readonly capability: AccountCapability;
  readonly txns: readonly TxnRow[];         // ALL txns for the account, unfiltered
  readonly snapshots: readonly PositionRow[];
  readonly asOf: IsoInstant;
}
```

For `capability = 'snapshot'` the fold is not run at all. The latest `position` row per
`(account_id, instrument_id)` with `as_of <= input.asOf` *is* the position, `measurement` is
`'not_measured'`, `lots` is empty. Snapshot accounts have no cost basis and no realised P&L, and
the engine must not manufacture one from a single observed quantity.

For `capability = 'ledger'` the fold runs and `position` rows are used **only as a reconciliation
check**, never as input. A CAS that reports both a transaction list and a closing balance gives us
an independent verification of our own arithmetic; consuming it as input would throw that away.

### Fold ordering

The fold sorts the entire transaction set — not a window, not a delta — by this key:

1. `date(occurred_at)` in the account's local calendar day (using `occurred_tz` when present,
   `Asia/Kolkata` otherwise). Day granularity, not instant, because statements carry trade dates
   and a 00:00 UTC normalisation would move Indian trades to the previous day.
2. `typeRank`, defined below.
3. `natural_key` ascending, as a deterministic tiebreak. It is a hash, so the order is arbitrary
   but stable across machines and re-imports, which is the only property required.

```
typeRank:  split, bonus            → 0
           transfer_in             → 1
           buy                     → 2
           dividend, interest      → 3
           sell                    → 4
           transfer_out            → 5
           fee, tds                → 6
```

**Corporate actions rank first on their date, before that day's trades.** This is the single most
consequential ordering decision in the fold, and it follows from what the ex-date means: from the
ex-date onward the instrument trades at the adjusted price and statements quote adjusted
quantities. A buy on the ex-date is therefore already expressed in post-split terms and must not
be adjusted again. Ranking the split first means it applies to the lots that existed *before* that
day and to nothing else, which is exactly right.

Buys rank before sells on the same date so that a same-day buy-and-sell does not transiently
exhaust inventory. Fees and TDS rank last because they consume no units.

### Splits

A `split` transaction carries `price = NULL` and, by the convention adopted here, `quantity` = the
**multiplier**: new units per existing unit, as a decimal string. A 1:5 split is `'5'`; a 2:1
reverse split is `'0.5'`. Overloading `quantity` this way is not obvious from the schema and is
raised in [Open questions for core](#open-questions-for-core); ingestion is responsible for
normalising every provider's ratio notation into this form.

The multiplier is used rather than the credited unit delta deliberately: a ratio is a property of
the corporate action and is independent of how many units we think the user held. A delta is only
correct if our holding was already correct, so a delta compounds an earlier error instead of
surviving it.

Applying a split to each open lot:

- `lot.quantity ← lot.quantity × ratio`
- `lot.costMinor` — **unchanged**
- `lot.acquiredOn` — **unchanged**

Total cost is invariant and the acquisition date is preserved, because a split is not an
acquisition. Section 2(42A) holding period continues to run from the original purchase. Unit cost
falls by exactly the ratio as an arithmetic consequence; it is never stored, only derived, so
there is nothing to round and no residue to lose.

### Bonuses

A `bonus` transaction carries `price = NULL` and `quantity` = **units credited**, matching what the
statement says. Bonus units are *not* a rescaling of existing lots. They are a new lot:

- `quantity` = units credited
- `costMinor` = `0n`
- `acquiredOn` = the bonus allotment date
- FIFO order = by `acquiredOn`, so the bonus lot naturally sorts after everything existing

This differs from a split because Indian tax law makes it differ. Section 55(2)(aa)(iiia) fixes the
cost of acquisition of bonus shares at **nil**, and the holding period of a bonus unit runs from
its own allotment date, not from the date of the shares that earned it. Rescaling existing lots the
way a split does would understate both realised gains and the short-term portion of them.

When the source also lets us derive a ratio (a 1:1 bonus on a stated holding), the engine
cross-checks `unitsCredited ≈ holdingBeforeAction × impliedRatio` and emits
`BONUS_UNITS_MISMATCH` on disagreement beyond one unit-precision step. It does not correct the
figure; the statement is the record and a mismatch means our holding was already wrong.

### A split that arrives after later trades are recorded

This is the failure mode the design spec calls out, and the fold's purity is the whole answer.

Suppose the user imports a 2026 broker CSV in January, then in August imports an older CAS that
contains a 2022 split. Because the fold is recomputed from scratch over the full sorted transaction
set, the split lands in its 2022 position on re-fold. Lots opened before the split are multiplied;
the 2024 and 2026 trades — which the broker already reported in post-split units — are untouched,
because the ordering rule places them after the action. The August answer equals the answer we
would have got had the CAS been imported first.

The wrong design, for contrast: adjusting positions incrementally at import time. Import the CSV
first, and the 2026 buy of 100 units sits in the table; import the split later and apply it to
"current holdings" and that buy becomes 500 units. The quantity is overstated fivefold and the
unit cost understated fivefold, and nothing in the database records that it happened. This is why
`recomputeOnWrite` is not an optimisation choice but a correctness requirement.

**Invalidation.** Any write to `txn`, `position`, `instrument` or `instrument_alias` invalidates
the memoised fold for the affected account. The engine memoises in memory, keyed by
`(accountId, maxTxnCreatedAt, txnCount)`; it does not persist derived lots. See open question 9.

### The double-adjustment hazard

Some statement formats restate *pre-split* trades in post-split units — a CAS regenerated after a
split may show the original 2019 purchase as 250 units at ₹144.14 rather than 50 at ₹720.00. If
such a restated trade coexists with an explicit split transaction, the fold multiplies an already
multiplied quantity.

The engine cannot detect this from the ledger alone. It detects it from the reconciliation check:

```ts
interface Reconciliation {
  readonly instrumentId: string;
  readonly foldedQuantity: Decimal;
  readonly snapshotQuantity: Decimal;
  readonly snapshotAsOf: IsoInstant;
  readonly agrees: boolean;         // |folded - snapshot| <= tolerance
  readonly ratio: Decimal;          // folded / snapshot, for diagnosis
}
```

Tolerance is `10^-instrument.precision` — one display step, absolute, not relative. When
`agrees` is false the engine emits `FOLD_SNAPSHOT_MISMATCH` and, if `ratio` is within 0.1% of a
recorded corporate-action multiplier for that instrument, upgrades the message to name double
adjustment as the likely cause. The pair's `measurement` drops to `'not_measured'`: quantity is
reported from the snapshot (it is corroborated), cost basis and P&L are withheld.

Withholding rather than guessing is the point. A cost basis that is wrong by a factor of five looks
plausible on screen and is discovered a year later at tax time.

### Corporate actions are recorded per account

`txn` rows belong to an account, so a market-wide split is recorded once per account holding the
instrument, and only if that account's statement mentioned it. If Zerodha's ledger records the
split and an old CAS for another demat does not, the two accounts' quantities for the same
instrument diverge by the ratio.

The engine detects this after folding all accounts: for each instrument with at least one
corporate-action transaction, any *other* account that held a non-zero quantity of that instrument
across the action date and has no corresponding action row gets
`CORPORATE_ACTION_MISSING_IN_ACCOUNT` and drops to `'not_measured'`. Its quantity is taken from
the most recent snapshot if one exists, and if none exists the position is reported with an
explicit `quantitySuspect: true` flag that the UI must render as unresolved rather than counting
silently.

### Negative inventory and unknown-cost openings

Two ledger defects, handled differently because they are differently recoverable.

**`transfer_in` with `price = NULL`.** Quantity is known, cost is not — a CAS that begins in 2022
for a holding bought in 2015, or an off-market transfer. The fold creates an open lot with
`costKnown: false`, `costMinor: 0n` **which is never used as a cost**, and `acquiredOn` set to the
transfer date. The pair becomes `'partially_measured'`. Quantity and market value are fully
counted in net worth; cost basis, unrealised P&L and XIRR are withheld for the pair. This is
user-fixable — the UI can offer "enter acquisition price" — which is why it is distinguished from
the case below.

**Negative inventory.** A `sell` or `transfer_out` exceeding available units. The fold does not
create a synthetic lot to absorb it. It clamps the running quantity at the correct signed value
(the sell is real; the missing buy is the defect), emits `NEGATIVE_INVENTORY` naming the
transaction, and sets the pair to `'not_measured'`. Cost basis, realised and unrealised P&L are all
withheld for that pair for the whole history, not just after the offending row, because FIFO
ordering upstream of a hole is unreliable.

```ts
type MeasurementStatus =
  | 'measured'              // ledger, complete lot chain, reconciles, all costs known
  | 'partially_measured'    // ledger, but >= 1 lot has costKnown = false
  | 'not_measured';         // snapshot account, negative inventory, or failed reconciliation

interface MeasurementReason { readonly status: MeasurementStatus; readonly code: WarningCode;
                              readonly message: string; readonly userFixable: boolean; }
```

Only `'measured'` counts toward history coverage. `'partially_measured'` withholds the same metrics
as `'not_measured'`; the distinction exists so the UI can tell the user which gaps they can close.

---

## 2. Cost basis — FIFO with lot tracking

FIFO, unconditionally, because Indian tax law gives no choice: for demat-held securities Rule
37BA/CBDT practice and the depositories' own accounting apply first-in-first-out, and mutual fund
registrars compute capital gains statements on FIFO. Specific-lot identification is not available
to Indian investors, so offering it would produce numbers that disagree with the broker's own
capital-gains statement.

```ts
interface OpenLot {
  readonly lotId: string;              // deterministic: hash(accountId, instrumentId, openingTxnId)
  readonly accountId: string;
  readonly instrumentId: string;
  readonly openingTxnId: string;
  readonly acquiredOn: IsoDate;        // drives holding period AND FIFO order
  readonly quantity: Decimal;          // remaining, after splits and prior disposals
  readonly costMinor: Minor;           // remaining cost of the remaining quantity
  readonly currency: Currency;         // native currency; NOT converted
  readonly fxRate: Decimal | null;     // txn.fx_rate at acquisition, for XIRR
  readonly costKnown: boolean;
  readonly origin: 'buy' | 'transfer_in' | 'bonus' | 'synthetic_opening';
}

function buildLots(input: FoldInput): Result<LotLedger, ValuationError>;

interface LotLedger {
  readonly open: readonly OpenLot[];        // FIFO order: acquiredOn, then openingTxnId
  readonly disposals: readonly Disposal[];  // chronological
  readonly measurement: MeasurementStatus;
}
```

### What enters cost

Cost of a lot at opening is `amount_minor + fees_minor` for a `buy`. Fees are capitalised because
brokerage and statutory charges on purchase form part of the cost of acquisition under section 48.

On disposal, `fees_minor` is deducted from the full value of consideration as expenditure incurred
wholly and exclusively in connection with the transfer.

**Known divergence from strict section 48.** The proviso to section 48 disallows Securities
Transaction Tax as a deduction, on either leg. `txn.fees_minor` is a single lumped figure with no
breakdown, so the engine cannot exclude STT. Misal's realised-gain figures therefore differ from a
strict computation by the STT component — a few basis points, always in the taxpayer-favourable
direction. This is disclosed in the UI next to the realised P&L figure and recorded as open
question 3. It is not silently absorbed.

### Partial disposals

A disposal consuming part of a lot must split the lot's cost without losing or inventing a paisa.
Proportional multiplication in decimal then rounding both halves does not guarantee that; integer
allocation does:

```
consumedCostMinor = (lotCostMinor * consumedQtyScaled) / lotQtyScaled     // truncating bigint div
residualCostMinor = lotCostMinor - consumedCostMinor
```

where `consumedQtyScaled` and `lotQtyScaled` are both quantities scaled by `10^k` for a common
`k` large enough to make them integers (`k = max(dp(consumedQty), dp(lotQty))`, capped at 18).
The residual is computed by **subtraction, never by a second multiplication**. That single choice
is what makes the invariant `Σ consumedCost + residualCost = originalCost` hold exactly for any
sequence of partial disposals, and it is the first property test in
[Testing](#testing).

Truncation rather than half-up rounding biases each consumed slice down by at most one paise,
which lands in the residual and is realised on the final disposal of the lot. The total is exact;
only its timing shifts by at most one paise per partial disposal.

### Pre-31-January-2018 grandfathering

Applies to assets covered by section 112A — listed equity shares and units of equity-oriented
mutual funds on which STT was paid — **acquired before 1 February 2018**. Section 55(2)(ac):

> Cost of acquisition = **max( actual cost , min( FMV as on 31 Jan 2018 , full value of
> consideration ) )**

Four things this rule requires that are easy to get wrong:

1. **FMV is the highest price quoted on any recognised stock exchange in India on 31 January
   2018**, not the closing price. For units of an unlisted mutual fund it is the NAV as on that
   date. If 31 January 2018 had no trading in the scrip, FMV is the highest price on the last
   preceding date on which it traded.
2. **The comparison is per unit, applied per lot.** A sale spanning a pre-2018 lot and a post-2018
   lot grandfathers only the first.
3. **"Full value of consideration" is gross**, before deducting transfer expenses. Transfer
   expenses are deducted afterwards, under section 48. Using net consideration inside the `min()`
   understates the deemed cost and overstates the gain.
4. **The rule can only reduce a gain to zero, never create a loss.** That is a consequence of the
   `min()` against consideration, not a separate clamp — when consideration is below FMV the deemed
   cost equals consideration and the gain is exactly nil. The engine must not add its own clamp;
   an implementation that produces a negative grandfathered gain has a bug in the `min()`.

Grandfathering applies only to the **long-term** classification. A pre-2018 lot is by construction
held over twelve months, so in practice every grandfathered disposal is LTCG.

```ts
interface GrandfatherInput {
  readonly assetClass: AssetClass;
  readonly lotAcquiredOn: IsoDate;
  readonly actualUnitCost: Decimal;
  readonly fmv31Jan2018: Decimal | null;      // null = not available
  readonly grossUnitConsideration: Decimal;
}

type GrandfatherOutcome =
  | { readonly applied: false; readonly reason: 'not_112a' | 'acquired_after_cutoff' }
  | { readonly applied: true;  readonly deemedUnitCost: Decimal; readonly fmvUsed: Decimal }
  | { readonly applied: 'blocked'; readonly reason: 'fmv_unavailable' };

function grandfatheredUnitCost(input: GrandfatherInput): GrandfatherOutcome;
```

`'blocked'` is not a failure to compute — it is a refusal. When a section 112A lot predates the
cutoff and no FMV is on hand, the engine does **not** fall back to actual cost. Falling back
overstates the taxable gain by the entire 2001–2018 appreciation, which for a long-held Indian
equity is routinely 5–10×. The disposal is reported with `taxTreatment: 'unavailable'`, the pair
drops out of realised-P&L coverage, and the UI prompts the user to supply the 31 January 2018
price. Withholding is the only honest option here.

### Worked example — FIFO with a partial disposal and grandfathering

Instrument: `indian_equity`, INFY, INR. FMV on 31 Jan 2018 taken as ₹1,130.00.

| # | Date | Type | Qty | Price | Fees | Amount |
|---|---|---|---|---|---|---|
| 1 | 2017-03-15 | buy | 100 | 500.00 | ₹40.00 | ₹50,000.00 |
| 2 | 2019-06-10 | buy | 50 | 720.00 | ₹35.20 | ₹36,000.00 |
| 3 | 2026-06-20 | sell | 120 | 1,540.00 | ₹180.00 | ₹1,84,800.00 |

Lots after transactions 1 and 2:

```
Lot A  acquired 2017-03-15  qty 100  cost 5,004,000 paise  (₹50,040.00)  unit ₹500.40
Lot B  acquired 2019-06-10  qty  50  cost 3,603,520 paise  (₹36,035.20)  unit ₹720.704
```

The sale of 120 consumes Lot A entirely and 20 of Lot B.

**Apportionment.** Gross consideration is 120 × ₹1,540.00 = ₹1,84,800.00. Transfer expenses of
₹180.00 are apportioned pro rata by units: Lot A gets 100/120 × ₹180 = ₹150.00, Lot B gets the
remainder, ₹30.00 (again by subtraction, so the ₹180 is fully allocated).

**Lot A — grandfathered.** Acquired before 1 Feb 2018, section 112A asset.

```
actual unit cost              ₹  500.40
FMV 31-Jan-2018               ₹1,130.00
gross unit consideration      ₹1,540.00
min(FMV, consideration)       ₹1,130.00
deemed unit cost = max(500.40, 1130.00) = ₹1,130.00
deemed cost   = 100 × 1,130.00      = ₹1,13,000.00
FVC           = 100 × 1,540.00      = ₹1,54,000.00
gain          = 154,000.00 − 150.00 − 113,000.00 = ₹40,850.00     LTCG
```

Without grandfathering the same disposal would show a gain of ₹1,03,850.00 — 2.54× the correct
figure. This is the magnitude of the error being prevented.

**Lot B — partial, no grandfathering.** Acquired 2019-06-10, after the cutoff.

```
integer allocation: consumed = 3,603,520 × 20 / 50 = 1,441,408 paise  (₹14,414.08)
                    residual = 3,603,520 − 1,441,408 = 2,162,112 paise (₹21,621.12)
FVC  = 20 × 1,540.00 = ₹30,800.00
gain = 30,800.00 − 30.00 − 14,414.08 = ₹16,355.92                    LTCG
```

**Result.** Realised LTCG ₹57,205.92, split ₹40,850.00 + ₹16,355.92. One open lot remains:

```
Lot B  acquired 2019-06-10  qty 30  cost 2,162,112 paise (₹21,621.12)  unit ₹720.704
```

Note that `1,441,408 + 2,162,112 = 3,603,520` exactly, and that the surviving unit cost is
unchanged at ₹720.704 — both are asserted directly by the property tests.

### Worked example — split, then bonus

Continuing with Lot B as it stood before the sale (50 units, ₹36,035.20), for a different
instrument on the same rules.

```
2022-09-15  split 1:5   (txn.quantity = '5')
2022-09-15  buy 100 @ ₹150.00, fees ₹12.00
2023-03-10  bonus 1:1   (txn.quantity = '250', units credited)
```

Ordering places the split at rank 0 and the buy at rank 2, so on 2022-09-15 the split runs first:

```
before  Lot B  qty  50   cost 3,603,520  unit ₹720.704   acquired 2019-06-10
after   Lot B  qty 250   cost 3,603,520  unit ₹144.1408  acquired 2019-06-10   ← date unchanged
then    Lot C  qty 100   cost 1,501,200  unit ₹150.12    acquired 2022-09-15   ← not adjusted
```

Had the split been applied after the buy — or applied incrementally on a later import — Lot C
would read 500 units at ₹30.024. The quantity would be overstated by 400 units and every
subsequent FIFO disposal would draw against fictitious inventory.

The bonus on 2023-03-10 creates a third lot rather than rescaling:

```
Lot D  qty 250  cost 0 paise  unit ₹0.00  acquired 2023-03-10  origin 'bonus'  costKnown: true
```

Total quantity 600, total cost ₹51,047.20, weighted average unit cost ₹85.0787. Lot D's holding
period starts 2023-03-10, so a disposal on, say, 2023-09-01 that reached into Lot D would be STCG
on that slice even though Lots B and C are long-term. That is the correct answer and it is only
reachable because the bonus is a separate dated lot.

Note the interaction with grandfathering: a bonus lot allotted before 1 February 2018 has an actual
cost of nil, so `max(0, min(FMV, consideration))` grandfathers it to the full FMV. Bonus shares are
the case where grandfathering matters most, and the two rules compose without a special case.

---

## 3. Realised and unrealised P&L

### Unrealised

```ts
interface UnrealisedPnL {
  readonly instrumentId: string;
  readonly accountId: string;
  readonly quantity: Decimal;
  readonly costMinor: Minor;          // in INR, at each lot's own historical fx_rate
  readonly marketValueMinor: Minor;   // in INR, at the current fx rate
  readonly pnlMinor: Minor;
  readonly pnlPct: Decimal | null;    // null when costMinor === 0n (bonus-only holdings)
  readonly priceAge: PriceAge;
  readonly measurement: MeasurementStatus;
}
```

Cost is converted at each lot's acquisition-date FX rate; market value at the current rate. The
difference between the two is a real economic gain or loss on a USD holding and must not be
netted out by converting both at the same rate. `pnlPct` is `null`, never `0`, when cost is zero —
a bonus-only holding has an infinite percentage return, and displaying `0%` reads as "flat".

Unrealised P&L is emitted only for `measurement === 'measured'`. For every other status the field
is absent and the UI renders "not measured" with the reason string.

### Realised, and the STCG/LTCG split

```ts
interface Disposal {
  readonly disposalTxnId: string;
  readonly lotId: string;
  readonly instrumentId: string;
  readonly accountId: string;
  readonly quantity: Decimal;
  readonly acquiredOn: IsoDate;
  readonly disposedOn: IsoDate;
  readonly holdingDays: number;
  readonly grossConsiderationMinor: Minor;   // before transfer expenses
  readonly transferExpensesMinor: Minor;     // apportioned
  readonly costMinor: Minor;                 // actual, before grandfathering
  readonly deemedCostMinor: Minor;           // after grandfathering; === costMinor if not applied
  readonly gainMinor: Minor;
  readonly grandfathered: boolean;
  readonly bucket: GainBucket;
  readonly financialYear: string;            // 'FY2026-27'
}

type GainBucket =
  | { readonly kind: 'stcg'; readonly regime: TaxRegime }
  | { readonly kind: 'ltcg'; readonly regime: TaxRegime }
  | { readonly kind: 'vda' }                 // section 115BBH — no ST/LT distinction exists
  | { readonly kind: 'unavailable'; readonly reason: WarningCode };
```

Holding period is `disposedOn − acquiredOn` in **days**, and the long-term test is on completed
months per section 2(42A): a listed security is long-term when held for *more than* twelve months,
counted calendar-wise from the day after acquisition. The engine implements this as a calendar
comparison (`disposedOn > addMonths(acquiredOn, threshold)`), not as `holdingDays > 365`, because
the day-count form misclassifies February-spanning holdings by a day.

The Indian financial year runs 1 April to 31 March. `financialYear` is derived from `disposedOn`.

### Tax classification rules

Researched as of 2026-08-12. **These are classification rules for reporting, not a tax
computation** — see [Out of scope](#out-of-scope). They live in a versioned table keyed by
effective date because the pivot dates matter: the Finance (No. 2) Act 2024 changed rates and
holding periods for transfers **on or after 23 July 2024**, and section 50AA's amended definition
of a specified mutual fund bites from AY 2026-27.

```ts
interface TaxRule {
  readonly regime: TaxRegime;
  readonly effectiveFrom: IsoDate;
  readonly effectiveTo: IsoDate | null;
  readonly longTermThresholdMonths: number | null;  // null = no LT bucket exists
  readonly shortTermRate: RateSpec;
  readonly longTermRate: RateSpec;
  readonly annualExemptionMinor: Minor | null;      // 112A only
  readonly grandfatherEligible: boolean;
  readonly note: string;
}

type TaxRegime =
  | 's112a_listed_equity'      // listed equity shares + equity-oriented MF units, STT paid
  | 's50aa_specified_mf'       // units bought on/after 1-Apr-2023 in >65%-debt funds
  | 'other_mf_listed'          // listed non-equity units, e.g. gold ETFs
  | 'other_mf_unlisted'        // unlisted non-equity units, e.g. gold/international FoFs
  | 'foreign_equity'           // US shares, RSUs, ESPP — unlisted for Indian purposes
  | 's115bbh_vda'              // crypto and other virtual digital assets
  | 'other_asset';             // physical gold, bonds, everything else

type RateSpec =
  | { readonly kind: 'flat'; readonly pct: Decimal }
  | { readonly kind: 'slab' }                        // depends on the user's slab; not computed
  | { readonly kind: 'not_applicable' };
```

Seeded rules for v1:

| Regime | LT threshold | Short-term | Long-term | GF |
|---|---|---|---|---|
| `s112a_listed_equity` | 12 months | 20% [a] | 12.5% above ₹1,25,000/FY [b] | yes |
| `s50aa_specified_mf` | none [c] | slab | n/a | no |
| `other_mf_listed` | 12 months | slab | 12.5% | no |
| `other_mf_unlisted` | 24 months | slab | 12.5% | no |
| `foreign_equity` | 24 months | slab | 12.5% [d] | no |
| `s115bbh_vda` | n/a | **30% flat**, no ST/LT split [e] | n/a | no |
| `other_asset` | 24 months | slab | 12.5% | no |

- **[a]** 15% for transfers before 23-Jul-2024. No indexation in either period.
- **[b]** 10% above ₹1,00,000/FY for transfers before 23-Jul-2024.
- **[c]** Units acquired on or after 1-Apr-2023 in funds investing more than 65% of proceeds in
  debt and money-market instruments are deemed short-term regardless of holding period.
- **[d]** US shares, RSUs and ESPP are unlisted assets for Indian tax purposes. Listed units such
  as gold ETFs fall under `other_mf_listed`; unlisted gold and international fund-of-funds under
  `other_mf_unlisted`.
- **[e]** Only the cost of acquisition is deductible. Losses cannot be set off against any income,
  including other VDA gains, and cannot be carried forward. 1% TDS under section 194S.

**Virtual digital assets are structurally different and the engine must not pretend otherwise.**
Section 115BBH taxes VDA gains at a flat 30% with no holding-period distinction, no deduction other
than cost of acquisition, and — crucially for a portfolio tool — **no set-off of losses**, whether
against other VDA gains or anything else, and no carry-forward. The engine therefore reports crypto
in a separate `vda` bucket and **never nets losses against gains inside it**. `VdaSummary` carries
`grossGainMinor` and `grossLossMinor` as two figures. A single netted "crypto P&L" number would
understate the taxable base, sometimes to zero, and is exactly the kind of plausible-looking wrong
answer this project exists to avoid. FIFO lot tracking still runs on crypto — cost of acquisition is
deductible and must be tracked — but the buckets do not merge.

TDS under section 194S is deducted at 1% of consideration by the exchange, at ₹50,000 per year for
individuals and ₹10,000 otherwise. It arrives in the ledger as a `tds` transaction. It is **not** an
expense of transfer and does not reduce the gain; it is a prepayment of tax. The engine accumulates
it into `tdsCreditMinor` for display and subtracts it from cashflows in XIRR (the money did leave
the account) but never from `gainMinor`.

```ts
interface RealisedSummary {
  readonly financialYear: string;
  readonly byRegime: ReadonlyMap<TaxRegime, RegimeSummary>;
  readonly vda: VdaSummary;
  readonly dividendIncomeMinor: Minor;      // taxed at slab; not a capital gain
  readonly interestIncomeMinor: Minor;
  readonly tdsCreditMinor: Minor;
  readonly unavailableDisposals: readonly DisposalRef[];   // could not be classified
  readonly coverage: MetricCoverage;
}

interface RegimeSummary {
  readonly stcgMinor: Minor;                // net of losses within the regime
  readonly ltcgMinor: Minor;
  readonly exemptionAppliedMinor: Minor;    // 112A ₹1.25L, informational only
}

interface VdaSummary {
  readonly grossGainMinor: Minor;
  readonly grossLossMinor: Minor;           // reported, NEVER netted against gains
  readonly disposalCount: number;
}
```

The ₹1,25,000 section 112A exemption is reported as `exemptionAppliedMinor` with an explicit
"informational" label. It is a per-assessee annual figure that also covers gains realised outside
Misal, so the application cannot know how much of it remains. Presenting it as consumed would be
wrong for any user with holdings elsewhere.

---

## 4. XIRR

XIRR is the internal rate of return over irregularly dated cashflows — the only return figure that
is honest about SIPs, top-ups and partial redemptions. It is computed **only for scopes that are
fully `measured`**, because a cashflow series with a hole in it produces a number that looks fine
and is wrong.

### Cashflow construction

```ts
interface Cashflow {
  readonly date: IsoDate;
  readonly amountMinor: Minor;        // INR, signed: negative = money in, positive = money out
  readonly fxRate: Decimal;
  readonly fxSource: 'txn' | 'daily_table';
  readonly origin: 'txn' | 'terminal';
  readonly txnId?: string;
}

function buildCashflows(input: XirrInput): Result<readonly Cashflow[], XirrError>;
function xirr(flows: readonly Cashflow[], opts?: XirrOptions): Result<XirrOutcome, XirrError>;
```

Sign convention: an investor outflow (money leaving the investor into the investment) is a
**negative** cashflow; money returned to the investor is **positive**. Mapping from transaction
types:

| Type | Cashflow |
|---|---|
| `buy` | `−(amount_minor + fees_minor) × fx_rate` |
| `sell` | `+(amount_minor − fees_minor) × fx_rate` |
| `dividend`, `interest` | `+amount_minor × fx_rate` |
| `fee` | `−amount_minor × fx_rate` |
| `tds` | `−amount_minor × fx_rate` — the cash left the account |
| `transfer_in` with a price | `−(quantity × price) × fx_rate` |
| `transfer_in` without a price | **blocks XIRR for the scope** (`MISSING_ACQUISITION_COST`) |
| `transfer_out` | `+(quantity × current price) × fx_rate` at the transfer date |
| `split`, `bonus` | no cashflow — no money moves |
| — | terminal: `+marketValue(asOf)` at the current FX rate |

**Each cashflow uses the `fx_rate` stored on its own transaction.** This is the reason the column
exists. A user who vested RSUs at ₹68/USD in 2019 and holds them at ₹88/USD today has earned a real
currency return; converting the whole series at today's rate erases it, and converting at the
average rate invents one. When `txn.fx_rate` is null and the transaction currency is not INR, the
engine looks for an `fx_rate` row for that date, uses it with `fxSource: 'daily_table'` and emits
`FX_RATE_IMPUTED`. If neither exists, XIRR fails with `MISSING_FX` naming the transaction ids —
it does **not** fall back to the current rate.

The terminal cashflow is the market value of the open position at `asOf`, converted at the current
FX rate, which is correct: it is the amount the investor would receive today.

### Scopes

XIRR is offered at three scopes, each requiring every constituent pair to be `measured`:
portfolio, account, and (account, instrument). A scope containing any non-`measured` pair returns
`SCOPE_NOT_MEASURED` listing the offending pairs, rather than an XIRR over the measurable subset —
a partial XIRR silently answers a different question from the one the label implies.

### Numerical method and its guarantees

NPV as a function of the rate:

```
NPV(r) = Σ_i  cf_i / (1 + r)^(t_i / 365)          t_i = days(date_i − date_0),  r > −1
```

Actual/365 fixed. Not actual/actual, not 30/360 — 365 is what Excel's and LibreOffice's `XIRR`
use, and matching the tool users will check against matters more than calendar purity.

**Existence and uniqueness.** If the cashflow sequence, in date order, changes sign exactly once
(Norström's criterion: all cashflows before some index are of one sign, all after of the other, and
the total sum has the sign of the later group), then `NPV(r)` is strictly monotonic on `(−1, ∞)`
and has exactly one root. This holds for essentially every real portfolio — money goes in, then
value comes out at the terminal flow — and the engine tests for it explicitly:

```ts
type SignPattern = 'single_change' | 'multiple_changes' | 'all_same_sign' | 'empty';
function classifySigns(flows: readonly Cashflow[]): SignPattern;
```

- `'empty'` or fewer than two flows → `INSUFFICIENT_CASHFLOWS`.
- `'all_same_sign'` → `NO_SIGN_CHANGE`. No root exists. This is not a numerical failure; it is a
  portfolio with only purchases and no value, which means the terminal flow is missing — usually a
  missing price.
- `'multiple_changes'` → a root may not be unique. The engine still solves, brackets over
  `[−0.9999, 10]` first, and returns the outcome with `uniquenessGuaranteed: false`. The UI must
  render this differently. It does not return the first root found as though it were the answer.

**Algorithm: bracketed Newton with bisection fallback.** Newton alone can leave the domain
(`r ≤ −1`) or oscillate; bisection alone is reliable but slow. The composite is both.

1. Bracket. Evaluate `NPV` at `r ∈ {−0.9999, −0.9, −0.5, 0, 0.1, 0.5, 1, 3, 10, 100}` and take the
   first adjacent pair with opposite signs. If none, expand once to `10^4`. If still none, return
   `NO_BRACKET`.
2. Iterate from the bracket midpoint (not from a fixed 0.1 guess — a fixed guess outside the
   bracket is how these routines diverge). Each step takes the Newton update
   `r ← r − NPV(r)/NPV'(r)`; if the update falls outside the current bracket or `|NPV'(r)|` is
   below `10^-20`, take a bisection step instead. Update the bracket from the sign of `NPV(r)`.
3. Stop when `|NPV(r)| / Σ|cf_i| < 10^-12` **and** `|Δr| < 10^-12`. The residual is scaled by the
   gross cashflow magnitude so the tolerance means the same thing for a ₹10,000 SIP and a ₹10
   crore portfolio.
4. Cap at 100 iterations. Bisection alone would need ~60 from the widest bracket to reach `10^-12`,
   so 100 is generous for the composite and a hit means something is pathological. Return
   `NOT_CONVERGED` with the last iterate and residual attached for diagnosis.

All arithmetic is `Decimal` at precision 40. `Decimal.pow` with a non-integer exponent is exact to
the configured precision, so no step falls back to floating point.

```ts
interface XirrOutcome {
  readonly rate: Decimal;                    // annualised, as a fraction: 0.0934 = 9.34%
  readonly iterations: number;
  readonly residual: Decimal;                // |NPV| at the root, scaled
  readonly uniquenessGuaranteed: boolean;
  readonly horizonDays: number;
  readonly unstable: boolean;                // horizonDays < 90 or |rate| > 10
  readonly cashflowCount: number;
}

type XirrError =
  | { readonly code: 'INSUFFICIENT_CASHFLOWS'; readonly count: number }
  | { readonly code: 'NO_SIGN_CHANGE' }
  | { readonly code: 'NO_BRACKET'; readonly probed: readonly string[] }
  | { readonly code: 'NOT_CONVERGED'; readonly lastRate: string; readonly residual: string }
  | { readonly code: 'MISSING_FX'; readonly txnIds: readonly string[] }
  | { readonly code: 'MISSING_PRICE'; readonly instrumentIds: readonly string[] }
  | { readonly code: 'MISSING_ACQUISITION_COST'; readonly txnIds: readonly string[] }
  | { readonly code: 'SCOPE_NOT_MEASURED'; readonly pairs: readonly PairRef[] };
```

`unstable` flags results that are arithmetically correct but meaningless to display: annualising a
three-week holding produces figures like 4,000%, and an XIRR above 1,000% almost always means a
tiny early cashflow. The number is returned with the flag; the UI renders it with a caveat rather
than the engine hiding it.

**Every failure mode returns an `Err`. None returns zero.** A displayed XIRR of 0.00% is
indistinguishable from a genuinely flat portfolio, and that ambiguity is unacceptable in the one
metric users will quote at each other.

### Worked example — XIRR

```
2024-04-01   buy    ₹1,00,000.00   →  cashflow  −100000.00
2025-04-01   buy    ₹  50,000.00   →  cashflow  − 50000.00
2026-08-12   value  ₹1,80,000.00   →  terminal  +180000.00     (valuation date)
```

Day offsets from 2024-04-01: 0, 365, 863. Exponents `t/365`: 0, 1, 2.3643835616438356…

Probing the bracket: `NPV(0.00) = +30,000.00` (positive), `NPV(0.10) = −1,771.90` (negative), so
the root lies in `(0, 0.10)`. Newton from there:

| iter | r | NPV(r) | NPV′(r) |
|---|---|---|---|
| 0 | 0.1000000000 | −1,771.898277 | −267,514.86 |
| 1 | 0.0933764491 | +19.245148 | −273,352.32 |
| 2 | 0.0934468533 | +0.002214 | −273,289.44 |
| 3 | 0.0934468614 | +0.000000 | −273,289.43 |

**XIRR = 0.09344686138761808… → 9.3447%** (scaled residual 1.6 × 10^-32, three Newton steps, no
bisection fallback taken).

Sanity checks worth asserting: the total contributed is ₹1,50,000 against ₹1,80,000 of value, a 20%
absolute gain, and the money was in for between 1.0 and 2.36 years — so any XIRR outside roughly
8%–20% would be wrong on its face. The naive "20% over 2.36 years" annualisation gives 8.0%, lower
than the true 9.34% because half the money arrived a year late. That gap is precisely what XIRR
exists to capture, and a golden test asserts the exact figure to 10 decimal places.

---

## 5. Coverage metrics

This is a headline feature. The calibration bar and the "not measured" rows are the mechanisms by
which Misal claims to be honest, so their arithmetic gets the same scrutiny as net worth itself.

### The denominators, stated exactly

Three distinct rupee quantities, which must never be conflated:

```ts
interface ValueBreakdown {
  readonly valuedMinor: Minor;      // Σ market value of positions with resolved instrument,
                                    //   usable price and usable FX. THIS IS NET WORTH.
  readonly withheldMinor: Minor;    // Σ unresolved_instrument.observed_value_minor
                                    //   (resolved_at IS NULL), converted to INR at current FX
  readonly unpricedCount: number;   // positions with a resolved instrument but NO usable price
  readonly unpricedInstrumentIds: readonly string[];
}
```

- **`valuedMinor` is net worth.** Withheld value is deliberately excluded: attributing value to an
  instrument we cannot identify is the double-counting failure the design spec names as the worst
  outcome available.
- **`withheldMinor` is displayed beside net worth, never inside it.** `unresolved_instrument.
  observed_value_minor` exists in the schema for exactly this and is what makes the figure exact
  rather than an estimate.
- **Unpriced positions contribute nothing to any rupee figure and cannot.** There is no value to
  add. They are reported as a count and an instrument list, and they cap the priced-coverage
  metric below 100%. Valuing them at cost, or at the last snapshot, would be an estimate presented
  as a measurement.

### History coverage

The headline figure, and the one the calibration bar renders on a real rupee scale.

```
measuredMinor    = Σ marketValue(pair)  over pairs where measurement === 'measured'
historyCoverage  = measuredMinor / valuedMinor
```

A "pair" is an `(accountId, instrumentId)` tuple. Coverage is **value-weighted, not count-
weighted**: a user with forty small ledger-backed holdings and one large snapshot holding has low
coverage, and a count-weighted figure would claim 97%. The bar shows rupees for the same reason.

Computation, exactly:

```ts
function historyCoveragePct(measuredMinor: Minor, valuedMinor: Minor): Decimal | null;
```

- `valuedMinor === 0n` → returns `null`. The UI renders `—`. Never `0%`, which reads as "nothing is
  covered" rather than "there is nothing to cover".
- Otherwise `pct = (measuredMinor × 10000n) / valuedMinor` as bigint division, then `/100` as a
  `Decimal` — two decimal places, derived without floating point.
- **Display clamping.** If `measuredMinor < valuedMinor` the displayed value is capped at `99.99`,
  and if `measuredMinor > 0n` it is floored at `0.01`. A bar reading "100% covered" when ₹400 of a
  ₹40 lakh portfolio is unmeasured is a lie by rounding, and it is the single most likely way this
  feature loses the user's trust. `100.00` is reachable **only** when
  `measuredMinor === valuedMinor` exactly, and `0.00` only when `measuredMinor === 0n`.

### Per-metric coverage

Different metrics need different things, so one coverage number cannot serve them all.

```ts
interface MetricCoverage {
  readonly metric: 'cost_basis' | 'unrealised_pnl' | 'realised_pnl' | 'xirr' | 'day_change';
  readonly coveredMinor: Minor;
  readonly totalMinor: Minor;                 // valuedMinor
  readonly pct: Decimal | null;
  readonly excludedPairs: readonly ExcludedPair[];
  readonly excludedValueMinor: Minor;
}

interface ExcludedPair { readonly accountId: string; readonly instrumentId: string;
                         readonly valueMinor: Minor; readonly reason: MeasurementReason; }
```

Inclusion rules per metric:

| Metric | Included when |
|---|---|
| `cost_basis` | pair is `measured` |
| `unrealised_pnl` | pair is `measured` **and** has a usable current price |
| `realised_pnl` | pair is `measured` **and** every disposal in the period classified — no `unavailable` bucket, so no blocked grandfathering and no unknown regime |
| `xirr` | pair is `measured`, every transaction has a usable FX rate, and a terminal price exists |
| `day_change` | pair has both a current price and a prior-close price from the same source |

`excludedPairs` is not a diagnostic afterthought; the UI's "which metrics exclude what" panel
renders it directly, and `excludedValueMinor` is the rupee figure shown next to each metric. Every
exclusion carries a `MeasurementReason` with a `userFixable` flag so the panel can sort actionable
gaps first.

The headline "history coverage" quoted next to the calibration bar is the `cost_basis` figure,
because that is the metric the bar's ledger/snapshot boundary literally depicts.

### Coverage report

```ts
interface CoverageReport {
  readonly asOf: IsoInstant;
  readonly breakdown: ValueBreakdown;
  readonly historyCoveragePct: Decimal | null;
  readonly measuredMinor: Minor;
  readonly unmeasuredMinor: Minor;            // valuedMinor − measuredMinor, by subtraction
  readonly perMetric: readonly MetricCoverage[];
  readonly stalePriceCount: number;
  readonly stalestPriceAgeDays: number | null;
  readonly unresolvedInstrumentCount: number;
  readonly withheldMinor: Minor;
}
```

`unmeasuredMinor` is computed by subtraction from the same total the bar draws, so the two segments
of the calibration bar sum to the whole bar exactly, with no rounding gap at the boundary. Summing
two independently rounded halves is how a full-width bar ends up one pixel short.

---

## 6. Price service

### The interface

```ts
interface PriceProvider {
  readonly id: PriceSource;                       // 'amfi' | 'twelvedata' | 'manual'
  readonly capabilities: ProviderCapabilities;

  /** Pure predicate over instrument metadata and aliases. No I/O. */
  supports(instrument: InstrumentRef): boolean;

  /** Latest available price. Batched; the batch is the unit of rate limiting. */
  fetchLatest(refs: readonly InstrumentRef[],
              signal: AbortSignal): Promise<readonly QuoteResult[]>;

  /** Historical closes, inclusive range. Used for the 12-month net-worth chart. */
  fetchHistory(ref: InstrumentRef, from: IsoDate, to: IsoDate,
               signal: AbortSignal): Promise<Result<readonly HistoricalClose[], ProviderError>>;

  /** Optional. Only providers that serve FX implement this. */
  fetchFx?(pairs: readonly FxPair[], on: IsoDate | 'latest',
           signal: AbortSignal): Promise<readonly FxQuoteResult[]>;
}

interface ProviderCapabilities {
  readonly assetClasses: readonly AssetClass[];
  readonly requiresApiKey: boolean;
  readonly latency: 'realtime' | 'delayed' | 'eod';
  readonly supportsHistory: boolean;
  readonly supportsFx: boolean;
  readonly rateLimit: RateLimit | null;
}

interface RateLimit { readonly perMinute: number; readonly perDay: number;
                      readonly creditsPerSymbol: number; }

type QuoteResult =
  | { readonly ok: true; readonly ref: InstrumentRef; readonly price: UnitPrice;
      readonly asOf: IsoDate; readonly previousClose: UnitPrice | null }
  | { readonly ok: false; readonly ref: InstrumentRef; readonly error: ProviderError };

type ProviderError =
  | { readonly code: 'NOT_SUPPORTED' }              // provider does not cover this instrument
  | { readonly code: 'NOT_FOUND' }                  // symbol unknown to the provider
  | { readonly code: 'PLAN_RESTRICTED'; readonly detail: string }   // HTTP 403
  | { readonly code: 'RATE_LIMITED'; readonly retryAfterMs: number }// HTTP 429
  | { readonly code: 'AUTH_FAILED' }                                // HTTP 401
  | { readonly code: 'OFFLINE' }
  | { readonly code: 'MALFORMED_RESPONSE'; readonly detail: string }
  | { readonly code: 'UPSTREAM'; readonly status: number };
```

`fetchLatest` returns a per-symbol result array rather than throwing, because one unknown ticker in
a batch of forty must not lose the other thirty-nine — the same rule as ingestion's "one bad row
never fails an import".

### Registry and resolution order

```ts
interface PriceService {
  register(provider: PriceProvider): void;
  /** Writes into `price`; returns what changed and what failed. Explicit action only. */
  refresh(scope: RefreshScope, signal: AbortSignal): Promise<RefreshReport>;
  /** Pure read from the local `price` table. Never fetches. */
  priceAt(instrumentId: string, on: IsoDate | 'latest'): Result<PricePoint, PriceError>;
}

type PriceError =
  | { readonly code: 'NO_PRICE'; readonly instrumentId: string }
  | { readonly code: 'NO_PRICE_SOURCE'; readonly instrumentId: string }   // no provider supports it
  | { readonly code: 'PRICE_CURRENCY_MISMATCH'; readonly expected: Currency;
      readonly got: Currency };
```

Resolution order for a read is **manual → provider → none**. There is no fourth option; an
instrument with no price row and no supporting provider yields `NO_PRICE_SOURCE`, which is a
distinct condition from `NO_PRICE` (supported, just never fetched) because only the former is
permanent and needs a manual override to fix.

**Manual override precedence is enforced on write, because the schema cannot express it on read.**
`price`'s primary key is `(instrument_id, as_of)`, so there is at most one row per instrument-date
and a fetched value would overwrite a manual one. The write rule is therefore: an insert with
`source != 'manual'` must not replace an existing row whose `source = 'manual'`. Concretely, the
upsert carries a `WHERE excluded.source = 'manual' OR price.source != 'manual'` guard. The cost is
that setting a manual override discards the fetched value for that date with no way back except
re-fetching; that is recorded as open question 4.

### AMFI — mutual fund NAVs, keyless

The daily file, verified live on 2026-08-12:

```
https://portal.amfiindia.com/spages/NAVAll.txt
```

Semicolon-delimited, roughly 10 MB, one line per scheme. Header:

```
Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date
```

Interspersed with blank lines, scheme-category headings
(`Open Ended Schemes(Debt Scheme - Banking and PSU Fund)`) and fund-house names
(`Aditya Birla Sun Life Mutual Fund`) as bare lines. Sample rows:

```
119551;INF209KA12Z1;INF209KA13Z9;Aditya Birla Sun Life Banking & PSU Debt Fund - DIRECT - IDCW;107.1766;11-Aug-2026
128952;INF846K01NF8;-;Axis Banking & PSU Debt Fund - Direct Plan - Bonus Option;1532.8272;14-Jun-2017
```

Parsing rules:

- A line is a data row iff it contains exactly five `;` separators. Everything else is a heading or
  a blank and is skipped. Do not parse by position or by tracking section state; the section
  structure changes without notice and a positional parser breaks silently.
- `-` in an ISIN column means absent, not a value.
- The date is `DD-MMM-YYYY` with an English month abbreviation, in IST. Note the second sample row:
  **a scheme's date can be years stale** when the scheme is discontinued. Staleness is per-row, and
  the file's own freshness says nothing about a given scheme's.
- NAV is a decimal string and is stored as such. It is never parsed to a float, not even for a
  range check.
- Match to instruments by ISIN (checking both ISIN columns against `instrument_alias` with
  `scheme = 'isin'`), then by AMFI scheme code (`scheme = 'amfi'`). A row matching nothing is
  ignored — the file covers every scheme in India and most are irrelevant.

Historical NAVs, for the twelve-month chart and for backfilling:

```
https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt=03-Aug-2026&todt=04-Aug-2026&mf=53
```

Maximum 90 days per request. **The historical file has a different column order and eight columns,
not six** — verified 2026-08-12:

```
Scheme Code;Scheme Name;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Net Asset Value;Repurchase Price;Sale Price;Date
```

The parser must therefore select its column mapping from the header line it actually reads, not
from which URL it requested. Assuming the daily layout on a historical file silently swaps scheme
name into the ISIN field and yields no matches at all — the benign failure — or, worse, matches
nothing while reporting success.

AMFI needs no key and no per-symbol requests: one fetch covers the entire mutual fund book. It is
fetched at most once per calendar day, after 23:00 IST when the day's NAVs are published. This is
why mutual fund tracking works before the user has entered any credential.

### Twelve Data — BYOK, equities and crypto

Base `https://api.twelvedata.com`. Endpoints used:

| Endpoint | Use | Credits |
|---|---|---|
| `/quote?symbol=X&apikey=…` | latest close plus `previous_close` for day change | 1/symbol |
| `/price?symbol=X` | latest price only | 1/symbol |
| `/time_series?symbol=X&interval=1day&start_date=…&end_date=…` | history | 1/symbol |
| `/eod?symbol=X` | last close | 1/symbol |
| `/exchange_rate?symbol=USD/INR` | FX | 1 |

Symbols carry an exchange suffix: `INFY:NSE`, `AAPL` (US default), `BTC/USD` for crypto. The
symbol is built from `instrument_alias` — `scheme = 'nse'`/`'bse'` for Indian lines, `'ticker'` for
US, `'coingecko'` or `'ticker'` for crypto — never from `display_name`.

Batch requests accept a comma-separated `symbol` list and cost one credit per symbol, so batching
saves request slots but not credits. Batch anyway: the per-minute limit is on requests.

Errors are HTTP-status-mirroring JSON: `{ "code": 429, "message": "...", "status": "error" }`. Note
that a batch response may carry per-symbol errors inside a 200 body, so the parser must inspect
each entry's `status` field and not only the HTTP status.

**Free-tier reality, and it is worse than "delayed".** The Basic plan is 8 credits/minute and 800
credits/day, and covers real-time **US equities, forex and crypto only**. Indian exchanges are not
on the Basic plan: Twelve Data's own NSE exchange page lists NSE data as **EOD latency** and
available on **Grow+ and Venture+** plans, with `INFY` offered as the single free trial symbol.

The consequences the UI must reflect:

- **Indian equity prices are not available on a free Twelve Data key**, beyond a trial symbol. A
  free-tier user gets US equities, crypto and FX from Twelve Data, mutual funds from AMFI, and
  **no automatic prices for Indian equities**. Those instruments return `PLAN_RESTRICTED` and land
  in the manual-override flow. The settings screen must state this before the user enters a key,
  not after they wonder why their Nifty holdings show no price.
- **On a paid plan, Indian equity prices are end-of-day.** NSE licenses real-time data only
  through authorised vendors. Day change is computed against the last available close and the UI
  labels it with the price's `as_of` date. It must never be presented as live.
- 800 credits/day is ample for a personal portfolio (a few hundred instruments refreshed a couple
  of times a day); 8/minute is the binding constraint and requires a token bucket.

Rate limiting is a persistent token bucket, not an in-memory one: the daily counter survives
application restarts, keyed by the IST calendar date, because a user restarting the app six times
would otherwise burn through the daily quota and get locked out. On `RATE_LIMITED`, back off
exponentially with jitter from `retryAfterMs`; after three consecutive 429s in one refresh, abort
the refresh and report it rather than grinding against the limit.

### Caching, TTL and staleness

The `price` table **is** the cache. There is no second layer, no in-memory TTL map, and no
distinction between "cached" and "stored" — a design that keeps offline behaviour identical to
online behaviour with a stale price, which is the behaviour that actually gets tested.

```ts
interface PriceAge {
  readonly asOf: IsoDate;
  readonly fetchedAt: IsoInstant;
  readonly ageDays: number;              // calendar days from asOf to valuation date
  readonly staleness: 'fresh' | 'stale' | 'very_stale';
  readonly source: PriceSource;
}
```

Freshness is defined against the instrument's own publication calendar, not against a fixed
duration, because "four hours old" means fresh for a mutual fund NAV and broken for Bitcoin:

| Asset class | Fresh when | Stale after | Very stale after |
|---|---|---|---|
| `mutual_fund` | `as_of` is the latest completed Indian business day | 2 business days | 7 days |
| `indian_equity` | `as_of` is the last NSE trading day | 2 trading days | 7 days |
| `us_equity` | `as_of` is the last NYSE trading day | 2 trading days | 7 days |
| `crypto` | `fetched_at` within 15 minutes | 6 hours | 48 hours |
| `gold`, `bond` | `as_of` within 1 business day | 3 business days | 14 days |

A trading-day calendar for NSE and NYSE holidays ships as static data and is refreshed annually.
When the calendar is missing a year, the engine degrades to a weekday calendar and emits
`TRADING_CALENDAR_STALE` rather than mislabelling every price as stale over Diwali.

**Offline behaviour.** Valuation never fetches, so offline changes nothing about how it computes.
Every value carries its `PriceAge`; a `'very_stale'` price still produces a value, still counts in
net worth, and is flagged. The alternative — blanking net worth on a flight — is a worse failure
than showing a three-day-old number that says it is three days old. `stalePriceCount` and
`stalestPriceAgeDays` in `CoverageReport` are what the UI's data-quality panel reads.

### Refresh

```ts
interface RefreshScope { readonly instrumentIds?: readonly string[];
                         readonly assetClasses?: readonly AssetClass[];
                         readonly onlyStale?: boolean; }

interface RefreshReport {
  readonly startedAt: IsoInstant; readonly finishedAt: IsoInstant;
  readonly requested: number; readonly updated: number;
  readonly unchanged: number; readonly failed: number;
  readonly failures: readonly { instrumentId: string; error: ProviderError }[];
  readonly creditsConsumed: number;
  readonly rateLimited: boolean;
}
```

A refresh is a partial-success operation by construction, mirroring `import_run`. Failures are
per-instrument and individually re-runnable.

---

## 7. FX handling

INR is the base currency, always. Every displayed total is INR; native currency is retained per
instrument and shown alongside.

`fx_rate` has no documented direction convention in the schema, so this subsystem fixes one and
records it as open question 7:

> **`base` is the foreign currency, `quote` is INR, and `rate` is the number of INR per one unit of
> `base`.** A row `('USD', 'INR', '2026-08-12', '87.4210', 'twelvedata')` means one US dollar buys
> ₹87.4210.

The inverse convention is equally common in the wild, and a silent inversion turns a ₹50 lakh US
holding into ₹6,500. The parser must assert `quote === 'INR'` on read and reject rows that are not,
rather than inverting them on a guess.

```ts
interface FxService {
  /** Current rate. Used for present value and for the terminal XIRR cashflow. */
  latest(from: Currency, to: 'INR'): Result<FxPoint, FxError>;
  /** Historical rate for a specific date. Used only when txn.fx_rate is absent. */
  on(from: Currency, to: 'INR', date: IsoDate): Result<FxPoint, FxError>;
}

interface FxPoint { readonly rate: Decimal; readonly asOf: IsoDate; readonly source: string; }

type FxError =
  | { readonly code: 'NO_FX_RATE'; readonly pair: string; readonly date: IsoDate }
  | { readonly code: 'NO_FX_SOURCE'; readonly pair: string }
  | { readonly code: 'FX_DIRECTION_INVALID'; readonly base: string; readonly quote: string };
```

Two rules, and the whole of FX correctness follows from them:

1. **Present value uses the current rate.** A USD position's INR value today is
   `quantity × price × latestFx`. Nothing historical enters it.
2. **XIRR uses the rate stored on each transaction.** `txn.fx_rate`, always, with a same-date row
   from `fx_rate` as a flagged fallback and hard failure beyond that. Never today's rate, never an
   average, never a portfolio-wide constant.

`on()` resolves the nearest preceding rate within three calendar days, to cover weekends and
holidays, and marks the result with its actual `asOf`. Beyond three days it fails. Interpolating
FX across a longer gap is invention.

Twelve Data's `/exchange_rate` covers forex on the free tier, so USD/INR works with any key. When
no key is configured, USD holdings have no FX source: their positions are reported with a
`NO_FX_SOURCE` error, excluded from net worth, and counted in `unpricedCount`. They are not valued
at an assumed rate.

---

## 8. Error handling catalogue

Every code below is stable, user-visible, and maps to a UI string. None of them results in a
substituted zero anywhere.

| Code | Severity | Effect |
|---|---|---|
| `NO_PRICE` | warning | Position excluded from value; counted in `unpricedCount` |
| `NO_PRICE_SOURCE` | warning | As above, plus a "set a manual price" prompt |
| `PRICE_CURRENCY_MISMATCH` | error | Price rejected; position unpriced |
| `PRICE_STALE` / `PRICE_VERY_STALE` | warning | Value computed and flagged |
| `NO_FX_RATE` | warning | Position excluded from value and from net worth |
| `NO_FX_SOURCE` | warning | As above |
| `FX_RATE_IMPUTED` | warning | XIRR proceeds using an `fx_rate` table row, flagged |
| `FX_DIRECTION_INVALID` | error | Row rejected; treated as no rate |
| `MISSING_FX` | error | XIRR withheld for the scope |
| `MISSING_ACQUISITION_COST` | warning | Pair → `partially_measured`; cost metrics withheld |
| `NEGATIVE_INVENTORY` | error | Pair → `not_measured`; quantity kept, all P&L withheld |
| `FOLD_SNAPSHOT_MISMATCH` | error | Pair → `not_measured`; snapshot quantity used |
| `CORPORATE_ACTION_MISSING_IN_ACCOUNT` | error | Pair → `not_measured`; quantity marked suspect |
| `BONUS_UNITS_MISMATCH` | warning | Statement figure kept; discrepancy surfaced |
| `GRANDFATHER_FMV_UNAVAILABLE` | error | Disposal bucket `unavailable`; realised P&L withheld |
| `UNKNOWN_TAX_REGIME` | error | Disposal bucket `unavailable` |
| `XIRR_NOT_CONVERGED` | error | XIRR withheld; last iterate attached for diagnosis |
| `XIRR_NO_SIGN_CHANGE` | error | XIRR withheld with the "missing terminal value" explanation |
| `XIRR_MULTIPLE_ROOTS` | warning | XIRR returned with `uniquenessGuaranteed: false` |
| `XIRR_UNSTABLE` | warning | XIRR returned with the short-horizon caveat |
| `SCOPE_NOT_MEASURED` | error | XIRR withheld; offending pairs listed |
| `TRADING_CALENDAR_STALE` | warning | Weekday calendar used for staleness |
| `PLAN_RESTRICTED` | warning | Instrument has no automatic price; manual override offered |
| `RATE_LIMITED` | warning | Refresh partial; retry time reported |

The general rule, stated once so it does not need restating per code: **a computation that cannot
be performed is omitted from its metric and subtracted from that metric's coverage.** The metric
still displays, with a smaller coverage figure and a named exclusion. This is what makes coverage a
real invariant rather than a decoration — every error in this table moves a rupee amount out of
some `MetricCoverage.coveredMinor`, and the sum always reconciles to `valuedMinor`.

---

## 9. Testing

### Property tests — FIFO invariants

Generated over random transaction sequences (arbitrary interleavings of buys, sells, splits,
bonuses and transfers, with quantities across the full 0–18 decimal-place range):

1. **Cost conservation.** For any lot, `Σ consumedCostMinor over all disposals + residualCostMinor
   = openingCostMinor`, exactly, as `bigint`. No tolerance.
2. **Quantity conservation.** `Σ lot.quantity = Σ signed txn quantities, with splits applied as
   multipliers` — asserted as `Decimal` equality after normalisation, not within epsilon.
3. **FIFO ordering.** For any two disposals from different lots of the same pair, the lot with the
   earlier `acquiredOn` is fully exhausted before the later one is touched.
4. **Split invariance.** Applying a split of ratio `k` at any point leaves total cost and every
   `acquiredOn` unchanged, and multiplies total quantity by exactly `k`.
5. **Split commutation.** For any transaction sequence, folding it and folding the same sequence
   with the split transaction moved to a later position in the *import* order (but the same
   `occurred_at`) produce identical `LotLedger`s. This is the late-arriving-split guarantee,
   expressed as a test.
6. **Bonus cost.** Every `origin: 'bonus'` lot has `costMinor === 0n` and an `acquiredOn` equal to
   its transaction date.
7. **Grandfathering monotonicity.** `deemedCostMinor >= costMinor` always, and
   `gainMinor >= 0` whenever grandfathering was applied and consideration ≤ FMV.
8. **No negative quantities.** A fold that would produce one emits `NEGATIVE_INVENTORY` and never
   returns a lot with `quantity < 0`.
9. **Determinism.** The same transaction set in any shuffled input order folds to byte-identical
   output.

### Property tests — XIRR bounds

1. **Sign sanity.** If `Σ inflows > Σ outflows`, the rate is positive; if less, negative; if equal,
   exactly zero within tolerance.
2. **Bracketing.** For any single-sign-change series, `NPV(lowerBound) > 0 > NPV(upperBound)` at
   the bracket the algorithm selects.
3. **Root verification.** `|NPV(rate)| / Σ|cf| < 10^-12` for every returned rate. This is the test
   that catches a converged-to-the-wrong-thing bug, which no fixed example will.
4. **Monotonicity.** For single-sign-change series, `NPV` is strictly decreasing across 50 sampled
   rates in `(−0.99, 10)`.
5. **Scale invariance.** Multiplying every cashflow by a constant leaves the rate unchanged to 10
   decimal places.
6. **Time invariance.** Shifting every date by the same number of days leaves the rate unchanged.
7. **Termination.** No generated input exceeds 100 iterations or fails to return a `Result`.
8. **Never zero on failure.** Every `Err` path is asserted to carry no rate field at all — enforced
   by the type, and asserted at runtime for the IPC-serialised form.

### Fixed worked examples (golden tests)

The three examples in this document are test fixtures, asserted exactly:

- **FIFO partial disposal with grandfathering.** Realised LTCG `5720592n` paise, split
  `4085000n` + `1635592n`; surviving lot 30 units at `2162112n` paise; `1441408n + 2162112n ===
  3603520n`.
- **Split then bonus.** Post-split Lot B is 250 units at `3603520n` with `acquiredOn` still
  `2019-06-10`; Lot C is 100 units at `1501200n` and unadjusted; Lot D is 250 units at `0n` with
  `acquiredOn` `2023-03-10`; weighted average unit cost `85.0787` to four places.
- **XIRR.** `0.0934468613876180…` asserted to 10 decimal places, with the iteration count asserted
  at ≤ 5 to catch a regression in the bracketing that still converges.

Cross-validation: the XIRR fixture is additionally checked against LibreOffice Calc's `XIRR` and
the FIFO fixture against a hand-computed sheet checked into `test/fixtures/`. Two independent
derivations of the same number is what makes a golden file evidence rather than a snapshot of
whatever the code happened to do first.

### Coverage tests

1. `measuredMinor + unmeasuredMinor === valuedMinor` exactly, for every generated portfolio.
2. Coverage reads `100.00` **only** when `measuredMinor === valuedMinor`; a portfolio with one
   paise unmeasured reads `99.99`.
3. Coverage reads `null`, not `0`, when `valuedMinor === 0n`.
4. For every metric, `coveredMinor + Σ excludedPairs.valueMinor === totalMinor`.
5. Withheld value never appears in `valuedMinor`, asserted by constructing a portfolio that is
   entirely unresolved and checking that net worth is `0n` while `withheldMinor` is non-zero.

### Price service tests

1. **Parser golden files.** Redacted excerpts of both `NAVAll.txt` and the historical report,
   including the discontinued-scheme row with a 2017 date, the `-` ISIN placeholder, category
   headings and blank lines. Expected parse output as JSON.
2. **Header-driven column mapping.** Feeding the historical layout to the parser must produce
   correct output, and feeding it with the daily layout hard-coded must fail loudly in the test —
   proving the parser reads its header.
3. **Manual override precedence.** Insert a manual price, run a refresh that would return a
   different value for the same date, assert the manual row survives and the read returns it.
4. **Rate limiter persistence.** Consume 800 credits, restart the service, assert the next request
   is refused until the IST date rolls over.
5. **Partial batch failure.** A batch response containing per-symbol errors inside a 200 body
   yields per-symbol results, with the successes committed.
6. **Offline.** With the network disabled, valuation produces identical numbers to the online run
   plus staleness flags. Asserted by running the same fixture twice.
7. **No floats.** A repository-wide test greps the built bundle for `parseFloat`, `Number(` and
   unary `+` on the relevant identifiers, per Subsystem A's lint rule.

---

## Open questions for core

Each is a gap in the fixed schema that this subsystem works around today and that Subsystem A
should close. None blocks implementation; all of them cost accuracy.

1. **Mutual fund sub-type is not representable.** `asset_class = 'mutual_fund'` is a single bucket,
   but the tax regime depends on whether the scheme is equity-oriented (section 112A, 12 months),
   a specified mutual fund (section 50AA, always short-term), or another non-equity fund (12 or 24
   months by listing status). Requested: `instrument.sub_type`, or a `mutual_fund_meta` table
   populated from AMFI's scheme category. **Workaround:** every mutual fund is classified
   `UNKNOWN_TAX_REGIME` and its realised gains are reported as `unavailable` until the user
   classifies the scheme by hand. This is the single largest accuracy gap in the subsystem.
2. **No storage for the 31 January 2018 FMV.** The grandfathering FMV is the *highest* price quoted
   that day; `price` carries only `close`. Requested: a `price.high` column, or a dedicated
   `grandfather_fmv (instrument_id, fmv, source)` table. **Workaround:** a `price` row with
   `as_of = '2018-01-31'` and `source = 'manual'`, which abuses `close` to mean "high" and is
   invisible to a reader of the schema.
3. **`fees_minor` is not decomposed, so STT cannot be excluded.** The proviso to section 48
   disallows STT as a deduction. Requested: `stt_minor`, or a `txn_charge` child table with a
   charge-type enum. **Workaround:** total fees are used and the divergence is disclosed in the UI.
4. **`price`'s primary key cannot hold a manual override alongside the fetched value.** With
   `PRIMARY KEY (instrument_id, as_of)` there is one row per date, so setting an override destroys
   the market value for that date. Requested: `source` in the primary key with an explicit
   precedence view, or a separate `price_override` table.
5. **`txn.quantity` has no defined meaning for `split`.** This spec adopts "multiplier" and
   "units credited" for `bonus`, but the schema documents neither. Requested: explicit
   documentation, or a `corporate_action (instrument_id, ex_date, kind, ratio_num, ratio_den)`
   table, which would also solve (6).
6. **Corporate actions are per-account rows with no instrument-level record.** A split recorded in
   one account's statement and absent from another's silently diverges quantities for the same
   instrument. **Workaround:** cross-account detection and a `not_measured` downgrade, which is
   correct but pessimistic — it withholds metrics for a holding that is probably fine.
7. **`fx_rate` has no documented direction convention.** This spec fixes `base` = foreign, `quote`
   = INR, `rate` = INR per unit of base. Requested: a `CHECK` constraint or a comment in the
   migration, plus a validation on write.
8. **No `instrument.listed` flag.** The 12-versus-24-month holding period for non-equity units
   turns on whether the units are listed (a gold ETF) or not (a gold fund-of-funds). Requested: a
   boolean, or derive it from the presence of an `nse`/`bse` alias — the latter is inference, not
   fact, and should be blessed explicitly if it is to be relied upon.
9. **No place to cache derived lots.** The fold is recomputed on every read and memoised in memory,
   which is correct and fast enough for a personal portfolio (thousands of transactions, not
   millions). If profiling later says otherwise, a `derived_lot` table keyed by a content hash of
   the account's transaction set would be the right shape — keyed by a hash so that a stale cache
   is impossible rather than merely unlikely.
10. **Account-level fees have nowhere to go.** `txn.instrument_id` is `NOT NULL`, so an annual
    demat maintenance charge must be attached to a synthetic `cash` instrument. Requested:
    a nullable `instrument_id` for `fee`, `interest` and `tds` rows, or a blessed convention for
    the synthetic cash instrument. **Workaround:** the synthetic instrument, which enters XIRR
    cashflows correctly but shows up as a zero-quantity holding that the UI must filter.

---

## Out of scope

- **Tax computation.** The engine classifies gains into ST/LT buckets by regime and reports gross
  figures. It does not compute tax payable, apply slab rates, surcharge or cess, net gains against
  losses across heads, apply carry-forward, or produce ITR schedules. It cannot: slab rate,
  residency, other income and prior-year losses are all outside the database. Beyond the practical
  objection, computing a liability edges toward tax advice, and the design spec's regulatory
  posture is to hold that line early.
- **Indexation.** Removed for transfers on or after 23 July 2024 for the asset classes Misal
  tracks. The rules table has no indexation field and no cost-inflation-index data ships.
- **Advice of any kind.** No rebalancing suggestions, no target allocations, no benchmark
  comparison framed as performance evaluation. Allocation and concentration figures are
  descriptive only.
- **Intraday and real-time pricing.** v1 is end-of-day for Indian equities and mutual funds by
  construction. No websockets, no tick data, no streaming provider.
- **Shorting, margin, derivatives, options.** Negative inventory is an error condition, not a
  position. F&O has its own tax treatment (business income, not capital gains) and is a separate
  subsystem if it is ever built.
- **Multi-currency base.** INR is the base currency and is not configurable in v1.
- **Benchmarks and factor attribution.** No index comparison, no sector attribution, no
  risk metrics (beta, Sharpe, drawdown).
- **Backdated what-if analysis.** The engine values as of now or as of a supplied date from stored
  prices; it does not simulate alternative transaction histories.
- **Provider adapters beyond AMFI and Twelve Data.** The `PriceProvider` interface exists so
  others can be added; none are specified here.

---

## References

Tax treatment researched 2026-08-12. These rules change annually with the Finance Act and the
rules table carries effective dates for exactly that reason; re-verify each February.

- Section 112A and the ₹1.25 lakh exemption — [ClearTax](https://cleartax.in/s/long-term-capital-gains-on-shares)
- Section 55(2)(ac) grandfathering — [TaxGuru](https://taxguru.in/income-tax/amendment-section-55-clarifying-cost-acquisition-equity-shares.html)
- Finance (No. 2) Act 2024 capital gains changes, 23 July 2024 pivot —
  [CBDT FAQs](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2036604&reg=48&lang=2)
- Section 50AA specified mutual funds, amended definition —
  [TaxGuru](https://taxguru.in/income-tax/amendment-specified-mutual-fund-definition-section-50aa-budget-2024.html)
- Sections 115BBH and 194S on virtual digital assets —
  [TaxGuru](https://taxguru.in/income-tax/taxation-cryptocurrency-virtual-digital-assets-india-understanding-sections-115bbh-194s-method-taxation.html)
- AMFI daily NAV file — [portal.amfiindia.com/spages/NAVAll.txt](https://portal.amfiindia.com/spages/NAVAll.txt)
- AMFI NAV history — [amfiindia.com/net-asset-value/nav-download](https://www.amfiindia.com/net-asset-value/nav-download)
- Twelve Data pricing and free-tier limits — [twelvedata.com/pricing](https://twelvedata.com/pricing)
- Twelve Data NSE coverage and latency — [twelvedata.com/exchanges/xnse](https://twelvedata.com/exchanges/xnse)
- Twelve Data API reference — [twelvedata.com/docs](https://twelvedata.com/docs)
