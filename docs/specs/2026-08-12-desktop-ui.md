# Subsystem E — Desktop UI

**Status:** draft
**Date:** 2026-08-12
**Depends on:** [v1 design](2026-08-12-misal-v1-design.md),
[A — core schema and storage](2026-08-12-core-schema-storage.md), D — valuation engine
**Visual reference:** `docs/design/mockups/final-consolidated.html` (approved)

This spec turns the approved mockup into something implementable. It is not a re-design. Where it
departs from the mockup it says so explicitly and gives the reason (§3).

The core schema is a fixed contract. Nothing here proposes changing it; genuine gaps are recorded in
§14, *Open questions for core*.

---

## 1. What this subsystem is responsible for

The entire view layer: five screens, the components they are built from, the query layer that feeds
them from the Rust core and the TypeScript valuation engine, and the rules that keep the product's
honesty promises from eroding.

It is **not** responsible for parsing, valuation arithmetic, price fetching, storage or secrets. It
consumes their outputs and is forbidden from recomputing them.

### The one thing this subsystem must not get wrong

Misal's differentiator is that it refuses to state a number it cannot measure. That promise lives
almost entirely in the UI, and it is exactly the kind of promise that dies by a thousand small
conveniences — a `?? 0` here, a `—` there, a coverage figure moved into a tooltip because the cell
was tight. §5 therefore specifies the promise as machine-checkable invariants, and §4 makes the
worst violations impossible to express in TypeScript at all.

---

## 2. Stack decisions

### 2.1 React 18 + TypeScript, strict, inside Tauri v2

Fixed by the v1 design. Notes that follow from it:

- `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. The type
  system is load-bearing here (§4.2), so it is configured to be believed.
- No CSS-in-JS. Plain CSS with custom properties, one stylesheet per component, tokens in
  `tokens.css`. The mockup is already authored this way, its light/dark switch is pure CSS, and the
  charts inherit colour through `var(--s1)` etc. from a CSS variable — which a runtime style engine
  would only complicate.
- No component library. Every control in the mockup is a `<button>`, `<table>` or `<select>`
  restyled; importing a design system to re-skin it to look like this would cost more than writing
  it.

### 2.2 Data fetching: TanStack Query v5. Client state: the URL, plus a tiny persisted store

**Decision.** Server-state (anything originating in the core or the valuation engine) is owned by
TanStack Query. View state (grouping, sort, filters, selected tab) lives in the URL. Preferences
(column visibility, theme override, "stamp key seen") live in a small `zustand` store persisted to
`localStorage`. There is no other global state.

**Why TanStack Query for a local app with no server.** The Rust core is an async request/response
API that happens to be one process away rather than one network away, and it has exactly the
properties Query exists for: results are cacheable, several components need the same result, a
mutation (import, resolve instrument, refresh prices) invalidates a known set of results, and every
call has a loading and an error state that the UI is contractually required to render distinctly
(§7). Hand-rolling that in `useEffect` reproduces Query badly. The alternatives were considered and
rejected: Redux Toolkit Query brings a store we do not otherwise need; SWR lacks the invalidation
graph; bare `useEffect` fails the "every data-bearing component has four specified states"
requirement on the first sprint.

Two configuration decisions matter and are not defaults:

- `refetchOnWindowFocus: false`. There is no server drift. A local database changes only when the
  user changes it. Refetching on focus would recompute valuations for nothing and — worse — could
  make a figure flicker between two values while the user is reading it.
- `staleTime: Infinity` for valuation queries, with explicit invalidation. Valuation output is a
  pure function of (positions, transactions, prices, fx). Every one of those has a known mutation
  that touches it. Time-based staleness would be a guess where we have exact knowledge.

**Query keys and the invalidation graph.**

```ts
['accounts']                          // account list + capability + derived last-synced
['instruments']                       // instrument index
['instrument', instrumentId]          // detail: aliases, lots, txns, price history
['valuation', { asOf }]               // net worth, allocation, coverage, concentration, XIRR…
['history', { months: 12 }]           // month-end net worth by asset class
['importRuns'] / ['importRun', id]    // import report
['unresolved']                        // review queue
['priceStatus']                       // freshness, stale counts, feed timestamps
['settings']
```

| Mutation | Invalidates |
|---|---|
| `import_document` | everything except `['settings']` |
| `resolve_instrument`, `ignore_unresolved` | `unresolved`, `valuation`, `history`, `instrument*`, `instruments` |
| `refresh_prices`, `set_manual_price` | `valuation`, `history`, `priceStatus`, `instrument*` |
| `add_account`, `archive_account`, `delete_account` | all |
| `set_setting` | `settings`, and `valuation` when the setting is a threshold or TTL |

**Why the URL for view state.** Grouping, sort, account filter and coverage filter are exactly the
things a user wants to return to, deep-link from the dashboard ("show me the mutual funds"), and
have restored by the back button. Putting them in a store means reimplementing history. Search
params are the store:

```
/holdings?group=asset_class&sort=value:desc&account=all&coverage=all
```

**Why so little client state.** Every piece of global mutable state is a place where a figure can
diverge from its provenance. The rule to enforce in review: **nothing derived from core data is
allowed in the zustand store.** If it can be computed from a query result, compute it.

### 2.3 IPC contract: generated, not hand-written

Rust command signatures and record types are generated into `@misal/contracts` with `tauri-specta` +
`specta`, checked into the repo, and verified in CI by regenerating and diffing. Schema drift
between the core and the UI then fails the build instead of failing a user's net worth.

Every numeric field arrives as a string (subsystem A, *Data-access layer*). §4.1 brands those
strings so that arriving-as-a-string is enforced downstream too.

### 2.4 Tables: TanStack Table v8, headless. No virtualisation in v1

**Decision.** Use `@tanstack/react-table` for grouping, sorting, column visibility and the group
subtotal rows; render a plain semantic `<table>` ourselves. Do **not** virtualise.

**Why not virtualise at a few hundred rows.** A 500-position portfolio is 500 rows × 11 cells ≈
5,500 elements — comfortably inside what React and the webview render in one frame, and it is the
99th-percentile portfolio, not the median. Against that modest saving, virtualisation costs real
things this product needs: Cmd-F stops finding a holding, the sticky asset-class group headers need
reimplementing, the 56px provenance gutter has to stay pixel-aligned across an absolutely positioned
row layer, screen-reader row counts become synthetic, and "Export what I can see" becomes ambiguous.
It also makes visual-regression screenshots depend on scroll position.

**The revisit trigger, stated now so the decision stays honest.** A perf test renders the holdings
table with a 500-row fixture and asserts first paint under 120 ms and a re-sort under 60 ms on CI
hardware. If a real portfolio pushes past **2,000 rows** or that budget fails, add
`@tanstack/react-virtual` behind the existing row renderer — the table is headless precisely so this
is a contained change.

**Sorting must not go through `Number`.** Comparators for money and quantity columns use
`decimal.js` on the stored strings (§4.1). A sort comparator is the single most likely place for a
stray `parseFloat` to enter the codebase; it gets its own test.

### 2.5 Charts: hand-authored inline SVG, no charting library

**Decision.** Every chart is inline SVG written by hand from a small set of shared primitives
(§8.9). No Recharts, no Visx, no D3-as-renderer. `decimal.js` is used for scale arithmetic; nothing
else is imported.

**Why.** Five reasons, in descending order of how much they cost to work around:

1. **Numbers.** Every charting library's data API is `number[]`. Handing it `48_32_150.00` means a
   `Number()` conversion in application code, which is precisely what subsystem A forbids and what
   the lint rule will (correctly) reject. Hand-authored SVG lets us convert decimal → **pixel
   coordinate** in exactly one audited function, where the output is a rendering artefact that is
   never displayed as a figure. Labels are always formatted from the decimal string, never from the
   pixel.
2. **Nothing here is a standard chart.** The calibration bar is a horizontal stack drawn on a real
   rupee ruler with major/minor ticks, a 2px boundary line with a caret, two flanking annotations, a
   total mark, and a bracket captioning the excluded amount. No library expresses that; every
   library would be fought.
3. **Theming and the hatch.** Fills are `var(--s1)…var(--s5)` and the snapshot hatch is an SVG
   `<pattern>` whose stroke is `var(--surface)`. Light/dark and the manual theme override then cost
   zero JavaScript and cannot desynchronise. Canvas-based renderers cannot read CSS variables at
   all; SVG-based ones fight the class-name conventions.
4. **Accessibility and testability.** Inline SVG is DOM: labels are real `<text>` nodes that a
   screen reader and a DOM assertion can both see, and a visual-regression diff is stable because
   nothing is measured at runtime.
5. **Bundle and determinism.** ~0 KB added, no layout-dependent animation, no ResizeObserver, and
   identical output on every machine — which is what makes screenshot baselines usable.

**The cost, acknowledged.** Tooltips, brushing and zoom are not free. v1 does not have them (§15),
and the mockup does not use them: every bar is directly labelled instead, which the colour-
independence rule requires anyway.

---

## 3. Deviations from the mockup

Four, and only four. Two were agreed in review; two are forced by the core contract.

**D1 — The seven `DRV` stamps in the dashboard readout are removed (approved).** All seven readout
figures are derived, so seven identical dotted marks carry no information and cost a 56px gutter
seven times. Replaced by one statement at panel level: the readout gains a head strip reading
`Portfolio readout` on the left and `Derived from 6 accounts · nothing observed directly` on the
right, with **one** `DRV` stamp in the gutter of the hero cell so the gutter rhythm is unbroken and
the stamp system is still visibly present. The remaining six gutters render as empty, `aria-hidden`
spacers to preserve the left-edge alignment that the design uses to tie the readout to the tables
beneath it. The rule generalises: **a stamp appears where it disambiguates. A uniform column of
identical stamps disambiguates nothing.**

**D2 — The stamp key becomes a help affordance, not permanent chrome (approved).** In the mockup the
key is a fixed block under the masthead. In the app it is:

- a `?` button in the status line, opening `StampKeyPopover` (§8.3);
- keyboard `Shift + /` from anywhere;
- an accessible description on every individual stamp, surfaced on hover or focus after 400 ms as a
  full sentence — *"Source: CAMS/KFintech consolidated statement, pages 4–9. Snapshot only — no
  transaction history."* — not as the three-letter code;
- shown expanded once, inline, on first run, until dismissed (`prefs.stampKeySeen`).

Rationale: the key is onboarding. Permanent chrome that teaches is chrome that shouts after week
one, and it competes for the top of the screen with the calibration bar, which must own it.

**D3 — The focus ring becomes achromatic.** The mockup sets `--focus: #2a78d6`, which is the same
value as `--s1`, the Indian-equity hue. The product rule is that colour means asset class and
nothing else; a blue ring drawn next to a blue bar breaks it. `--focus` is retained as a token but
set to `--ink-1`, rendered as a 2px outline with a 1px `--surface` inner ring so it stays visible
against every surface *including* the coloured chart segments, where a single ink ring would
disappear on `--s1`.

