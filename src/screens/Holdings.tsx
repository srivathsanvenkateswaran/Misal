/**
 * Screen 02 — Holdings.
 *
 * Every current position, groupable by asset class, account or instrument. The screen exists to
 * make one thing visible: a snapshot row **withholds** cost and P&L and says why, in the same
 * cell, at the same size as the rows that can answer. It never shows a zero there, and the panel
 * foot restates in rupees and percent how much of the cost column is real.
 *
 * Sorting and grouping are by value, descending, on `compareMinor` — integer comparison on the
 * stored paise. A comparator is the single most likely place for a stray `parseFloat` to enter a
 * codebase, so this one never leaves the string.
 */

import type { ReactNode } from 'react'
import { type Minor, ZERO_DEC, addMinor, compareMinor } from '@domain/numeric'
import { Metric } from '@ui/measured/Metric'
import { WeightBar } from '@ui/readout/CoverageMeter'
import { DataTable } from '@ui/table/DataTable'
import type { DataTableColumn, DataTableRow } from '@ui/table/DataTable'
import { formatMoney, formatPct, formatQty, money } from '@ui/format'
import { ASSET_CLASS_LABEL, SERIES_BY_ASSET_CLASS } from '@ui/metrics'
import { Badge, ClassDot, InstrumentLink, ScreenHead } from './chrome'
import { GROUP_LABEL, hrefFor, navigate } from './route'
import type { HoldingsGroup } from './route'
import { derivedStamp, shareOf } from './view-model'
import type { PortfolioData, PositionView } from './view-model'
import './screens.css'

const TOTAL_KEY = 'total'

/**
 * The total row's cost and unrealised columns are ledger-scope subtotals presented in a
 * whole-portfolio row — the single most misreadable cell in the design. They therefore carry
 * `scope="portfolio"`, which makes H2 demand the coverage attributes, plus a sub-label saying what
 * they are; and the panel foot restates the same figures in words.
 */
const COLUMNS: readonly DataTableColumn<PositionView>[] = [
  {
    id: 'instrument',
    header: 'Instrument',
    width: '250px',
    cell: (row) =>
      row.key === TOTAL_KEY ? (
        <span className="inst">
          {row.name}
          <span className="sub">{row.detail}</span>
        </span>
      ) : (
        <span className="inst">
          <InstrumentLink instrumentId={row.instrumentId}>{row.name}</InstrumentLink>
          <span className="sub">{row.detail === '' ? ASSET_CLASS_LABEL[row.assetClass] : row.detail}</span>
        </span>
      ),
  },
  {
    id: 'account',
    header: 'Account',
    cell: (row) => row.accountLabel,
  },
  {
    id: 'quantity',
    header: 'Quantity',
    align: 'right',
    // Not a metric: a portfolio-wide quantity is a sum of unlike units and has no meaning, so the
    // cell is empty rather than filled with a number that would.
    cell: (row) => (row.key === TOTAL_KEY ? '' : formatQty(row.quantity, { precision: row.precision })),
  },
  {
    id: 'avg-cost',
    header: 'Avg cost',
    align: 'right',
    cell: (row) =>
      row.key === TOTAL_KEY ? (
        <>
          <Metric value={row.avgCost} metric="cost-basis" scope="portfolio" basis="ledger" size="table" />
          <span className="sub">total cost · ledger</span>
        </>
      ) : (
        <Metric value={row.avgCost} metric="avg-cost" scope="position" basis="ledger" size="table" />
      ),
  },
  {
    id: 'last-price',
    header: 'Last price',
    align: 'right',
    cell: (row) =>
      row.key === TOTAL_KEY ? (
        ''
      ) : (
        <>
          <Metric
            value={row.lastPrice}
            metric="price"
            scope="position"
            basis="derived"
            size="table"
            staleDays={row.staleDays}
          />
          {row.priceNote !== undefined && (
            <span className="sub" data-alert-text={row.staleDays === undefined ? undefined : 'true'}>
              {row.priceNote}
            </span>
          )}
        </>
      ),
  },
  {
    id: 'value',
    header: 'Value ₹',
    align: 'right',
    cell: (row) => (
      <Metric
        value={row.value}
        metric="value"
        scope={row.key === TOTAL_KEY ? 'portfolio' : 'position'}
        basis="derived"
        size="table"
      />
    ),
  },
  {
    id: 'unrealised',
    header: 'Unrealised ₹',
    align: 'right',
    cell: (row) => (
      <Metric
        value={row.unrealised}
        metric="unrealised"
        scope={row.key === TOTAL_KEY ? 'portfolio' : 'position'}
        basis="ledger"
        size="table"
        tone
      />
    ),
  },
  {
    id: 'unrealised-pct',
    header: 'Unrealised %',
    align: 'right',
    cell: (row) => (
      <Metric
        value={row.unrealisedPct}
        metric="unrealised-pct"
        scope={row.key === TOTAL_KEY ? 'portfolio' : 'position'}
        basis="ledger"
        size="table"
        tone
      />
    ),
  },
  {
    id: 'weight',
    header: 'Weight',
    align: 'right',
    cell: (row) => (
      <>
        {formatPct(row.weight)}
        <WeightBar pct={row.weight} />
      </>
    ),
  },
  {
    id: 'day',
    header: 'Day %',
    align: 'right',
    cell: (row) => (
      <Metric
        value={row.dayPct}
        metric="day-change"
        scope={row.key === TOTAL_KEY ? 'portfolio' : 'position'}
        basis="derived"
        size="table"
      />
    ),
  },
]

interface Group {
  readonly key: string
  readonly label: ReactNode
  readonly rows: readonly PositionView[]
  readonly valueMinor: Minor
}

