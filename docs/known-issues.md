# Known issues

Defects and gaps identified during implementation but not yet fixed. Recorded here rather than
left in a branch description, so they survive the worktree they were found in.

Each entry states the consequence, because "known issue" without a consequence gets deprioritised
forever.

## Blocking before v1 ships

### ~~Two divergent `natural_key` implementations~~ — FIXED

Resolved by `src/domain/natural-key.ts`, now the single definition used by both subsystems, with
a conformance test that computes a key through each call path and asserts they match. The date
parameter is a local calendar date and the function throws on an ISO instant, so the worst of the
four divergences cannot be reintroduced silently.

One residual, by design rather than oversight: the shared function deliberately refuses to derive
a calendar date from an instant, because the correct basis differs by source. Exchanges timestamp
in UTC and their exports agree, so `exchangeLocalDate` slices the instant; statements state a
local date and must never be sliced from UTC. Each caller now names its choice in code.

The original description is kept below, because the failure mode is worth recognising again.

### Two divergent `natural_key` implementations (historical)

Ingestion and the exchange adapters each compute `txn.natural_key` independently, and they do not
agree:

| | field list |
|---|---|
| `src/ingestion/` | account, instrument, type, local date, trailing-zero-trimmed quantity, `amountMinor` |
| `src/adapters/sync/natural-key.ts` | the same, **plus the exchange trade id** |

The adapters added the trade id for a real reason: without it, two identical commission rows from
different pages of the same API response collapse into one key, while `occurrence` counts only
within a document and the unique index spans all of them. So neither field list is simply wrong.

**Consequence:** deduplication only works within a source. A user who imports a CSV export of their
exchange trades *and* connects the same exchange by API gets both copies, because the two paths
produce different keys for the same trade. That inflates net worth — the same class of failure as
the mutual-fund folio doubling that `account.identity_key` was added to prevent, and it is
currently unguarded: nothing fails if the two field lists disagree.

**Fix direction:** one shared `naturalKey()` in `src/domain/`, consumed by both subsystems, with a
conformance test asserting both produce identical keys for the same logical transaction. Where a
discriminator is genuinely needed, it belongs in `occurrence` rather than folded into the key.

Cross-source dedup between a CSV export and an API sync of the same exchange may not be fully
solvable — a CSV that omits trade ids cannot be matched with confidence. If so, say so in the
import UI rather than silently producing duplicates.

### ~~Account identity depends on an AMC name slug~~ — FIXED

Resolved by the canonical AMC registry in `src/ingestion/amc/`. A folio's identity is now
`mf-folio:<registry id>:<folio>`, resolved from **the ISIN issuer prefix first** and a curated
alias table on the printed name second. The prefix — the first seven characters of a mutual fund
ISIN, `INF179K` — is the only AMC identifier these statements carry that does not vary with the
template, and both families print it: the CAMS scheme line as `- ISIN: …`, the NSDL eCAS in the
mutual fund folios table. Both parsers now scan the whole document for AMC evidence before any
identity key is built, because the CAMS CAS prints the folio line *before* the scheme line that
carries the ISIN, and keying at the folio line is what forked the folio.

That prefixes are AMC-scoped was checked rather than assumed, against AMFI's complete NAV file
(51 fund houses, ~17,800 scheme rows): no prefix appears under two houses. Registrar codes, which
the original fix direction proposed, turned out to be the wrong instrument — `Registrar :` names
CAMS or KFintech, and one registrar services dozens of AMCs.

The fixtures no longer agree by accident: `AMC_SPELLINGS` in `src/ingestion/testing/corpus.ts`
carries three real forms per house — the fund form, the legal-entity form and a
punctuation/whitespace variant — the NSDL fixture prints the legal entity by default, and
`amc-identity.test.ts` imports every pairing and asserts one account.

Migration 0004 re-keys folios already in the database. Two residuals, both deliberate:

- **A database that already forked a folio is not merged.** Where two accounts would rewrite onto
  the same canonical key, both are left exactly as they were. Merging them cannot fix the totals:
  `txn.natural_key` is a hash over `account_id`, SQL cannot recompute it, so both copies of every
  transaction would survive the merge — and deleting one account would discard transactions the
  user's own statements assert. The pair stays visible as two accounts against one folio number.
  A repair path belongs in the review queue, where a human can confirm it, not in a migration.
- **An unrecognised fund house gets a provisional identity, not a canonical one.** The key carries
  an `unverified~` marker — `~` cannot occur in a registry id — and the import report raises
  `W_AMC_UNRECOGNISED`. Where the statement printed an ISIN, the provisional token is the unknown
  issuer prefix, so the folio is still stable across documents. Where it printed only a name that
  the registry does not list, it is not, and the warning says so in those words.

The original description is kept below, because the failure mode is worth recognising again.

### Account identity depends on an AMC name slug (historical)

`identity_key` for a mutual fund folio is built from a slugified AMC name. The test fixtures print
"HDFC Mutual Fund" in both documents, but a real NSDL eCAS printing "HDFC Asset Management Company
Limited" slugs differently.

**Consequence:** the same folio becomes two accounts and its units are counted twice — exactly the
failure the identity key exists to prevent, and the test suite would not catch it because both
fixtures happen to agree.

**Fix direction:** a canonical AMC table keyed on registrar codes, rather than string
normalisation of a printed name.

### Every NSDL demat holding is attributed to the first demat account in the file

Found while fixing the AMC identity key, and it is the same failure class one layer along.
`readDematHolding` in `src/ingestion/pdf/nsdl-ecas.ts` picks its account with

```ts
const account = [...accounts.values()].find((a) => a.key.startsWith('demat:'))
```