**D4 — The import report's "Stored at" row is removed.** The mockup shows `Stored at
~/Library/Application Support/Misal/documents/47/`. Subsystem A states plainly that raw document
bytes are never stored — only the hash and metadata. Showing a storage path would be a false claim
about where the user's PDF is. Replaced by a `Read from` row showing `source_document.original_name`
with the note *"not copied — Misal recorded the checksum only"*. See §14 for whether the original
path should be retained at all.

---

## 4. Numbers at the view boundary

### 4.1 Types

```ts
// Branded strings. The brand is what makes `a + b` a type error rather than a silent float.
export type Minor = string & { readonly __minor: unique symbol };   // "483215000" (paise/cents)
export type Dec   = string & { readonly __dec:   unique symbol };   // "12.3450", "-0.00000042"
export type Ccy   = 'INR' | 'USD';

export interface Money { minor: Minor; ccy: Ccy }
export interface Qty   { value: Dec; precision: number; unit?: string }  // unit: 'g' for gold
export interface Pct   { value: Dec }                                    // "23.15" = 23.15%
```

Branding is not decoration. `Number(m.minor)`, `+m.minor` and `m.minor * 2` are all rejected by
`tsc` because the brand is not assignable to `number`, which upgrades subsystem A's lint rule from a
convention to a compile error. The ESLint rule from A stays as defence in depth for untyped
boundaries.

### 4.2 `Measured<T>` — the honesty type

```ts
export type NotMeasuredReason =
  | 'snapshot-account'      // the account supplies holdings only
  | 'partial-history'       // transactions begin after the position did
  | 'no-price'              // no price source for this instrument
  | 'unresolved-instrument' // identifier is unmapped; value withheld from totals
  | 'unsupported-action';   // a corporate action Misal cannot model exactly

export type Measured<T> =
  | { measured: true;  value: T }
  | { measured: false; reason: NotMeasuredReason; detail?: string };
