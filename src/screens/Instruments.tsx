/**
 * Screens 05 — the instrument index and the instrument detail.
 *
 * The detail screen is where the FIFO machinery becomes inspectable: the position in each account,
 * every open lot with the date it was acquired, and every transaction Misal holds, each stamped
 * with the account it was read from.
 *
 * For a snapshot-backed instrument the cost, lots and XIRR panels are **replaced** by a single
 * statement naming the account and the reason — not rendered empty, and not rendered with zeros.
 */

import type { ReactNode } from 'react'
import { isNegativeDec, isZeroDec } from '@domain/numeric'
import type { Measured } from '@domain/measured'
import type { Figure } from '@ui/figure'
import { NavHistoryChart } from '@ui/charts/NavHistoryChart'
import type { RugMark } from '@ui/charts/NavHistoryChart'
import { Metric } from '@ui/measured/Metric'
import { StampGutter } from '@ui/provenance/SourceStamp'
import { DataTable } from '@ui/table/DataTable'
import type { DataTableColumn, DataTableRow } from '@ui/table/DataTable'
import { formatPct, formatQty } from '@ui/format'
import { ASSET_CLASS_LABEL } from '@ui/metrics'
import { Badge, ClassDot, EmptyState, Panel, ScreenHead } from './chrome'
import { hrefFor } from './route'
import { CAPABILITY_BADGE, derivedStamp, formatDate } from './view-model'
import type { InstrumentView, LotView, PortfolioData, PositionView, TxnView } from './view-model'
import './screens.css'

const MAX_ROWS = 8

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

const INDEX_COLUMNS: readonly DataTableColumn<InstrumentView>[] = [
  {
    id: 'name',
    header: 'Instrument',
    width: '280px',
    cell: (row) => (
      <span className="inst">
        <a className="linkish" href={hrefFor({ kind: 'instrument', instrumentId: row.id })}>
          {row.name}
        </a>
        <span className="sub">{row.identifiers === '' ? ASSET_CLASS_LABEL[row.assetClass] : row.identifiers}</span>
      </span>
    ),
  },
  {
    id: 'class',
    header: 'Asset class',
    cell: (row) => (
      <>
        <ClassDot series={row.series} />
        {ASSET_CLASS_LABEL[row.assetClass]}
      </>
    ),
  },
  {
    id: 'accounts',
    header: 'Accounts',
    align: 'right',
    cell: (row) => row.positions.length,
  },
  {
    id: 'value',
    header: 'Value ₹',
    align: 'right',
    cell: (row) => <Metric value={row.totalValue} metric="value" scope="position" basis="derived" size="table" />,
  },
  {
    id: 'weight',
    header: 'Weight',
    align: 'right',
    cell: (row) => formatPct(row.weight),
  },
  {
    id: 'capability',
    header: 'History',
    cell: (row) =>
      row.capability === 'ledger' ? (
        <Badge>{CAPABILITY_BADGE.ledger}</Badge>
      ) : row.capability === 'snapshot' ? (
        <Badge tone="snapshot">{CAPABILITY_BADGE.snapshot}</Badge>
      ) : (
        <Badge tone="warn">Mixed</Badge>
      ),
  },
]

