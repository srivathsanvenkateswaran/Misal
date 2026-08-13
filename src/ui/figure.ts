/**
 * A figure is a value the interface is allowed to print.
 *
 * It exists so that `Measured<T>` has one `T` the renderer understands, and so that the decision
 * "how many decimals, which currency, signed or not" is taken where the view-model is built rather
 * than inside a component. Nothing here holds a number.
 */

import type { CurrencyCode, Dec, Minor } from '@domain/numeric'
import type { MoneyFormat, PctFormat, QtyFormat } from './format'
import { formatMoney, formatPct, formatQty } from './format'

export type Figure =
  | { readonly kind: 'money'; readonly minor: Minor; readonly currency: CurrencyCode; readonly format?: MoneyFormat }
  | { readonly kind: 'pct'; readonly value: Dec; readonly format?: PctFormat }
  | { readonly kind: 'qty'; readonly value: Dec; readonly format?: QtyFormat }

/**
 * A money figure.
 *
 * **`currency` defaults to INR and that default is load-bearing, so read this before omitting it.**
 * The currency does two things and only one of them is visible: it selects the digit grouping
 * (2-2-3 for rupees, 3-3-3 otherwise) and it selects the symbol — and the symbol is suppressed
 * wherever a column header carries it instead. A figure built from a dollar amount with the default
 * left in place therefore renders as a plausible rupee number: right digits, wrong unit, nothing on
 * screen to say so. Pass the amount's own currency at every call site that has one.
 */
export function moneyFigure(
  minor: Minor,
  format: MoneyFormat = {},
  currency: CurrencyCode = 'INR',
): Figure {
  return { kind: 'money', minor, currency, format }
}

export function pctFigure(value: Dec, format: PctFormat = {}): Figure {
  return { kind: 'pct', value, format }
}

export function qtyFigure(value: Dec, format: QtyFormat = {}): Figure {
  return { kind: 'qty', value, format }
}

/**
 * `symbol: false` is a claim about the column, not about the figure.
 *
 * It means "the header already says which currency this is", and every money header in this
 * product says rupees. So the suppression is honoured for rupees and refused for anything else: a
 * dollar amount printed bare under a header it does not belong to is indistinguishable from a
 * rupee amount, which is the one way a correct number becomes a wrong statement. Non-INR figures
 * always carry their own symbol, whatever the caller asked for.
 */
function moneyFormatFor(figure: Extract<Figure, { kind: 'money' }>): MoneyFormat {
  if (figure.currency === 'INR') return figure.format ?? {}
  return { ...figure.format, symbol: true }
}

export function formatFigure(figure: Figure): string {
  switch (figure.kind) {
    case 'money':
      return formatMoney({ minor: figure.minor, currency: figure.currency }, moneyFormatFor(figure))
    case 'pct':
      return formatPct(figure.value, figure.format)
    case 'qty':
      return formatQty(figure.value, figure.format)
  }
}

/** True when the figure's own value is negative, for the redundant `--neg` reinforcement. */
export function isNegativeFigure(figure: Figure): boolean {
  const raw = figure.kind === 'money' ? figure.minor : figure.value
  return raw.startsWith('-')
}