```

Every history-dependent field on every view-model is `Measured<…>`. The `false` branch **has no
`value` property**, so there is no expression that produces a zero for an unmeasurable metric: the
worst honesty violation is not a test failure, it is a type error. `<Metric>` (§8.5) is the only
sanctioned renderer for these fields and handles both branches.

### 4.3 Formatting

Rounding happens here and nowhere else. Rules extracted from the mockup:

- **Indian grouping is hand-written on the string.** `Intl.NumberFormat('en-IN')` takes a `number`
  and is therefore banned. `formatIndianGroups(intDigits: string): string` implements the 2-2-3
  lakh/crore rule on the integer digit string: `4832150 → 48,32,150`. USD uses 3-digit grouping. The
  currency exponent comes from A's static table.
- **Signs are glyphs, not colours.** `+` (U+002B) and `−` (U+2212 MINUS SIGN, as in the mockup, not
  a hyphen) are always emitted for signed figures. Colour is redundant reinforcement only (§11.4).
- **The currency symbol appears once.** Either in the column header (`Value ₹`, cells bare) or in
  the figure (`₹48,32,150`, standalone). Never both.
- **Quantities preserve their stored digits**, displayed at `instrument.precision`, with trailing
  zeros intact: `0.04150000`, `11,240.556`, `21.4790 g`.
- **Percentages** are two decimals with an explicit sign where signed: `+24.94%`, `−0.30%`, `71.9%`
  for coverage (one decimal, matching the mockup).
- **Money in a table cell is never abbreviated.** `₹5L` appears only as an *axis tick*, where it is
  a scale marker and not a figure.

`formatMoney`, `formatQty`, `formatPct` accept only the branded types. They are pure, take no locale
argument in v1 (en-IN, ₹ base), and are property-tested (§13.1).

---

## 5. The honesty rules as UI invariants

Each invariant is stated so it can be asserted. §13.2 makes them a test suite that runs against
every component test and every screen fixture.

The machine-readable contract is a set of `data-*` attributes that components emit. They exist for
the tests and for devtools inspection, and they are cheap:

```
data-metric="net-worth|day-change|cost-basis|unrealised|realised|xirr|weight|value|…"
data-basis="ledger|snapshot|mixed|derived"
data-coverage-pct="71.9"      data-coverage-minor="347372200"
data-stale-days="15"          data-not-measured="snapshot-account"
```

**H1 — The ledger gate.** A metric in `HISTORY_DEPENDENT` = {invested / cost basis, average cost,
unrealised P&L ₹ and %, realised P&L incl. STCG/LTCG split, XIRR, FIFO open lots, holding period}
may render a numeral only if every account contributing to its scope has `capability = 'ledger'`.
Otherwise it renders `NotMeasured`. Enforced structurally by §4.2 and asserted per component.

**H2 — Coverage travels with the metric.** Any history-dependent metric rendered at portfolio,
asset-class or account-group scope renders, in the same visual component, both a coverage percentage
and the absolute rupee amount covered. Not in a tooltip, not in a footnote at the bottom of the
page, not on hover. *Test: an element with `data-metric ∈ HISTORY_DEPENDENT` and `data-scope !=
"position"` must carry non-empty `data-coverage-pct` and `data-coverage-minor`.*

**H3 — Never a zero, never a blank.** `NotMeasured` renders the literal string "Not measured" plus a
reason drawn from the closed union. Forbidden renderings for an unmeasurable metric: `₹0`, `0`,
`0.00%`, `—`, `N/A`, `-`, and the empty string. *Test: no element carrying `data-not-measured` has
text content matching `/^[\s₹0.,%—–-]*$/`.*

**H4 — No estimation, structurally.** There is no code path that produces a number for a snapshot
position's cost basis. Asserted at type level (§13.3), not only at runtime.

**H5 — Hatch fidelity.** Any geometry whose value is snapshot-derived carries the 45° hatch overlay;
any legend entry for it carries the hatched swatch; any panel containing hatched geometry carries a
plain-language key line ("Hatched fill = holdings snapshot only, no transaction history"). *Test:
for each chart fixture, count of elements with `data-basis="snapshot"` equals count of `.hatch`
overlays in the same `<svg>`.*

**H6 — Provenance completeness.** Every row that displays a figure traceable to a document renders a
`SourceStamp`. Rows whose figures are computed render the `derived` variant. A row with a figure and
no stamp is a bug — except where D1 applies, where the panel-level statement covers the group and
the group carries exactly one stamp. *Test: every `tbody tr` containing an element with
`data-metric` has either a `.pmark` in its gutter cell or an ancestor with `data-stamp-scope`.*

**H7 — Staleness is never silent.** A price older than its TTL renders the `alert` stamp variant and
states the age in words next to the figure ("15 d old"). A missing price never falls back to a
previous value without saying so. Day change always names the close it was computed against; the
word "live" never appears. *Test: an element with `data-stale-days` above the TTL has an
`alert`-variant stamp in scope and its text matches `/\d+\s*d old/`.*

**H8 — Withheld value is named to the rupee.** The unresolved-instrument count is always accompanied
by the exact amount excluded from totals, taken from `unresolved_instrument.observed_value_minor`.
Net worth excludes it, and the calibration bar's total mark is drawn from the same figure.

**H9 — Alert ink discipline.** `--neg`, `--st-crit`, `--st-warn`, `--warn-ink`, `--st-serious` may
be applied only by `SourceStamp variant="alert"`, `Badge tone={'warn'|'crit'|'ok'}`, and the signed-
number classes `.pos`/`.neg`. *Test: a stylesheet lint asserts these tokens appear in no other
selector; a DOM test asserts no element outside those components has a computed colour equal to a
status token.*

**H10 — No back-fill in the history chart.** A class-month cell in the 12-month stacked chart is
drawn only where the value is measurable from stored positions and prices. Months before an
account's earliest known position render as an explicit gap with an annotation naming the date
history begins — never a flat line carried backwards. This is the one place a plausible-looking
interpolation would be easiest and most damaging.

**H11 — The local-only claim is derived, not asserted.** The status line's "Local · <path> · <size>"
is read from the actual database handle. It is a factual readout, not marketing copy, and must break
visibly if the fact ever changes.

**H12 — Capability is never editable from the UI.** `account.capability` is set by the ingestion
path (subsystem A). The Accounts screen displays it and explains what it unlocks; it offers no
control to change it. The only way to raise coverage is to import a document with transactions, and
the UI says exactly that.

---

## 6. Design tokens

Extracted verbatim from `final-consolidated.html`. Values are not reinvented; where the mockup left
a gap it is flagged as a gap rather than filled silently.

### 6.1 Colour — achromatic ground

| Token | Light | Dark | Use |
|---|---|---|---|
| `--page` | `#e8e8e8` | `#0b0b0b` | Window ground behind the app frame |
| `--surface` | `#fbfbfb` | `#1b1b1b` | Panels, cells, table body |
| `--surface-2` | `#f3f3f3` | `#232323` | App bar, panel heads, row hover, toolbars |
| `--surface-3` | `#e9e9e9` | `#2b2b2b` | Group header rows, micro-bar tracks |
| `--ink-1` | `#111111` | `#f0f0f0` | Primary figures, screen rules, boundary line |
| `--ink-2` | `#4a4a4a` | `#b6b6b6` | Secondary text, meter fill, stamp code |
| `--ink-3` | `#6d6d6d` | `#8c8c8c` | Labels, axis text, weight bars |
| `--ink-4` | `#8d8d8d` | `#707070` | Micro-notes, stamp reference line, "not measured" |
| `--rule` | `#dedede` | `#2f2f2f` | Hairlines between rows and cells |
| `--rule-2` | `#c6c6c6` | `#414141` | Section borders, panel outer border |
| `--tick` | `#ababab` | `#525252` | Minor axis ticks |

### 6.2 Colour — signed and status ink

Never a series colour. Governed by H9.

| Token | Light | Dark | Meaning |
|---|---|---|---|
| `--pos` | `#006300` | `#0ca30c` | Positive signed figure |
| `--neg` | `#b4302e` | `#e66767` | Negative signed figure; alert stamp |
| `--warn-ink` | `#8a5d00` | `#fab219` | Warning badge text |
| `--st-good` | `#0ca30c` | `#0ca30c` | Fresh / local indicator |
| `--st-warn` | `#fab219` | `#fab219` | Queue border, "needs mapping" |
| `--st-serious` | `#ec835a` | `#ec835a` | Reserved (unused in v1) |
| `--st-crit` | `#d03b3b` | `#d03b3b` | Stale beyond tolerance |

### 6.3 Colour — categorical, bound permanently to asset class

| Token | Light | Dark | `instrument.asset_class` | Default coverage in mockup |
|---|---|---|---|---|
| `--s1` | `#2a78d6` | `#3987e5` | `indian_equity` | ledger |
| `--s2` | `#eb6834` | `#d95926` | `mutual_fund` | ledger |
| `--s3` | `#1baf7a` | `#199e70` | `crypto` | ledger |
| `--s4` | `#eda100` | `#c98500` | `us_equity` | snapshot |
| `--s5` | `#e87ba4` | `#d55181` | `gold` | snapshot |
| `--other` | `#9a9a9a` | `#7d7d7d` | aggregate "Other" bucket | — |

**The binding is by asset class, not by rank.** `mutual_fund` is orange whether it is the largest
holding or the smallest, on every screen, forever. Hue never encodes size, sign, freshness or
capability. Capability is carried by the hatch; sign by the glyph and `--pos`/`--neg`; freshness by
stamp border style and badges.

**Gap: `bond` and `cash` have no validated slot.** The schema defines seven asset classes; the
palette validates five. v1 renders `bond` and `cash` with `--other` and requires them to be directly
labelled in every context (which the colour-independence rule requires anyway, so nothing is lost
but distinguishability between the two). Adding `--s6`/`--s7` is a palette task: two new hues
validated for ≥4.5:1 against both `--surface` values and for separability from the existing five
under the three common CVD simulations. Tracked in §14.

### 6.4 The 45° hatch — the snapshot convention

One meaning, everywhere, no exceptions: **45° hatching marks value for which Misal has no
transaction history**, and by extension the portion of a meter that is not measured.

In SVG, one shared pattern defined once per document and referenced by every chart:

```svg
<pattern id="hx" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
  <rect width="6" height="6" fill="none"/>
  <line x1="0" y1="0" x2="0" y2="6" stroke="var(--surface)" stroke-width="2"/>
</pattern>
```

The stroke is the *surface* colour, so the hatch carves gaps out of the fill rather than painting
lines on top of it. That is why it works unchanged in both themes and over all five hues. Applied as
a second, identically shaped element on top of the coloured one — never as a fill replacement, so
the asset-class hue survives underneath.

In CSS, the equivalent is `repeating-linear-gradient(45deg, …)` at the same 45°:

- `.badge-snap` — `transparent 0 3px, var(--surface-3) 3px 6px`
- account rails `.r4`,`.r5` — `var(--surface) 0 1.5px, transparent 1.5px 4px`
- legend swatch `.sw-h` — surface at 95% alpha, `0 2px, transparent 2px 5px`
- coverage meter track — `var(--surface-2) 0 3px, var(--surface-3) 3px 6px`
- currency split bar, USD leg — `var(--ink-4) 0 2px, var(--surface) 2px 5px`

### 6.5 Rhythm and measure

- **18px baseline.** `body { font-size: 12px; line-height: 18px }`. Body line boxes are 18px. The
  source stamp is exactly 18px tall (11px code block + 7px reference line) so it drops into any row
  without changing its height. This is the reason the stamp is two stacked blocks of those specific
  heights, and it must not be altered casually.
- **Tables run denser.** `font-size: 11px; line-height: 16px`, `td` padding `5px 9px` → a 26px row.
  The 18px stamp fits inside a 26px row. Do not "fix" the table to 18px; the density is deliberate
  and the mockup's information density is the reason Direction B won.