export function InstrumentIndex({ data }: { readonly data: PortfolioData }): ReactNode {
  return (
    <>
      <ScreenHead
        title="Instruments"
        note="Every instrument currently held · open one for its lots and transactions"
      />
      <DataTable
        caption="Instruments held"
        columns={INDEX_COLUMNS}
        rows={data.instruments.map(
          (row): DataTableRow<InstrumentView> => ({
            kind: 'data',
            key: row.id,
            row,
            stamp: derivedStamp(
              `${row.positions.length.toString()} acct`,
              `${row.name} — summed across ${row.positions.length.toString()} accounts from their own stamped rows.`,
            ),
          }),
        )}
        state={data.instruments.length === 0 ? 'empty' : 'ready'}
        emptyMessage="No instrument is held yet. Import a statement and every instrument it names appears here."
        foot="Instruments fully exited are not listed yet — closing a position currently makes its realised history unreachable from this screen."
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

const POSITION_COLUMNS: readonly DataTableColumn<PositionView>[] = [
  { id: 'account', header: 'Account', cell: (row) => row.accountLabel },
  {
    id: 'units',
    header: 'Units',
    align: 'right',
    cell: (row) => formatQty(row.quantity, { precision: row.precision }),
  },
  {
    id: 'avg',
    header: 'Avg cost',
    align: 'right',
    cell: (row) => <Metric value={row.avgCost} metric="avg-cost" scope="position" basis="ledger" size="table" />,
  },
  {
    id: 'value',
    header: 'Value ₹',
    align: 'right',
    cell: (row) => <Metric value={row.value} metric="value" scope="position" basis="derived" size="table" />,
  },
  {
    id: 'unrealised',
    header: 'Unrealised ₹',
    align: 'right',
    cell: (row) => (
      <Metric value={row.unrealised} metric="unrealised" scope="position" basis="ledger" size="table" tone />
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
        scope="position"
        basis="ledger"
        size="table"
        tone
      />
    ),
  },
]

const LOT_COLUMNS: readonly DataTableColumn<LotView>[] = [
  { id: 'acquired', header: 'Acquired', cell: (row) => formatDate(row.acquiredOn) },
  { id: 'account', header: 'Account', cell: (row) => row.accountLabel },
  { id: 'origin', header: 'Origin', cell: (row) => row.origin.replace('_', ' ') },
  {
    id: 'units',
    header: 'Units',
    align: 'right',
    cell: (row) => formatQty(row.quantity),
  },
  {
    id: 'cost',
    header: 'Cost ₹',
    align: 'right',
    cell: (row) => (
      <Metric value={row.cost} metric="open-lots" scope="position" basis="ledger" size="table" />
    ),
  },
]

const TXN_COLUMNS: readonly DataTableColumn<TxnView>[] = [
  { id: 'date', header: 'Date', cell: (row) => formatDate(row.occurredOn) },
  { id: 'type', header: 'Type', cell: (row) => row.type },
  { id: 'account', header: 'Account', cell: (row) => row.accountLabel },
  {
    id: 'units',
    header: 'Units',
    align: 'right',
    cell: (row) => formatQty(row.quantity),
  },
  {
    id: 'price',
    header: 'Price ₹',
    align: 'right',
    cell: (row) => (row.price === null ? '' : formatQty(row.price)),
  },
  {
    id: 'amount',
    header: 'Amount ₹',
    align: 'right',
    cell: (row) => (
      <Metric value={row.amount} metric="value" scope="position" basis="ledger" size="table" />
    ),
  },
]

/**
 * The rug's marks: every transaction that moved units, in the direction it moved them.
 *
 * A dividend or a fee has no quantity, so it has no place on a rug whose whole meaning is "units
 * entered here, units left here". It stays in the ledger table below the chart, which is where the
 * panel foot points.
 *
 * `null` — not `[]` — for a holding with no transaction history. An empty rug says no transaction
 * happened; this screen is never in a position to say that about a snapshot account.
 */
function rugMarks(instrument: InstrumentView): readonly RugMark[] | null {
  if (instrument.capability === 'snapshot') return null
  return instrument.transactions
    .filter((txn) => !isZeroDec(txn.quantity))
    .map((txn) => ({
      key: txn.id,
      on: txn.occurredOn,
      direction: isNegativeDec(txn.quantity) ? ('sell' as const) : ('buy' as const),
      label: txn.type,
    }))
}

function PriceHistoryPanel({ instrument }: { readonly instrument: InstrumentView }): ReactNode {
  const marks = rugMarks(instrument)
  const points = instrument.priceHistory
  const first = points[0]
  const last = points[points.length - 1]
  const title = instrument.assetClass === 'mutual_fund' ? 'NAV history' : 'Price history'
  const meta =
    first === undefined || last === undefined
      ? 'No stored price'
      : `${formatDate(first.asOf)} → ${formatDate(last.asOf)} · ${points.length.toString()} stored prices · ${instrument.currency} per unit`
  const marked = marks?.length ?? 0
  const total = instrument.transactions.length

  return (
    <Panel
      title={title}
      meta={meta}
      foot={
        marks === null
          ? 'No transaction history for this instrument, so there is nothing to mark beneath the axis. The line is the stored price series only.'
          : `The rug beneath the axis marks ${marked.toString()} of the ${total.toString()} transactions Misal holds for this instrument — the ones that moved units. All ${total.toString()} are in the ledger table below.`
      }
    >
      <div className="panel-body">
        <NavHistoryChart
          points={points}
          marks={marks}
          instrumentName={instrument.name}
          currency={instrument.currency}
          series={instrument.series}
        />
      </div>
    </Panel>
  )
}

function StatCell({
  label,
  value,
  metric,
  note,
  stampReference,
  stampDescription,
}: {
  readonly label: string
  readonly value: Measured<Figure>
  readonly metric: 'quantity' | 'value' | 'cost-basis' | 'xirr'
  readonly note: string
  readonly stampReference: string
  readonly stampDescription: string
}): ReactNode {
  return (
    <div>
      <StampGutter stamp={derivedStamp(stampReference, stampDescription)} />
      <div className="cell-body">
        <span className="lab">{label}</span>
        <Metric value={value} metric={metric} scope="position" basis="derived" size="value" />
        <div className="cell-note">{note}</div>
      </div>
    </div>
  )
}

export function InstrumentDetail({
  data,
  instrumentId,
}: {
  readonly data: PortfolioData
  readonly instrumentId: string
}): ReactNode {
  const instrument = data.instruments.find((entry) => entry.id === instrumentId)

  if (instrument === undefined) {
    return (
      <>
        <ScreenHead title="Instrument" note="Not found" />
        <EmptyState headline="No instrument with that identifier is currently held.">
          <a className="linkish" href={hrefFor({ kind: 'instruments' })}>
            Back to the instrument index
          </a>
        </EmptyState>
      </>
    )
  }

  const snapshotOnly = instrument.capability === 'snapshot'
  const snapshotAccounts = instrument.positions
    .filter((position) => position.capability === 'snapshot')
    .map((position) => position.accountLabel)

  return (
    <>
      <ScreenHead
        title="Instrument"
        note="One holding across every account · FIFO lots · each row traces to a document"
        actions={
          <a className="btn" href={hrefFor({ kind: 'instruments' })}>
            All instruments
          </a>
        }
      />

      <div className="inst-head">
        <div>
          <div className="inst-name">{instrument.name}</div>
          <div className="inst-ids">
            <ClassDot series={instrument.series} />
            {ASSET_CLASS_LABEL[instrument.assetClass]}
            {instrument.identifiers === '' ? '' : ` · ${instrument.identifiers}`} ·{' '}
            {instrument.capability === 'ledger' ? (
              <Badge>{CAPABILITY_BADGE.ledger}</Badge>
            ) : instrument.capability === 'snapshot' ? (
              <Badge tone="snapshot">{CAPABILITY_BADGE.snapshot}</Badge>
            ) : (
              <Badge tone="warn">Mixed history</Badge>
            )}
          </div>
        </div>
        <div className="inst-nav">
          <span className="lab" style={{ textAlign: 'right' }}>
            Last price
          </span>
          <Metric
            value={instrument.lastPrice}
            metric="price"
            scope="position"
            basis="derived"
            size="value"
          />
          <div className="cell-note">{instrument.lastPriceNote}</div>
        </div>
      </div>

      <div className="splitpanel">
        <StatCell
          label="Units held"
          value={instrument.totalQuantity}
          metric="quantity"
          note={`Across ${instrument.positions.length.toString()} accounts`}
          stampReference={`${instrument.positions.length.toString()} acct`}
          stampDescription="Summed from each account's own stamped position rows."
        />
        <StatCell
          label="Current value"
          value={instrument.totalValue}
          metric="value"
          note={`${formatPct(instrument.weight)} of net worth`}
          stampReference="price"
          stampDescription="Quantity multiplied by the latest stored price. No network call was made to render this."
        />
        <StatCell
          label="Invested — FIFO cost"
          value={instrument.totalCost}
          metric="cost-basis"
          note={`${instrument.lots.length.toString()} open lots`}
          stampReference="fifo"
          stampDescription="Derived by folding this instrument's transactions in FIFO order."
        />
        <StatCell
          label="XIRR"
          value={instrument.xirr}
          metric="xirr"
          note="Computed over the ledger-backed accounts holding this instrument"
          stampReference="cashflow"
          stampDescription="Computed from the dated cash flows of this instrument's transactions plus its current value."
        />
      </div>

      <div className="dashgrid" style={{ padding: '16px 16px 0' }}>
        <PriceHistoryPanel instrument={instrument} />

        <Panel title="Position by account" meta={`${instrument.positions.length.toString()} accounts`}>
          <DataTable
            caption="Position in this instrument, per account"
            columns={POSITION_COLUMNS}
            rows={instrument.positions.map(
              (row): DataTableRow<PositionView> => ({
                kind: 'data',
                key: row.key,
                row,
                stamp: row.stamp,
              }),
            )}
          />
        </Panel>
      </div>

      <div className="dashgrid-2" style={{ padding: '16px', gridTemplateColumns: '1fr 1fr' }}>
        {snapshotOnly ? (
          <Panel title="Open lots — FIFO cost basis" meta="Not measured">
            <EmptyState headline="Not measured — no transaction history">
              {snapshotAccounts.join(', ')} supplies holdings only. Misal has no acquisitions to
              fold, so there are no lots, no cost basis and no XIRR for this instrument. Importing a
              transaction statement for that account is the only thing that changes it.
            </EmptyState>
          </Panel>
        ) : (
          <Panel
            title="Open lots — FIFO cost basis"
            meta={`${instrument.lots.length.toString()} lots · oldest first`}
            foot={
              instrument.lots.length > MAX_ROWS
                ? `${(instrument.lots.length - MAX_ROWS).toString()} more open lots not shown`
                : undefined
            }
          >
            <DataTable
              caption="Open lots"
              columns={LOT_COLUMNS}
              rows={instrument.lots.slice(0, MAX_ROWS).map(
                (row): DataTableRow<LotView> => ({
                  kind: 'data',
                  key: row.lotId,
                  row,
                  stamp: row.stamp,
                }),
              )}
              state={instrument.lots.length === 0 ? 'empty' : 'ready'}
              emptyMessage="No open lot — every unit held came from a source with no acquisition record."
            />
          </Panel>
        )}

        <Panel
          title="Transactions"
          meta={`${instrument.transactions.length.toString()} total · most recent first`}
          foot={
            instrument.transactions.length > MAX_ROWS
              ? `${(instrument.transactions.length - MAX_ROWS).toString()} earlier transactions not shown`
              : 'Every transaction Misal holds for this instrument is listed.'
          }
        >
          <DataTable
            caption="Transactions in this instrument"
            columns={TXN_COLUMNS}
            rows={instrument.transactions.slice(0, MAX_ROWS).map(
              (row): DataTableRow<TxnView> => ({
                kind: 'data',
                key: row.id,
                row,
                stamp: row.stamp,
              }),
            )}
            state={instrument.transactions.length === 0 ? 'empty' : 'ready'}
            emptyMessage="No transaction is stored for this instrument — its account supplies holdings only."
          />
        </Panel>
      </div>
    </>
  )
}
