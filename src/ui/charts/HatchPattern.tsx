/**
 * The 45° hatch — the snapshot convention (spec §6.4).
 *
 * One meaning, everywhere, no exceptions: **45° hatching marks value for which Misal has no
 * transaction history**, and by extension the portion of a meter that is not measured.
 *
 * The stroke is the *surface* colour, so the hatch carves gaps out of the fill rather than
 * painting lines on top of it. That is why it works unchanged in both themes and over all five
 * hues, and why it is applied as a second, identically shaped element on top of the coloured one
 * — never as a fill replacement, so the asset-class hue survives underneath.
 *
 * Coverage has to survive greyscale and colour-blindness, so the hatch plus direct labelling
 * carries the meaning. Colour never carries it alone.
 */

import type { ReactNode } from 'react'

export const HATCH_ID = 'misal-hatch'
export const HATCH_FILL = `url(#${HATCH_ID})`

/**
 * The pattern definition. Rendered inside each chart's own `<svg>` rather than once per document,
 * so a chart cannot be mounted somewhere the definition is missing and silently lose its hatch —
 * which would turn snapshot value into ledger-backed value to the eye.
 *
 * Every copy is byte-identical, so the shared id resolves to the same pattern wherever it is used.
 */
export function HatchPattern(): ReactNode {
  return (
    <defs>
      <pattern
        id={HATCH_ID}
        patternUnits="userSpaceOnUse"
        width="6"
        height="6"
        patternTransform="rotate(45)"
      >
        <rect width="6" height="6" fill="none" />
        <line x1="0" y1="0" x2="0" y2="6" className="hx-line" />
      </pattern>
    </defs>
  )
}

/**
 * The hatch overlay itself: the same geometry as the coloured shape, drawn on top of it.
 *
 * `data-hatch` marks it for the H5 assertion, which counts overlays against snapshot geometry in
 * the same `<svg>`.
 */
export function HatchOverlay({ d }: { readonly d: string }): ReactNode {
  return <path className="hatch" data-hatch="true" d={d} aria-hidden="true" />
}