- **`--gutter: 56px`.** The provenance gutter width, identical in tables, readout cells, account
  rows, queue items and split panels. It is the single most repeated measurement in the design and
  the thing that makes five different layouts read as one instrument. Never varies.
- **Spacing** in use: `1px` (grid gaps that become hairlines via a `--rule` background), then `4 6 8
  9 12 14 16 22 24` px. Panel body padding `12px`; app padding `16px`; grid gap `14px`.
- **Layout floor 1024px**, with breakpoints at `1360px` and `1140px` reducing the fixed columns of
  the dashboard grids and the readout hero. Horizontal overflow is confined to `.app` and `.panel`
  (`overflow-x: auto`); **the page body never scrolls horizontally.**

### 6.6 Type

One family: the monospace stack, everywhere, with `font-variant-numeric: tabular-nums` set globally
on `body`. Two weights only: 400 and 700.

| Token | Size / line | Used for |
|---|---|---|
| `--fs-micro` | 7.5 / 7 | Stamp reference line |
| `--fs-stamp` | 8 / 9 | Stamp code, dim axis labels, meter scale, threshold captions |
| `--fs-label` | 9 / 18 | `lab`, `sublab`, badges, table `th`, sub-lines, "Not measured", foots |
| `--fs-meta` | 10 / 18 | Nav, status line, panel titles, buttons, legend, calibration head |
| `--fs-body` | 11 / 16 | Table body, prose |
| `--fs-base` | 12 / 18 | Default; account names; raw identifiers in the queue |
| `--fs-strong` | 13 / 18 | Screen titles, calibration readout figure |
| `--fs-lead` | 14 / 20 | Import result headline |
| `--fs-inst` | 17 / 22 | Instrument name |
| `--fs-val` | 19 / 26 | Readout cell values |
| `--fs-dq` | 20 / 26 | Data-quality numerals |
| `--fs-nav` | 24 / 30 | Instrument NAV |
| `--fs-hero` | 38 / 44 | Net worth (32 / 38 below 1140px) |

**Tracking rule.** Uppercase micro-type is always tracked, between `.08em` and `.30em` — labels
`.20em`, panel titles `.18em`, nav `.16em`, badges `.14em`, legend `.08em`, the wordmark `.30em`.
Sentence-case body text is never tracked. Large figures are tightened: `-.01em` at 19px, `-.02em` at
38px.

**In-fill chart labels** use `fill: #0d0d0d; font-weight: 700; paint-order: stroke` with a 3px
stroke halo in the segment's own hue. This is what lets a near-black label sit on any of the five
hues, over the hatch, in both themes, at ≥4.8:1. It is a specific technique, not a style choice —
keep it.

### 6.7 Theme switching

Three states. Bare `:root` carries the complete light palette. `@media (prefers-color-scheme: dark)`
guarded as `:root:not([data-theme="light"])` redefines only the tokens that change.
`:root[data-theme="dark"]` redefines them again so the manual override wins in both directions.
`color-scheme` is set alongside so native scrollbars and form controls follow. No colour has its
only definition inside a media query.

---

## 7. State model for every data-bearing component

Four states, specified per component, plus a fifth that is specific to this product.

**Loading.** A layout-preserving skeleton: `--surface-3` blocks at the exact height of the content
they replace, including the 56px gutter. Never a spinner, never a layout shift, and **never a fake
numeral** — a skeleton that renders plausible digits is a lie told in the moment the user is most
likely to believe it.

**Empty.** A sentence naming what is absent and the action that would fill it. Never a zero-valued
rendering of the real component.

**Error.** The panel head persists, so the user knows *what* failed; the body is replaced by a
message, the error code and a Retry. Data errors are never toasts — a toast vanishes and the wrong
number does not.

**Stale.** Query `isFetching` with existing data: the previous value stays visible,
`data-refreshing` is set, and a 1px `--ink-3` progress rule animates under the panel head. Values
are never blanked during a refetch; they carry an as-of stamp, so showing the old one is honest.

**Partial.** The product-specific fifth state: the component has data, but the data cannot answer
the question for part of the portfolio. This is `NotMeasured` plus coverage, and it is a *success*
state, styled as one. It is not an error and must never use alert ink.

Component-by-component:

| Component | Empty | Error | Stale |
|---|---|---|---|
| CalibrationBar | Ruler, no segments, "Nothing measured yet" (§10.1) | Ruler with an error caption; net worth suppressed | Refresh rule; caret unchanged |
| Readout cells | Not rendered at all on first run | Whole grid replaced by one error panel | Per-cell `data-refreshing` |
| HoldingsTable | "No positions yet" + import CTA; if filtered: "No positions match this filter" | Header row retained, body replaced | Rows retained, toolbar refreshing |
| AllocationTable | Not rendered (implied by empty portfolio) | Panel-level | Retained |
| ConcentrationChart | "Fewer than 2 positions — nothing to concentrate" | Panel-level | Retained |
| NetWorthStackChart | "History begins after your first import" | Panel-level | Retained |
| DataQualityStrip | `—` with a stated reason; the one place a dash is allowed, because these cells count things rather than measure value | Cell-level | Retained |
| AccountRow / list | First-run screen instead (§10.1) | Full-panel | Per-row last-synced refresh |
| ImportReport | "No imports yet" | Full-panel | n/a (immutable once complete) |
| UnresolvedQueue | "Nothing unresolved — every identifier in every document is mapped." | Panel-level | Retained |
| InstrumentDetail | Route-level not-found | Full-screen error with back link | Per-panel |

---

## 8. Component inventory

Interfaces are abbreviated to what is load-bearing. `Reads:` lists the schema fields (subsystem A)
or valuation outputs (subsystem D) that feed the component.

### 8.1 `CalibrationBar` — the signature component

The full-width bar on a real rupee scale showing what fraction of net worth the history-dependent
metrics can measure. It is a requirement, not decoration.

```ts
interface CalibrationBarProps {
  segments: Array<{
    assetClass: AssetClass;
    value: Money;            // absolute, for the ruler position
    share: Pct;              // labelled inside the segment
    basis: 'ledger' | 'snapshot';
  }>;
  netWorth: Money;
  ledgerBacked: Money;   ledgerPct: Pct;
  snapshotOnly: Money;   snapshotPct: Pct;
  accountsLedger: number; accountsTotal: number;
  scaleMax: Money;       // rounded up to a clean ₹5L/₹50L/₹5Cr step
  state: 'ready' | 'loading' | 'empty' | 'error';
}
```

**Composition (fixed by the mockup).** Segments in a single 46px-tall row, ordered ledger-first by
descending value then snapshot by descending value, so the boundary is a single line rather than an
interleaving. Snapshot segments carry the hatch overlay. The final segment gets a 4px rounded outer
cap. Below: a ruler with major ticks every ₹5L (labelled) and four minor ticks between. Over the
boundary: a 2px `--ink-1` line with a downward caret, flanked by `71.9% LEDGER-BACKED · ₹34,73,722`
(right-aligned, `--ink-1`) and `28.1% SNAPSHOT ONLY · ₹13,58,428` (left-aligned, `--ink-3`). Top
right: `NET WORTH ₹48,32,150` with a total mark on the axis. Beneath the excluded region: a bracket
captioned `NO HISTORY — XIRR, COST BASIS & REALISED P&L EXCLUDE ₹13,58,428`. Segment labels sit
inside where the segment is wide enough (≥ ~90px) and outside above otherwise (as `GOLD 4.97%`
does).

**States.** `ready`; `loading` (ruler drawn, segments as skeleton blocks); `empty` (§10.1); `error`.
There is no zero state — 0% coverage is a legitimate `ready` state and must render as a fully
hatched bar with the caret at the origin. It is a fixture (§13.4).

*Reads:* `account.capability`, `position.quantity`, `instrument.asset_class`, `instrument.currency`,
`price.close`, `fx_rate.rate`; coverage split from D.

### 8.2 `SourceStamp` — the marginal source mark