function groupKeyOf(position: PositionView, group: HoldingsGroup): string {
  switch (group) {
    case 'asset_class':
      return position.assetClass
    case 'account':
      return position.accountId
    case 'instrument':
      return position.instrumentId
    case 'none':
      return ''
  }
}

function groupLabel(
  group: HoldingsGroup,
  rows: readonly PositionView[],
  valueMinor: Minor,
  netWorthMinor: Minor,
): ReactNode {
  const first = rows[0]
  if (first === undefined) return null
  const snapshotOnly = rows.every((row) => row.capability === 'snapshot')
  const count = `${rows.length.toString()} ${rows.length === 1 ? 'position' : 'positions'}`
  const name =
    group === 'asset_class'
      ? ASSET_CLASS_LABEL[first.assetClass]
      : group === 'account'
        ? first.accountLabel
        : first.name

  return (
    <>
      {group === 'asset_class' && <ClassDot series={SERIES_BY_ASSET_CLASS[first.assetClass]} />}
      {name} · {count} · {formatMoney(money(valueMinor))} ·{' '}
      {formatPct(shareOf(valueMinor, netWorthMinor))} ·{' '}
      {snapshotOnly ? (
        <Badge tone="snapshot">Snapshot — no transaction history</Badge>
      ) : (
        <Badge>Ledger</Badge>
      )}
    </>
  )
}

function buildGroups(data: PortfolioData, group: HoldingsGroup): readonly Group[] {
  if (group === 'none') {
    return [
      { key: '', label: null, rows: data.positions, valueMinor: data.netWorthMinor },
    ]
  }
  const buckets = new Map<string, PositionView[]>()
  for (const position of data.positions) {
    const key = groupKeyOf(position, group)
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [position])
    else bucket.push(position)
  }
  return [...buckets.entries()]
    .map(([key, rows]) => {
      const valueMinor = addMinor(...rows.map((row) => row.valueMinor))
      return { key, label: groupLabel(group, rows, valueMinor, data.netWorthMinor), rows, valueMinor }
    })
    .sort((a, b) => -compareMinor(a.valueMinor, b.valueMinor))
}

function totalRow(data: PortfolioData): PositionView {
  const first = data.positions[0]
  return {
    key: TOTAL_KEY,
    instrumentId: '',
    accountId: '',
    name: `Total · ${data.positions.length.toString()} positions`,
    detail: `${data.accounts.length.toString()} accounts`,
    assetClass: first?.assetClass ?? 'cash',
    accountLabel: `${data.accounts.length.toString()} accounts`,
    capability: 'ledger',
    quantity: ZERO_DEC,
    precision: 0,
    currency: 'INR',
    avgCost: data.readout.costBasis,
    lastPrice: data.readout.netWorth,
    priceNote: undefined,
    staleDays: undefined,
    value: data.readout.netWorth,
    valueMinor: data.netWorthMinor,
    priced: true,
    costMinor: null,
    unrealised: data.readout.unrealised,
    unrealisedPct: data.readout.unrealisedPct,
    weight: shareOf(data.netWorthMinor, data.netWorthMinor),
    dayPct: data.readout.dayChange,
    stamp: derivedStamp(
      `${data.positions.length.toString()} pos`,
      'Totals derived from every priced holding. The cost and unrealised columns are ledger-scope subtotals and carry their own coverage.',
    ),
  }
}

export function Holdings({
  data,
  group,
}: {
  readonly data: PortfolioData
  readonly group: HoldingsGroup
}): ReactNode {
  const rows: DataTableRow<PositionView>[] = []
  for (const bucket of buildGroups(data, group)) {
    if (bucket.label !== null) {
      rows.push({ kind: 'group', key: `grp-${bucket.key}`, label: bucket.label })
    }
    for (const position of bucket.rows) {
      rows.push({ kind: 'data', key: position.key, row: position, stamp: position.stamp })
    }
  }
  if (data.positions.length > 0) {
    const total = totalRow(data)
    rows.push({ kind: 'total', key: TOTAL_KEY, row: total, stamp: total.stamp })
  }

  const costCoverage = data.coverageByMetric.find((entry) => entry.key === 'cost-basis')

  return (
    <>
      <ScreenHead title="Holdings" note="Snapshot rows visibly withhold cost and P&L" />

      <div className="toolbar">
        <span className="tb-lab" id="group-label">
          Group
        </span>
        <span className="select-wrap">
          <select
            className="select"
            aria-labelledby="group-label"
            value={group}
            onChange={(event) => {
              navigate({ kind: 'holdings', group: event.target.value as HoldingsGroup })
            }}
          >
            {(['asset_class', 'account', 'instrument', 'none'] as const).map((option) => (
              <option key={option} value={option}>
                {GROUP_LABEL[option]}
              </option>
            ))}
          </select>
        </span>
        <span className="tb-lab">Sort</span>
        <span className="badge">Current value ↓</span>
        <span className="spacer" />
        <a className="btn" href={hrefFor({ kind: 'accounts' })}>
          Accounts
        </a>
      </div>

      <DataTable
        caption={`Holdings, grouped by ${GROUP_LABEL[group].toLowerCase()}`}
        columns={COLUMNS}
        rows={rows}
        state={data.positions.length === 0 ? 'empty' : 'ready'}
        emptyMessage="No positions yet — the accounts are present but none reported a holding. Import a statement to fill this."
        foot={
          <>
            “Not measured” means Misal has no transaction history for that position — it is not
            zero, and it is not a loss.{' '}
            {costCoverage === undefined
              ? null
              : `Cost, unrealised P&L and the total above cover ${formatMoney(money(data.ledgerBackedMinor))} of ${formatMoney(money(data.netWorthMinor))} (${formatPct(costCoverage.pct, { decimals: 1 })}).`}
          </>
        }
      />
    </>
  )
}
