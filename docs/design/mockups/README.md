# UI direction mockups

Static HTML mockups from the v1 design phase. Each file is self-contained — no JavaScript, no
external requests, system fonts only — and stacks all five screens (Dashboard, Holdings, Accounts,
Import review, Instrument detail) into one scrollable page. Open them directly in a browser.

All three respond to the system light/dark setting.

| File | Direction | Status |
|---|---|---|
| `direction-a-passbook.html` | Ruled ledger grid; marginal source stamps | Not chosen — stamp mechanism adopted |
| `direction-b-instrument.html` | Calibrated measuring device; coverage bar | **Chosen as the base** |
| `direction-c-layered.html` | Net worth as labelled strata | Not chosen — retained for later |
| `final-consolidated.html` | B, with A's stamps replacing its `SRC` chips | Implementation reference |

## Decision

**Direction B is the base.** It carries the strongest answer to the hardest problem in this product
— showing honestly that some metrics can only measure part of your portfolio — via a calibration
bar on a real rupee scale with the ledger/snapshot boundary marked. Its colour discipline is also
correct: chrome is achromatic and hue is bound permanently to asset class.

**Direction A's marginal stamps were folded in**, replacing B's weaker `SRC` chips. The stamps put
a source code and folio reference in a gutter on every row, with border style encoding data health,
so provenance is readable without a click. They were re-rendered in B's machine-printed language
rather than A's ink-stamp styling.

## What is worth taking from C later

Kept deliberately, not as a runner-up. Three specific things:

1. **The stacked composition.** Net worth drawn as labelled strata is the single best expression of
   the product's identity, and the obvious README and landing-page image. It works far better as a
   marketing artefact than B's calibration bar does.
2. **A dedicated allocation view.** The stack is a weak dashboard hero — it spends a whole viewport
   on one number — but it would make an excellent standalone "composition" screen if one is ever
   added.
3. **The plain-language framing.** "All data on this Mac · nothing leaves the device" states the
   product's positioning better than anything in A or B. Worth lifting verbatim.

C's weakness was information density, not aesthetics. Anywhere density does not matter — landing
page, onboarding, a single-purpose screen — C is the stronger direction.