```ts
interface SourceStampProps {
  code: string;                 // 'CAS' | 'KIT' | 'GRW' | 'DCX' | 'ETR' | 'DRV'
  reference: string;            // 'p.4-9' | 'r.318' | 'api key' | 'fifo' | 'csv 15 d'
  variant: 'ledger' | 'snapshot' | 'derived';
  alert?: boolean;              // stale, estimated or unresolved
  document?: { id: string; name: string; hashShort: string; importedAt: string; runId?: string };
  description: string;          // full sentence, used for hover/focus and aria-describedby
}
```

Always a `<button>`, always in the 56px gutter, never inline in a data cell. 18px tall: an 11px
bordered code block over a 7px reference line.

**Border style carries data health so colour need not**: solid = ledger-backed and current; dashed =
snapshot only; dotted (and `--ink-3` text) = derived rather than observed; `--st-crit` border with
`--neg` text = stale, estimated or unresolved. That last is the *only* colour variant, which is what
frees alert ink to mean exactly one thing everywhere else.

**States:** default, hover (border and text darken one step), focus-visible (§11.3), open (a
provenance popover: document name, short checksum, page reference, import timestamp, and a link to
the import run), and disabled/absent (an empty gutter spacer, `aria-hidden`, used only where D1
applies).

*Reads:* `source_document.provider_id` → short code (§14, gap), `source_document.page_ref`,
`source_document.content_hash`, `source_document.imported_at`, `source_document.original_name`,
`account.capability` → variant, `price.fetched_at` → alert, `import_run.id` → link.

### 8.3 `StampKeyPopover`

Per D2. Content is the mockup's two key rows verbatim: the six codes with their document
descriptions, the reference-line explanation, and the four border styles with their meanings.
Rendered as a dialog (`role="dialog"`, `aria-modal="false"`, focus trapped while open, Escape
closes, focus returns to the opener). Triggered by the `?` button, `Shift + /`, or the first-run
inline expansion.

### 8.4 `ReadoutGrid`, `StatCell`, `HeroStatCell`

The dashboard readout: a `356px + 3×1fr` grid, two rows, 1px `--rule` gaps rendered as a background
so cell edges are hairlines. The hero spans both rows.

```ts
interface StatCellProps {
  label: string;                       // 'XIRR — annualised'
  value: Measured<Money | Pct>;
  sub?: Array<{ label: string; value: Measured<Money | Pct>; tone?: 'pos'|'neg'|'muted' }>;
  coverage?: { pct: Pct; amount: Money };   // REQUIRED when metric ∈ HISTORY_DEPENDENT (H2)
  meter?: { pct: Pct };                // achromatic coverage meter
  split?: { aPct: Pct; bPct: Pct; aLabel: string; bLabel: string };  // currency exposure
  note: string;                        // the 9px micro-note; always present
  metric: MetricId; scope: 'portfolio'|'class'|'account'|'position';
  stamp?: SourceStampProps;            // omitted under D1
}
```

The seven v1 cells: net worth (hero, with day change ₹ and %, ledger/snapshot split and a counts
line), invested/cost basis, unrealised P&L, XIRR (with meter), realised P&L FY with STCG/LTCG
sub-rows, currency exposure (with split bar), concentration top-5.

`coverage` is not optional in practice: a `MetricId` in `HISTORY_DEPENDENT` without `coverage` is a
runtime throw in development and a failing test in CI (H2).

**Sub-components.** `CoverageMeter` — 9px, achromatic on purpose (coverage is not an asset class): a
`--ink-2` fill over a 45°-hatched track with 10% gridlines, plus a `0 25 50 75 100%` scale.
`SplitBar` — 11px, solid `--ink-2` for INR against a hatched `--ink-4` leg for USD, with both
percentages labelled beneath.

*Reads:* D's portfolio valuation output in full; `fx_rate` for the currency cell; settings for the
single-position threshold (§14).

### 8.5 `Metric` and `NotMeasured`

```ts
interface MetricProps {
  value: Measured<Money | Pct | Qty>;
  metric: MetricId; scope: Scope; basis: Basis;
  coverage?: { pct: Pct; amount: Money };
  size?: 'cell' | 'value' | 'hero';
  signed?: boolean;
}
```

The only sanctioned renderer for a history-dependent figure. Emits the `data-*` contract of §5. When
`value.measured === false` it delegates to `NotMeasured`, which renders the literal "Not measured"
in `--ink-4`, 9px, uppercase, tracked `.10em`, plus a reason. Reason copy is fixed:

| Reason | Cell text | Explanation surfaced on hover / in the panel foot |
|---|---|---|
| `snapshot-account` | Not measured | This account supplies holdings only — Misal has no transaction history for it. |
| `partial-history` | Not measured | History starts {date}; the position existed before it. |
| `no-price` | Not priced | No price source for this instrument. Set a manual price to include it. |
| `unresolved-instrument` | Not counted | Identifier {raw} is unmapped. ₹{amount} is withheld from totals. |
| `unsupported-action` | Not measured | A corporate action on {date} cannot be modelled exactly. |

### 8.6 `HoldingsTable`

Eleven columns: gutter, Instrument (250px, name + sub-line with exchange/ISIN), Accounts, Quantity,
Avg cost, Last price, Value ₹, Unrealised ₹, Unrealised %, Weight (numeral + 54px micro-bar), Day %.

```ts
interface HoldingsTableProps {
  rows: HoldingRow[];
  group: 'asset_class' | 'account' | 'instrument' | 'none';
  sort: { column: ColumnId; dir: 'asc' | 'desc' };
  filters: { accountIds: string[] | 'all'; coverage: 'all' | 'ledger' | 'snapshot' };
  columns: Set<ColumnId>;
  onOpenInstrument(id: string): void;
  state: LoadState;
}

type HoldingRow =
  | { kind: 'group'; assetClass?: AssetClass; label: string; positions: number;
      value: Money; share: Pct; capability: Capability }
  | { kind: 'position'; instrumentId: string; /* … */
      quantity: Qty; lastPrice: Money; lastPriceAsOf: string; staleDays: number;
      value: Money; weight: Pct; dayPct: Pct;
      avgCost: Measured<Money>; unrealised: Measured<Money>; unrealisedPct: Measured<Pct>;
      stamp: SourceStampProps }
  | { kind: 'total'; /* … totals, with cost/unrealised over ledger scope only */ };
```

The group header row carries a class dot, the group's position count, value, share and a capability
badge; snapshot groups read `Snapshot — no transaction history`. The total row's cost and unrealised
columns are labelled `total cost · ledger` — they are ledger-scope subtotals presented in a
whole-portfolio row, which is the single most misreadable cell in the design and therefore carries
its own sub-label plus the panel foot restating coverage in rupees and percent.

*Reads:* `position`, `instrument.*`, `instrument.precision`, `account.label`, `account.capability`,
`price.close`/`as_of`/`fetched_at`, `fx_rate`; cost, unrealised and weight from D.

### 8.7 `AllocationTable` and `CoverageByMetricTable`

Allocation: gutter, Asset class (dot + name + sub-line "3 schemes · CAS"), Value ₹, Weight + micro-
bar, Day %, Coverage badge; total row with a `71.9% ledger` badge.

Coverage-by-metric: one row per metric group — net worth/day change (`Exact`), cost basis and
unrealised (`Partial`), XIRR (`Partial`), realised P&L FY (`Partial`) — each with the covered amount
and percentage. This table is the plain-English restatement of the calibration bar and is the
component a sceptical user will read first. Its foot is fixed copy: *"Partial metrics are computed
on ledger-backed value only. Misal does not estimate the remainder."*

*Reads:* D's per-class aggregation; `account.capability` for the coverage column.

### 8.8 `DataQualityStrip`

Four equal cells: stale prices (count + which and how old), unresolved instruments (count + a
`Review queue` link, plus the withheld rupee amount per H8), accounts (count + `4 ledger · 2
snapshot`), price feed (last fetch time + the source list).

*Reads:* `price.fetched_at` vs TTL (§14), `unresolved_instrument` count and `observed_value_minor`,
`account.capability` counts, price provider metadata.

### 8.9 Charts and their primitives

Shared module `charts/primitives`:

