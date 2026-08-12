/**
 * The gallery is also the widest honesty test there is: it renders every component in every state
 * at once, and `assertHonest` walks the lot. A component added to the library without its coverage
 * attributes, or with a zero standing in for an unmeasurable metric, fails here even if its own
 * test forgot to look.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { assertHonest, honestyViolations } from '../testing/assert-honest'
import { Gallery } from './Gallery'

describe('the component gallery', () => {
  it('renders every component in every state without violating an invariant', () => {
    const { container } = render(<Gallery />)
    expect(honestyViolations(container)).toEqual([])
    assertHonest(container)
  })

  it('shows the six states a reviewer needs to see', () => {
    const { container } = render(<Gallery />)
    for (const state of ['loading', 'empty', 'error', 'ready']) {
      expect(container.querySelector(`[data-state="${state}"]`)).not.toBeNull()
    }
    expect(container.querySelector('[data-refreshing="true"]')).not.toBeNull()
    expect(container.querySelector('[data-not-measured]')).not.toBeNull()
    expect(container.querySelector('[data-coverage-pct]')).not.toBeNull()
  })

  it('never prints a placeholder where a metric could not be measured', () => {
    const { container } = render(<Gallery />)
    const unmeasured = [...container.querySelectorAll('[data-not-measured]')]
    expect(unmeasured.length).toBeGreaterThan(4)
    for (const element of unmeasured) {
      expect(element.textContent).toMatch(/Not (measured|priced|counted|converted)/)
      expect(element.getAttribute('data-excluded-minor')).not.toBe('')
    }
  })

  it('keeps the stamp key out of the way until it is asked for (D2)', () => {
    render(<Gallery />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(
      screen.getByRole('button', { name: /what the source stamps mean/i }),
    ).toBeInTheDocument()
  })
})
