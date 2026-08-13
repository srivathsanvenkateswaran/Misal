/**
 * `assertHonest` — the honesty suite as one DOM-walking assertion (spec §13.2).
 *
 * Every component test ends by calling this. That is the mechanism that stops the promise eroding
 * component by component: a new component that renders a figure without coverage, or a zero where
 * a metric is unmeasurable, fails its own test without anyone remembering to write an honesty test
 * for it.
 *
 * What is checked here, and what is not:
 *
 *   H1, H4  — enforced by the type system. `Measured<T>`'s false branch has no `value`, so there is
 *             no expression that produces a number for an unmeasurable metric. Nothing to assert
 *             at runtime; the compiler already refused.
 *   H2      — asserted, in both directions: coverage travels with the metric, and a drawn
 *             coverage has a measured metric to travel with.
 *   H3      — asserted: never a zero, never a blank, never a dash.
 *   H5      — asserted: hatch fidelity, per `<svg>`.
 *   H6      — asserted: provenance completeness, with the D1 panel-scope exemption.
 *   H7      — asserted: staleness is never silent.
 *   H9      — partially asserted. jsdom does not apply the stylesheets, so computed colour is not
 *             observable; what is checked is that the signed-ink classes appear only on sanctioned
 *             elements. The full check is the greyscale visual-regression pass.
 *   H8, H10 — asserted by the fixtures that exercise them, not generically: both are statements
 *             about numbers this module cannot recompute without becoming a second valuation
 *             engine.
 *   H11, H12 — screen-level and app-level, not component-level.
 */

import { HATCH_ID } from '../charts/HatchPattern'
import { HISTORY_DEPENDENT } from '../metrics'
import type { MetricId } from '../metrics'

/**
 * A rendering that says nothing while looking like an answer. H3 forbids every one of these for a
 * metric that was not measured.
 */
export const FORBIDDEN_PLACEHOLDER = /^[\s₹$0.,%—–-]*$/

export interface HonestyOptions {
  /** Price age past which H7 requires an alert stamp and the age in words. */
  readonly stalePriceTtlDays?: number
}

function textOf(element: Element): string {
  return element.textContent
}

function scopeOf(element: Element): Element {
  return (
    element.closest('tr, [data-cell-metric], [data-row-scope], section, article') ??
    element.ownerDocument.body
  )
}

/**
 * The figures a coverage meter is entitled to speak for.
 *
 * Tighter than `scopeOf` on purpose: a meter qualifies the figure it was drawn beside, not
 * everything on the panel, so a section holding a dozen unrelated components must not make one
 * of them guilty of another's withheld metric. A cell or a row is the binding container; a meter
 * drawn outside both — the gallery renders three as specimens — is bound to whatever element it
 * was placed in, which for a real pairing is where the figure would also be.
 */
function meterScope(meter: Element): Element {
  return (
    meter.closest('tr, [data-cell-metric], [data-row-scope]') ??
    meter.parentElement ??
    meter.ownerDocument.body
  )
}