```ts
// The ONLY place a decimal becomes a JS number. Output is a pixel, never a displayed figure.
function scaleLinear(domain: [Dec, Dec], range: [number, number]): (v: Dec) => number;

<ChartFrame viewBox width height label={string} tableFallback={ReactNode}/>  // role="img"
<HatchDefs/>                     // the single <pattern id="hx"> per document
<GridLines axis="x"|"y" at={Dec[]} format={(d)=>string}/>
<TickRule from to major={Dec[]} minor={Dec[]} format/>   // the rupee ruler
<StackedColumns series={…} order="ledger-first"/>
<HBar value cap="rounded" r={4} hatched/>                // rounded outer end only
<PolyLine points endDot/>                                // NAV history
<Rug marks={{up: Dec[], down: Dec[]}}/>                  // transactions under the axis
<Boundary at={Dec} caret labelLeft labelRight/>          // the calibration boundary
<Bracket from to caption/>                               // the excluded-amount annotation
<Threshold at={Dec} caption/>                            // the 20% single-position flag
<Legend items={{token, label, hatched}[]}/>
```

`ConcentrationChart` — horizontal bars, top 10 of N plus an `Other (n positions)` aggregate in
`--other`; each bar in its asset-class hue, hatched when snapshot; label right-anchored at the left,
value labelled after the bar end; a vertical threshold line at the single-position flag with its
caption below the plot. Every bar is directly labelled, so the chart reads with all colour removed.

`NetWorthStackChart` — twelve month-end stacked columns, 22px wide, 53px pitch, ₹10L gridlines,
month + year axis labels, the final column's total labelled above it, ledger classes stacked at the
bottom and snapshot classes on top so the coverage line reads within each column. Snapshot segments
hatched. Governed by H10: unmeasurable months are gaps with an annotation, never back-filled. The
top segment of each column gets a 4px rounded cap.

`NavHistoryChart` — a single 2px `--s2`-class line with an end dot and an end label, ₹5 gridlines,
six axis ticks, and a transaction rug beneath the axis (1px `--ink-3` upward marks for purchases,
2px `--ink-1` downward for redemptions) with counted captions at each end.

*Reads:* `price` history, `txn.occurred_at`/`type` for the rug, D's month-end series.

### 8.10 `AccountRow` and `AccountList`

An 8-column grid: gutter, 6px asset-class rail (hatched for snapshot accounts), name + provider
sub-line, capability badge (`Full history` / `Holdings only`, the latter hatched), value, holdings
count, last-synced + source sub-line, action button (`Re-sync` for API accounts, `Re-import` /
`Import CSV` for statement accounts).

The screen also carries the two "Add an account" doors (statement / read-only key) and the `What
each capability unlocks` table — a five-row Yes / Not-measured matrix plus the contribution to the
calibration bar, footed with the concrete consequence: *"Uploading an E\*TRADE transaction history
would move ₹11,18,428 across the calibration line and raise coverage to 95.0%."* That sentence is
computed, not static: it is the product telling the user exactly what to do to make its numbers
better, and it is the strongest argument on the screen.

*Reads:* `account.*`, `provider.display_name`/`kind`, `credential_ref.kind`/`last_used_at`,
`source_document.imported_at` (derived last-synced, §14), position counts and values from D.

### 8.11 `ImportReport`

Composed of: `ResultBanner` (a `--st-good` left rule, a headline stating what completed and what
needs input, and a second line making explicit that nothing was rolled back), `SourceDocumentPanel`
(a definition list: file, parser + version, unlock method, period covered, checksum, read-from — see
D4), `WhatWasReadTable` (folios, schemes, transactions read / applied / duplicate-skipped, closing
positions reconciled, rows with errors, unresolved instruments — each stamped), and `RowErrorsTable`
(location, row summary, reason, each with an alert stamp).

The framing is fixed and matters: a partial import is a **completed** import. The banner is
`--st-good`, the errors are a list, and the foot explains that re-importing a corrected statement
skips everything already present.

*Reads:* `import_run.*`, `import_issue.*`, `source_document.*`.

### 8.12 `UnresolvedQueue` / `QueueItem`

Each item: gutter stamp (alert variant), a `--st-warn` left rule, the raw identifier in 12px bold, a
context sub-line (name, units, value), a status badge, and a mapping row — a search combobox
pre-filled with the best candidate, a confidence readout (`Match 0.96 · AMFI master` or `No
confident match`), and the actions Map / Create new / Ignore, with a domain-specific extra action
where one applies (`Exclude derivatives`). A `Dismiss for now` control with the standing promise
that dismissed items live in Settings → Review queue and the import stands regardless.

The panel foot states the effect on coverage of resolving the item, including when the honest answer
is *no effect*: *"mapping CAT-RSU-VEST-2024-11 does not add history — E\*TRADE supplied positions
only, so coverage stays at 71.9%."*

**Never blocks.** The queue has no modal, no "resolve before continuing", no badge that gates
navigation beyond a count.

*Reads:* `unresolved_instrument.*`, `instrument`/`instrument_alias` for candidates, D for the
coverage delta.

### 8.13 `InstrumentDetail`

Header (name, class dot, asset class, AMFI/ISIN/scheme identifiers, capability badge; right side:
last price with as-of date and 1D change). A four-cell `SplitPanel` of stats (units held, current
value, invested FIFO cost, XIRR) each with its own gutter stamp. Then `NavHistoryChart`,
`PositionByAccountTable` (per folio: units, avg NAV, cost, value, unrealised, plus a total row),
`PnlSplitTable` (unrealised over open lots, realised lifetime, realised per financial year),
`OpenLotsTable` (acquired date, account, units, NAV, cost, current value, Long/Short badge, oldest
first, truncated with an "N more open lots" row) and `TransactionsTable` (date, type, account,
units, NAV, amount, most recent first, similarly truncated).

For a snapshot-backed instrument the FIFO, XIRR, lots and realised panels are replaced by a single
`NotMeasured` panel naming the account and the reason — not rendered empty, and not rendered with
zeros.

*Reads:* `instrument.*`, `instrument_alias`, `position`, `txn.*`, `price` history, `source_document`
per row; lots, XIRR and realised splits from D.

### 8.14 Chrome primitives

`AppBar` (5-item nav with `aria-current="page"`, plus the status line), `StatusLine` (local
indicator + db path + size, base currency, USD/INR, price timestamp, `?` button; items drop at
narrow widths in a fixed order), `Panel`/`PanelHead`/`PanelFoot`, `Toolbar` with `Select` and
`Button`, `Badge` (tones: neutral, snapshot-hatched, ok, warn, crit), `ClassDot` (8px,
`aria-hidden`, always adjacent to the class name in text), `WeightBar`, `Legend`, `EmptyState`,
`ErrorState`, `SkeletonRow`.

---

## 9. Screens and navigation

| # | Route | Screen | Purpose |
|---|---|---|---|
| 01 | `/` | Dashboard | Calibration bar, readout, allocation + coverage, 12-month history, concentration, data quality, sync log |
| 02 | `/holdings` | Holdings | Every current position, groupable, with snapshot rows visibly withholding cost and P&L |
| 03 | `/accounts` | Accounts | Capability per account, last synced, the two ways to add one, what each capability unlocks |
| 04 | `/import`, `/import/:runId` | Import review | Import report and the unresolved queue |
| 05 | `/instruments`, `/instruments/:id` | Instruments | An index of every instrument ever held, and the detail screen |

`/instruments` (index) and `/holdings` are deliberately different: Holdings is current positions
with valuation; the instrument index includes fully exited instruments, which is where realised P&L
and closed lots live. Without it, closing a position makes its history unreachable.

**Router.** `createHashRouter` from React Router v6. Justification: it needs no server rewrite rules
under the Tauri asset protocol, in the Vite dev server, or in the later static build, and the URL is
not user-visible chrome in a desktop app. Deep-link stability across the three surfaces is worth
more than a pretty path.

**Navigation.**

- `Cmd/Ctrl + 1…5` jump to the five screens. `Cmd + [` / `Cmd + ]` are back/forward.
- Cross-screen links carry state: data-quality "Review queue" → `/import?tab=queue`; an allocation
  row or class dot → `/holdings?group=asset_class&focus=mutual_fund`; a stamp popover's "Open import
  #47" → `/import/47`; any instrument name anywhere → `/instruments/:id`.
- On every route change focus moves to the screen's `<h1>` and the document title updates, so a
  screen-reader user is told where they are.
- The detail screen is a pushed route with an explicit back affordance; there are no modals in v1
  except the stamp key and the file picker (which is native).

---

## 10. Empty states

### 10.1 First run — the screen that sets the tone