— the *first* demat account the roster declared, for every holding in the file. An NSDL eCAS
routinely lists more than one demat account, and it lists them precisely because the investor has
more than one; the holdings sections that follow are per account, and the parser does not track
which one it is inside. The MF folio path does not have this problem, because a folio number
appears on its own row and is joined back to the roster.

**Consequence:** with two or more demat accounts, every share lands under the first. Net worth
totals are unaffected — the holdings are all still counted once — but per-account values are wrong,
the second account looks empty, and any future per-account cost basis or XIRR is computed against
the wrong set of transactions. It also makes the position uniqueness constraint
`(account_id, instrument_id, as_of)` collide when the same ISIN is genuinely held in two accounts,
so one of the two holdings is silently restated over the other and **that** does lose units.

**Fix direction:** the demat holdings section is introduced by a header naming its DP ID and client
ID. Carry that as section context the way the CAMS parser carries the folio, and fail the section
with an issue rather than guessing when no account header has been seen. The single-account
fixture cannot catch this; a two-demat-account fixture is the first thing the fix needs.

## Valuation engine

### ~~`PriceService.priceAt` returns the nearest preceding price, not an exact match~~ — FIXED

Fixed by making the not-measured branch the only place a stale price can be reached, following
`Measured`. A date selector is now answered exactly or not at all: when the table holds no row on
the requested date, `priceAt` returns `{ ok: false }` with a `PRICE_NOT_ON_DATE` error carrying
`requested`, `staleByDays`, and the preceding row as `lastKnown`. Because the failing branch has no
`value` field, reading `value.close` for a day that has no price is a compile error rather than a
silently stale figure on screen.

`'latest'` is deliberately unchanged — "the most recent row" is exactly what that selector asks
for, and its freshness is already reported by `priceAge`.

One caller genuinely wants last-known-price semantics: `xirrForScope`'s `priceOn`, because a
cashflow is dated by the day it happened and most such days have no published close. It now names
`lastKnown` explicitly, so the carry-forward is a visible decision at the one site that needs it
instead of a default everyone inherits.

The original description is kept below, because the shape of the failure is worth recognising
again: a result type that is *technically* honest — the record did state its own `asOf` — but whose
easiest reading is the wrong one.

### `PriceService.priceAt` returns the nearest preceding price (historical)

A caller asking for a price on a date with no row receives an older row instead. The returned
record states its own `asOf`, so a careful caller can detect this, but a caller that reads only
`close` will silently show a stale price as if it were the requested day's.

**Consequence:** a holding could be valued at a price from days earlier without the UI marking it
stale. Directly undermines the staleness indicator the design promises.

### ~~Instant comparisons are lexicographic on ISO strings~~ — FIXED

Fixed by `compareInstants` in `src/valuation/calendar.ts`, which normalises to epoch milliseconds
before ordering, and is now used by the snapshot selection in `src/valuation/positions.ts`.

Normalising at comparison time rather than enforcing a `Z` suffix at the storage boundary was the
deliberate choice: `occurred_at` keeps the source's offset on purpose — a statement's local trade
date must not be re-derived from UTC, which is the same distinction the `natural_key` entry above
settled — so the offsets have to survive in storage and the ordering has to cope with them.

Two failure modes were fixed, not one. The known-wrong-winner case is the obvious one; the second
was worse and unstated: a row written at a large positive offset sorts *after* the valuation
instant as text while genuinely preceding it, so it was filtered out entirely and the holding
dropped out of net worth rather than merely being valued from the wrong row.

**Still lexicographic, and correct to be:** comparisons on `IsoDate` (`fx.ts`, `price/*.ts`,
`xirr.ts`). Those are `YYYY-MM-DD` with no offset to disagree about, where string order *is*
chronological order.

### Cross-account corporate-action check keys on ex-date alone

If two accounts record the same split a day apart, each appears to the other to be missing it, and
both get downgraded.

**Consequence:** false `not_measured` results that hide otherwise-valid metrics.

### Missing arithmetic helpers live in the wrong layer

`powDec`, `roundDec` and `mulDivMinor` were needed by the valuation engine and were added to
`src/valuation/arithmetic.ts`. They are general numeric operations and belong in
`src/domain/numeric.ts`, where the float ban already exempts the module and the tests are
concentrated.

**Consequence:** a second subsystem needing them will either duplicate them or import across a
boundary that should not exist.

**Still open.** Deliberately left alone while fixing the two price/time defects above: the move
lands in `src/domain/numeric.ts`, and doing it from a branch scoped to `src/valuation/` would
conflict with concurrent work there. It needs its own branch that owns both directories.

### `NotMeasuredReason` has no member for a blocked grandfathering FMV

Currently borrows `unknown_tax_regime`, which reports the wrong reason to the user.

### `BONUS_UNITS_MISMATCH` is unreachable

Nothing in the schema stores a bonus ratio, so units credited cannot be cross-checked against an
expected figure. The check exists but can never fire.

**Fix direction:** either store the ratio during ingestion or delete the dead branch. Leaving an
unreachable validation implies a guarantee that does not exist.

### Twelve Data rate limiting is incomplete

The daily quota is enforced; the per-minute limit is not, and there is no retry or backoff.

**Consequence:** a burst of requests can trip the provider's minute limit and fail a sync with no
recovery.

## Test coverage

### Tax rule tables were nearly unguarded

Mutation testing on 2026-08-12 found that changing all nine tax rates failed only one test, and
changing holding-period thresholds was largely undetected. These values are transcribed from
legislation, change annually, and a wrong one produces a plausible number rather than a crash.

Addressed by `src/valuation/tax-rules.table.test.ts`, which pins every rate, threshold, effective
date and grandfathering flag. Verified by re-running the mutations: each is now caught.

**Standing lesson:** golden arithmetic examples do not cover lookup tables. Any table transcribed
from an external source needs exhaustive assertion, not sampled assertion.