export function honestyViolations(
  container: ParentNode,
  options: HonestyOptions = {},
): readonly string[] {
  const ttl = options.stalePriceTtlDays ?? 7
  const problems: string[] = []

  // ---- H3 — never a zero, never a blank, never a dash ----
  for (const element of container.querySelectorAll('[data-not-measured]')) {
    const text = textOf(element).trim()
    if (text === '' || FORBIDDEN_PLACEHOLDER.test(text)) {
      problems.push(
        `H3: a metric with data-not-measured="${element.getAttribute('data-not-measured') ?? ''}" rendered ${JSON.stringify(text)}, which reads as a value.`,
      )
    }
    if (element.getAttribute('data-excluded-minor') === null) {
      problems.push('H3/H8: an unmeasurable metric did not state the value it cannot speak for.')
    }
  }

  // ---- H2 — coverage travels with the metric ----
  for (const element of container.querySelectorAll('[data-metric]')) {
    const metric = element.getAttribute('data-metric') as MetricId | null
    if (metric === null || !HISTORY_DEPENDENT.has(metric)) continue
    if (element.getAttribute('data-scope') === 'position') continue
    const notMeasured = element.getAttribute('data-not-measured')
    if (notMeasured !== null) continue
    const pct = element.getAttribute('data-coverage-pct')
    const amount = element.getAttribute('data-coverage-minor')
    if (pct === null || pct === '' || amount === null || amount === '') {
      problems.push(
        `H2: history-dependent metric "${metric}" rendered without both a coverage percentage and a coverage amount.`,
      )
    }
  }

  // ---- H2 — a coverage meter may not stand beside a figure that was never computed ----
  //
  // The loop above asks whether a figure states its coverage. This one asks the reverse, and it
  // is the half that was missing: whether a coverage states a figure. A meter is not a decoration
  // and not a statistic in its own right — it is the sentence "this much of the portfolio is
  // behind the number next to me". When that number was withheld the bar has no subject, and what
  // the reader gets is a percentage of nothing, printed in the component whose entire job is to
  // say how complete an answer is. At 100.0% — reachable whenever the missing part contributes to
  // neither side of the fraction — it asserts the exact opposite of the truth.
  //
  // The rule is attached to `[data-coverage-meter]` rather than to any one component, so a screen
  // that draws its own meter is held to it without knowing this file exists. A meter inside a
  // metric cell must also name the metric it covers: an unnamed bar cannot be shown to be honest,
  // and "cannot be shown" is the state this suite exists to fail on.
  for (const meter of container.querySelectorAll('[data-coverage-meter]')) {
    const declared = meter.getAttribute('data-metric')
    const scope = meterScope(meter)
    const inCell = meter.closest('[data-cell-metric], [data-row-scope]') !== null
    if (declared === null && inCell) {
      problems.push(
        'H2: a coverage meter inside a metric cell does not carry data-metric, so the figure its ' +
          'percentage claims to cover cannot be identified.',
      )
    }
    for (const figure of scope.querySelectorAll('[data-metric][data-not-measured]')) {
      if (declared !== null && figure.getAttribute('data-metric') !== declared) continue
      problems.push(
        `H2: a coverage meter reading ${meter.getAttribute('data-coverage-meter') ?? '?'}% is ` +
          `drawn beside "${figure.getAttribute('data-metric') ?? '?'}", which was not measured ` +
          `(${figure.getAttribute('data-not-measured') ?? '?'}). A share of a figure that was ` +
          `never computed overstates the coverage the product has.`,
      )
      break
    }
  }

  // ---- H5 — hatch fidelity, counted inside each chart ----
  for (const svg of container.querySelectorAll('svg')) {
    const snapshot = svg.querySelectorAll('[data-basis="snapshot"]').length
    const hatched = svg.querySelectorAll('[data-hatch]').length
    if (snapshot !== hatched) {
      problems.push(
        `H5: ${String(snapshot)} snapshot shapes but ${String(hatched)} hatch overlays in one chart.`,
      )
    }
  }

  // ---- H6 — provenance completeness ----
  for (const row of container.querySelectorAll('tbody tr')) {
    if (row.querySelector('[data-metric]') === null) continue
    const stamped = row.querySelector('.pmark') !== null
    const covered = row.closest('[data-stamp-scope]') !== null
    if (!stamped && !covered) {
      problems.push('H6: a row displaying a figure carries no source stamp and no panel-level scope.')
    }
  }

  // ---- H7 — staleness is never silent ----
  for (const element of container.querySelectorAll('[data-stale-days]')) {
    const raw = element.getAttribute('data-stale-days') ?? ''
    if (raw === '') continue
    if (BigInt(raw) <= BigInt(ttl)) continue
    const scope = scopeOf(element)
    if (!/\d+\s*d old/i.test(textOf(scope))) {
      problems.push(`H7: a price ${raw} days old is displayed without stating its age in words.`)
    }
    if (scope.querySelector('[data-stamp-alert="true"]') === null) {
      problems.push(`H7: a price ${raw} days old is displayed without an alert-variant stamp.`)
    }
  }

  // ---- H9 (partial) — alert ink discipline ----
  const SANCTIONED = '[data-metric], .badge, [data-stamp-variant], .pmark, [data-alert-text]'
  for (const element of container.querySelectorAll('.pos, .neg')) {
    if (element.matches(SANCTIONED)) continue
    if (element.closest(SANCTIONED) !== null) continue
    problems.push(
      `H9: signed ink applied outside a metric, badge or stamp: ${JSON.stringify(textOf(element).trim().slice(0, 40))}.`,
    )
  }

  // ---- a bar that does not reconcile with its own total ----
  for (const element of container.querySelectorAll('[data-reconciles="false"]')) {
    problems.push(
      `The drawn segments total ${element.getAttribute('data-segments-total-minor') ?? '?'} paise, which is not the stated total.`,
    )
  }

  // ---- the hatch resolves inside its own <svg> ----
  //
  // `.hatch` fills from `url(#misal-hatch)`, and an SVG reference resolves against the first
  // matching id anywhere in the document. So a chart that forgets its own <defs> still looks
  // correct for as long as some other chart on the page supplies one, and loses its hatch the
  // moment that chart unmounts — or in any context where it is alone, such as an export, a
  // print stylesheet or a portal.
  //
  // The failure is silent and flatters us: without the hatch, value Misal has no transaction
  // history for renders identically to value it does. That is the single most misleading thing
  // this UI could do, so it is checked structurally rather than trusted to review.
  for (const svg of container.querySelectorAll('svg')) {
    if (svg.querySelector('[data-hatch]') === null) continue
    if (svg.querySelector(`#${HATCH_ID}`) === null) {
      problems.push(
        `H5: an <svg> draws hatched geometry but does not define #${HATCH_ID} itself, so the ` +
          `hatch resolves against another chart and will vanish when that chart does. ` +
          `Snapshot-only value would then read as ledger-backed.`,
      )
    }
  }

  return problems
}

export function assertHonest(container: ParentNode, options: HonestyOptions = {}): void {
  const problems = honestyViolations(container, options)
  if (problems.length > 0) {
    throw new Error(`Honesty invariants violated:\n  - ${problems.join('\n  - ')}`)
  }
}