A new user has no accounts, no positions and no database contents. The route `/` detects
`accounts.length === 0` and renders `<FirstRun/>` **instead of** the dashboard. It never renders a
dashboard of zeros: a net-worth tracker showing ₹0 is claiming a measurement it has not made, which
is exactly the failure mode the whole product exists to avoid.

Composition, top to bottom:

1. **The masthead and the app frame**, unchanged. The product looks like itself immediately.
2. **The calibration bar, empty but drawn.** The ruler, its major and minor ticks and its axis are
   rendered in `--ink-4` on an indeterminate scale; there are no segments, no boundary caret and no
   total mark. The readout reads `Nothing measured yet`, and the description line keeps its
   permanent copy: *"What fraction of net worth the deeper metrics can actually measure."* An
   instrument that is calibrated and has nothing to measure is the correct picture of the situation,
   and it teaches the bar's meaning before there is any data to obscure it.
3. **One headline, lifted verbatim from Direction C** per the mockup README:
   **"All data on this Mac · nothing leaves the device."**
   Platform-adaptive — *this Mac* / *this PC* / *this machine*.
   Beneath it, one sentence naming the file that will be created and where: *"Misal will create one
   encrypted SQLite database at ~/Library/Application Support/Misal/misal.db. The key is stored in
   your macOS Keychain."*
4. **Two doors**, the same pair as the Accounts screen, at full width:
   - **Import a statement** (primary, `btn-strong`) — CAMS/KFintech CAS PDF, NSDL/CDSL holding
     statement, broker tradebook CSV, exchange ledger CSV. Body copy states the consequence plainly:
     *"A statement with transactions gives full history. A holdings-only file gives a snapshot —
     current value only, no cost basis, no XIRR."* This is the moment the ledger/snapshot
     distinction must be taught, because it is the moment that determines what the user gets.
   - **Connect a read-only API key** — Zerodha Kite, CoinDCX, WazirX. *"The key is stored in the OS
     keychain on this machine and is never transmitted anywhere except to the exchange.
     Withdrawal-enabled keys are rejected."*
5. **A third, quiet door: "Look around with sample data."** Small, `--ink-3`, below the two. It
   loads a synthetic portfolio matching the mockup's fixture. Justification: a tool that shows
   nothing until the user hands it their complete financial history has a trust problem in precisely
   the moment trust is being formed, and the calibration bar cannot be understood from an empty
   ruler. Sample mode is unmistakable: a `SAMPLE DATA` block in the masthead using the inverted
   `screen-no` treatment (ink on page — achromatic, so it does not spend alert colour), a persistent
   `Clear sample data` control, and export disabled while active.

What is deliberately **absent**: no onboarding carousel, no sign-up, no email field, no telemetry
prompt, no "connect your broker" upsell for providers v1 cannot serve unattended, no progress
checklist. Three sentences of chrome, two buttons, one honest empty instrument.

Focus lands on **Choose file…** on mount.

### 10.2 Subsequent empty states

Accounts exist but no positions parsed → Holdings shows *"No positions yet — import #{n} completed
but produced no holdings"* with a link to that import report. Import screen with no runs → *"No
imports yet."* Queue empty → *"Nothing unresolved — every identifier in every document is mapped to
an instrument."* Instrument index empty → the first-run doors again, scoped.

---

## 11. Accessibility

### 11.1 Keyboard navigation

- Every interactive element is a real `<button>`, `<a>` or form control. Nothing is a `div` with an
  onClick. The mockup already does this, including the stamps.
- **Tables do not put every row in the tab order.** 300 rows × 2 tabbables = 600 tab stops is
  unusable. Instead: a `Skip table (300 rows)` skip link precedes every table; within the table, a
  roving `tabindex` on the instrument-name column gives arrow-key row navigation with Home/End and
  PageUp/PageDown, and `Enter` opens the instrument. The gutter stamp of the focused row is
  reachable with `Shift + Tab` from the roving element.
- Toolbar controls are a single tab stop with arrow-key traversal between them.
- Global: `Cmd/Ctrl + 1…5` for screens, `/` focuses the instrument search, `Shift + /` opens the
  stamp key, `Escape` closes any popover and returns focus to its opener.

### 11.2 Focus management

Route change → focus to the screen `<h1>`. Popover open → focus into the popover, trapped; close →
focus returns to the trigger. Import completion → focus moves to the result banner, which is also an
`aria-live="polite"` region. A destructive action (delete account, clear sample data) uses a
confirmation whose default focus is the cancel control. **Focus is never lost to `<body>`** — a
keyboard-walk test asserts this after every navigation and every mutation.

### 11.3 Visible focus

`:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px }` with `--focus` achromatic
per D3, plus a 1px `--surface` inner ring so the outline survives on coloured chart segments. It is
never removed, never replaced with a background change alone, and its contrast is checked against
`--surface`, `--surface-2`, `--surface-3` and all five series hues in both themes.

### 11.4 Colour-independence

**The test is absolute: remove all colour and every figure must remain readable and correctly
attributed.**

- Asset class is *always* accompanied by its name in text. `ClassDot` is `aria-hidden` decoration.
- Every chart bar and segment is directly labelled with its name and value; nothing requires a
  legend lookup to be read.
- Snapshot status is carried by the 45° hatch, by the dashed stamp border, and by the words
  `Snapshot` / `Holdings only` / `no transaction history` — three independent channels.
- Sign is carried by `+` and `−` glyphs; `--pos`/`--neg` are redundant reinforcement.
- Freshness is carried by stamp border style plus a badge with words (`Fresh`, `3 d old`, `15 d
  old`) — never by colour alone.
- Data health across the whole design is encoded by **border style** (solid / dashed / dotted)
  specifically so that colour is free to mean asset class and nothing else.

Enforced by a greyscale visual-regression pass (§13.5) and by a DOM test asserting no element
conveys state through a colour class without a text or shape counterpart.

### 11.5 Screen readers

