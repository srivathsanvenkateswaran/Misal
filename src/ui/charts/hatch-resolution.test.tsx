/**
 * The hatch must resolve inside its own `<svg>`.
 *
 * `.hatch` fills from `url(#misal-hatch)`, and an SVG reference resolves against the first
 * matching id anywhere in the document. A chart that forgets its own `<defs>` therefore looks
 * perfectly correct for as long as some other chart on the page happens to supply one — and loses
 * its hatch the moment that chart unmounts, or in any context where it renders alone: an export,
 * a print stylesheet, a portal.
 *
 * The failure is silent, and it flatters us. Without the hatch, value Misal has no transaction
 * history for renders identically to value it does. Of everything this UI could get wrong, that is
 * the most misleading, so it is checked structurally rather than left to review.
 */

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HATCH_ID, HatchOverlay, HatchPattern } from './HatchPattern'
import { honestyViolations } from '../testing/assert-honest'

describe('hatch resolution', () => {
  it('accepts a chart that defines the pattern it references', () => {
    const { container } = render(
      <svg>
        <HatchPattern />
        <path data-basis="snapshot" d="M0 0 H10 V10 H0 Z" />
        <HatchOverlay d="M0 0 H10 V10 H0 Z" />
      </svg>,
    )
    expect(honestyViolations(container)).toEqual([])
  })

  it('rejects a chart that draws hatched geometry without defining the pattern', () => {
    const { container } = render(
      <svg>
        <path data-basis="snapshot" d="M0 0 H10 V10 H0 Z" />
        <HatchOverlay d="M0 0 H10 V10 H0 Z" />
      </svg>,
    )
    const problems = honestyViolations(container)
    expect(problems.join('\n')).toMatch(/does not define #misal-hatch/)
  })

  it('is not satisfied by a sibling chart supplying the pattern', () => {
    // The exact production hazard: two charts on one page, only one carrying its defs. The
    // second renders correctly today purely because the first is mounted.
    const { container } = render(
      <div>
        <svg data-testid="complete">
          <HatchPattern />
          <path data-basis="snapshot" d="M0 0 H10 V10 H0 Z" />
        <HatchOverlay d="M0 0 H10 V10 H0 Z" />
        </svg>
        <svg data-testid="incomplete">
          <path data-basis="snapshot" d="M0 0 H10 V10 H0 Z" />
        <HatchOverlay d="M0 0 H10 V10 H0 Z" />
        </svg>
      </div>,
    )
    const problems = honestyViolations(container)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/does not define #misal-hatch/)
  })

  it('ignores a chart with no hatched geometry at all', () => {
    const { container } = render(
      <svg>
        <rect width="10" height="10" />
      </svg>,
    )
    expect(honestyViolations(container)).toEqual([])
  })

  it('keeps the referenced id and the defined id in step', () => {
    // If HATCH_ID ever diverges from the url() in charts.css, every hatch silently disappears.
    const { container } = render(
      <svg>
        <HatchPattern />
      </svg>,
    )
    expect(container.querySelector(`#${HATCH_ID}`)).not.toBeNull()
    expect(HATCH_ID).toBe('misal-hatch')
  })
})
