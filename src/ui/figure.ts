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

export function formatFigure(figure: Figure): string {
  switch (figure.kind) {
    case 'money':
      return formatMoney({ minor: figure.minor, currency: figure.currency }, figure.format)
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