Charts are `role="img"` with a complete sentence as `aria-label` ("Calibration bar: 71.9 percent of
net worth is backed by full transaction history"). Charts with more than six data points
additionally render a visually hidden `<table>` of their values — the stacked history chart and the
concentration chart both qualify; the mockup's approach of pointing at a neighbouring table is
retained as the *visible* affordance but is not relied on for the accessible name.

Tables use real `<th scope>`; group header rows are `<th scope="rowgroup">`. `NotMeasured` text is
read as-is, which is the whole point: a screen-reader user hears "Not measured" where a sighted user
sees it, and neither hears nor sees a zero.

### 11.6 Motion, zoom, density

`prefers-reduced-motion` disables the only two animations in the product (the refresh progress rule
and the popover fade). The layout floor is 1024px; horizontal scrolling is confined to `.app` and
`.panel`. Dense data tables at 400% zoom are a documented limitation — the chrome reflows, the
tables scroll within their container, and the page body never scrolls horizontally.

---

## 12. Data flow, end to end

```
SQLite (SQLCipher)
   │  Rust repository fns — own their transaction, return plain records
   ▼
Tauri command surface  ── all numerics as strings ──▶  @misal/contracts (generated types)
   ▼
TanStack Query  (queryFn = invoke, or invoke + valuation)
   ▼
Subsystem D — valuation in TypeScript, decimal.js throughout
   ▼
View-models  — Money / Qty / Pct / Measured<T>, coverage attached at construction
   ▼
Components   — format at the display boundary only
```

Three rules that keep this from decaying:

1. **Components never call `invoke` directly.** All access is through hooks in `queries/`. This is
   what makes the invalidation graph in §2.2 complete and auditable.
2. **Coverage is attached where the view-model is built, not where it is rendered.** A view-model
   for a history-dependent metric that lacks coverage is invalid at construction. Attaching it in
   the component is how it gets forgotten in the second component.
3. **The valuation call is measured.** If a full portfolio revaluation exceeds a 16 ms budget on the
   500-row fixture, move it into a Web Worker behind the identical query interface (Comlink). Do not
   pre-emptively worker it; do not let it block a keystroke either.

Long-running imports stream progress over a Tauri event (`import:progress`) into a query cache
entry, so the report screen shows real progress rather than an indeterminate bar, and the completion
event triggers the invalidation cascade.

---

## 13. Testing

### 13.1 Unit

Formatters and comparators, property-tested with `fast-check`:

- `formatMoney(parseMinor(s))` round-trips every digit for random 18-digit minor values.
- `formatQty` preserves trailing zeros and never re-rounds an already-rounded value.
- Indian grouping is correct across 1–15 digit integers (the 2-2-3 rule, not 3-3-3).
- Sort comparators order 18-decimal crypto quantities correctly — the case where `parseFloat` would
  silently pass at small magnitudes and fail at large ones.
- No formatter output ever contains `e+`, `NaN`, `Infinity` or `undefined`.

### 13.2 Component tests and the honesty suite

Vitest + Testing Library + jsdom. **Every component test ends by calling `assertHonest(container)`**
— one shared DOM-walking assertion implementing H1–H12 against the `data-*` contract of §5. This is
the mechanism that stops the promise eroding component by component: a new component that renders a
figure without coverage, or a zero where a metric is unmeasurable, fails its own test without anyone
remembering to write an honesty test for it.

Named suites additionally assert each invariant against a hostile fixture:

- H1: a mixed portfolio renders `Not measured` for exactly the snapshot positions' cost columns.
- H2: every rendered history-dependent metric carries both coverage attributes.
- H3: fixture-wide scan for forbidden placeholder renderings.
- H5: hatch overlay count equals snapshot segment count in every chart.
- H6: every figure-bearing row has a stamp in scope.
- H7: the 15-day-stale gold row renders an alert stamp and the words "15 d old".
- H8: the withheld amount displayed equals the sum of `observed_value_minor` in the fixture.
- H10: the history chart on a fixture whose US-equity account starts in month 7 renders six gaps and
  one annotation, and zero back-filled segments.

### 13.3 Type-level tests

`expect-type` / `@ts-expect-error` assertions, run by `tsc` in CI:

- `Minor + Minor` does not compile.
- `Number(money.minor)` does not compile.
- A snapshot position view-model has no `costBasis` property of type `Money` — only
  `Measured<Money>`, and narrowing to `measured: false` provides no `value` to render.

These are the H4 enforcement. They are cheap and they are the only tests that cannot be forgotten.

### 13.4 Fixtures

A shared fixture set, frozen clock, used by component tests, screen tests and visual regression:

| Fixture | Why it exists |
|---|---|
| `mockup` | Reproduces the approved mockup's numbers exactly, so a rendered screenshot is diffable against the approved HTML itself |
| `empty` | First-run |
| `all-snapshot` | 0% coverage: every history-dependent metric `NotMeasured`, bar fully hatched, caret at the origin. The harshest honesty case, and the one a "sensible default" would break first |
| `all-ledger` | 100% coverage — no hatch anywhere, no `NotMeasured`, coverage reads 100.0% (and is still displayed) |
| `unresolved-heavy` | Large withheld amount; queue with all three item shapes |
| `stale-everything` | Every price past TTL; asserts the UI is legible when saturated with alert stamps |
| `perf-500` | 500 positions across 12 accounts, for the render budget |

### 13.5 Visual regression

Playwright against the Vite dev server rendering a fixture-driven route gallery with a frozen clock
and frozen fonts. Matrix: 5 screens × {1440, 1360, 1140, 1024} × {light, dark} × {colour, greyscale
filter}, tolerance 0.1%.

**Why visual regression earns its keep here more than in a typical app.** The meaning in this design
is carried by things unit tests cannot see: a border style that distinguishes derived from observed,
a 45° hatch that distinguishes measured from unmeasured, a 1px hairline that separates a subtotal
from a total, and a 56px gutter that ties five layouts together. Every one of those regresses
silently. The greyscale pass is a direct test of the colour-independence rule (§11.4): if a
greyscale screenshot is ambiguous, the design has failed regardless of what the DOM says.

The first baseline is the approved mockup rendered with the `mockup` fixture. Divergence from it
must be an intentional, reviewed commit.

### 13.6 Accessibility and performance

`axe-core` runs in every screen test (zero violations gate). A keyboard-walk test tabs through each
screen asserting order, that focus is always visible, and that focus is never lost after navigation
or mutation. The perf test asserts the §2.4 budgets on `perf-500`.

---

## 14. Open questions for core

Genuine gaps found while specifying the UI against the schema. None blocks starting; each is a small
addition rather than a redesign.

1. **`provider.short_code`.** The marginal stamp needs a 3-character code (`CAS`, `KIT`, `GRW`,
   `DCX`, `ETR`). The `provider` table has `display_name` but no short code, and deriving one from
   the display name heuristically would produce collisions and would put registry data in the UI.
   Proposed: `short_code TEXT NOT NULL` on `provider`, 3 uppercase characters, unique. v1 workaround
   is a UI-side map keyed on `provider.id`, which duplicates registry data and should be deleted
   when the column exists.
2. **A `setting` table.** Nothing in the schema stores base currency, the price-staleness TTL (per
   asset class), the single-position concentration threshold (the mockup's 20% flag), the BYOK
   price-provider selection, or the theme override. All five are displayed or acted on by the UI.
   Proposed: a `setting(key TEXT PRIMARY KEY, value TEXT NOT NULL)` table with typed accessors.
   Without it the 20% flag and the TTL are hard-coded, which makes the data-quality strip and the
   concentration chart untestable against user intent.
3. **`account.last_synced_at`.** The Accounts screen and the sync log both show it. It is derivable
   as `max(source_document.imported_at)` for the account, but "imported" and "synced" differ for API
   accounts, where `credential_ref.last_used_at` is the truer figure and may be later than any
   document. Confirm the intended derivation, or add the column.
4. **`source_document.original_path`.** After D4 the import report shows where the file was read
   from. `original_name` exists; the path does not. Either add it (and accept that it records a
   filesystem location the user may consider sensitive) or the UI shows the name only. A decision is
   needed either way, because the mockup currently implies Misal keeps the file.
5. **`source_document.unlock_method`.** The report shows *"Unlocked with PAN + date of birth · not
   stored"*, which is a real and reassuring fact about a CAS import. Nothing records it. Proposed: a
   nullable `unlock_method TEXT`. Without it, that row is dropped from the report.
6. **`txn` narration or subtype.** The transactions table displays "SIP purchase" and "Redemption".
   The schema's `type` enum has `buy` and `sell`. v1 will display the canonical type, mapped per
   asset class (`Purchase`/`Redemption` for mutual funds, `Buy`/`Sell` otherwise), and will **not**
   claim SIP — claiming it without evidence would be exactly the kind of small dishonesty this
   product is against. A nullable `narration TEXT` carrying the source row's own wording would let
   the UI show what the statement said, attributed.
7. **Categorical slots for `bond` and `cash`.** Seven asset classes, five validated hues (§6.3).
   Needs a palette task, not a schema change, but it belongs on the same list.
8. **Price TTL semantics for gold and other non-market instruments.** The mockup flags Augmont gold
   at 15 days as critical. Whether that threshold is per asset class or global determines whether
   `DataQualityStrip` can compute a stale count at all. Follows from (2).

---

## 15. Out of scope

**Deferred to later phases, per the v1 design:**

- **Android client and the pairing protocol** (subsystem F, v2). No touch layout, no responsive
  behaviour below the 1024px floor, no gesture affordances. The component library should not be
  contorted now in anticipation of it.
- **The self-hosted web build** (subsystem G, v2). The hash router and the absence of any
  Tauri-specific API outside `queries/` keep this cheap later, but no web-specific concern — auth,
  CSP for a remote origin, service workers — is addressed here.
- **The MCP server / AI layer** (subsystem H, v3). No natural-language surface, no chat affordance,
  no "explain this number" control. Note the regulatory posture in the v1 design: whatever that
  layer becomes, it analyses the user's own data and never advises.

**Also out of scope for v1 within the desktop UI itself:** Indian and US broker API adapters beyond
crypto (nothing in the Accounts screen may imply they exist); multi-profile or multi-user; sync of
any kind; user-configurable dashboards or saved views beyond URL state; chart interactions
(tooltips, brushing, zoom, drill-down); drag-to-reorder or drag-to-resize columns; a print
stylesheet; localisation beyond en-IN and ₹ as base currency; PDF report export (CSV and JSON only);
and undo history for destructive actions, which is replaced by confirmation dialogs plus the
automatic pre-migration backup that subsystem A already guarantees.
