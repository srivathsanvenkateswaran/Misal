/**
 * Screen 01 — Dashboard.
 *
 * The order is the mockup's, and the order is the argument: the calibration bar first, because
 * what the product cannot measure is stated before anything it can; then the readout, whose every
 * history-dependent cell carries the rupee amount and percentage it covers (H2); then the twelve
 * month-end columns, the allocation and its plain-English restatement, the concentration chart and
 * the data-quality strip.
 *
 * D1 applies to the readout: all seven cells are derived, so one panel-level statement replaces
 * seven identical `DRV` marks and only the hero keeps a stamp, holding the gutter rhythm.
 */

import type { ReactNode } from 'react'
import { dec } from '@domain/numeric'
import { CalibrationBar } from '@ui/charts/CalibrationBar'
import { ConcentrationChart } from '@ui/charts/ConcentrationChart'
import { NetWorthStackChart } from '@ui/charts/NetWorthStackChart'
import { Metric } from '@ui/measured/Metric'
import { WeightBar, coverageText } from '@ui/readout/CoverageMeter'
import { ReadoutCell, ReadoutGrid } from '@ui/readout/ReadoutCell'
import { DataTable } from '@ui/table/DataTable'
import type { DataTableColumn, DataTableRow } from '@ui/table/DataTable'
import { formatMoney, formatPct, money } from '@ui/format'
import { Badge, ClassDot, Panel, ScreenHead } from './chrome'
import { CONCENTRATION_THRESHOLD, derivedStamp, formatDate } from './view-model'
import type { AccountView, ClassView, CoverageMetricView, PortfolioData } from './view-model'
import './screens.css'

const ALLOCATION_COLUMNS: readonly DataTableColumn<ClassView>[] = [
  {
    id: 'class',
    header: 'Asset class',
    cell: (row) => (
      <span className="inst">
        <ClassDot series={row.series} />
        {row.label}
        <span className="sub">{row.detail}</span>
      </span>
    ),
  },
  {
    id: 'value',
    header: 'Value ₹',
    align: 'right',
    cell: (row) => <Metric value={row.value} metric="value" scope="class" basis="derived" size="table" />,
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
    id: 'coverage',
    header: 'Coverage',
    cell: (row) =>
      row.basis === 'ledger' ? (
        <Badge>Ledger</Badge>
      ) : (
        <Badge tone="snapshot">Snapshot</Badge>
      ),
  },
]

const COVERAGE_COLUMNS: readonly DataTableColumn<CoverageMetricView>[] = [
  { id: 'metric', header: 'Metric', cell: (row) => row.label },
  {
    id: 'amount',
    header: 'Covered ₹',
    align: 'right',
    cell: (row) => (
      <Metric value={row.amount} metric="coverage" scope="portfolio" basis="derived" size="table" />
    ),
  },
  {
    id: 'pct',
    header: 'Coverage',
    align: 'right',
    // `coverageText`, not `formatPct`: coverage truncates, so "100.0%" in this column means the
    // metric spans the portfolio exactly, and 99.99% reads as the 99.9% it is.
    cell: (row) => `${coverageText(row.pct)}%`,
  },
  {
    id: 'state',
    header: 'State',
    cell: (row) => (row.exact ? <Badge tone="ok">Exact</Badge> : <Badge tone="warn">Partial</Badge>),
  },
]

const ACCOUNT_COLUMNS: readonly DataTableColumn<AccountView>[] = [
  {
    id: 'account',
    header: 'Account',
    cell: (row) => (
      <span className="inst">
        <ClassDot series={row.series} />
        {row.label}
        <span className="sub">{row.providerId}</span>
      </span>
    ),
  },
  {
    id: 'capability',
    header: 'Capability',
    cell: (row) =>
      row.capability === 'ledger' ? (
        <Badge>Full history</Badge>
      ) : (
        <Badge tone="snapshot">Holdings only</Badge>
      ),
  },
  {
    id: 'value',
    header: 'Value ₹',
    align: 'right',
    cell: (row) => <Metric value={row.value} metric="value" scope="account" basis="derived" size="table" />,
  },
  {
    id: 'asof',
    header: 'Data as of',
    cell: (row) => (
      <>
        {row.dataAsOf === null ? 'No rows yet' : formatDate(row.dataAsOf)}
        <span className="sub">{row.dataAsOfNote}</span>
      </>
    ),
  },
]

function allocationRows(data: PortfolioData): readonly DataTableRow<ClassView>[] {
  const total: ClassView = {
    assetClass: 'cash',
    label: 'Total net worth',
    series: 'other',
    valueMinor: data.netWorthMinor,
    value: data.readout.netWorth,
    weight: dec('100'),
    positions: data.positions.length,
    basis: data.ledgerAccounts === data.accounts.length ? 'ledger' : 'snapshot',
    detail: `${data.positions.length.toString()} priced holdings`,
    stamp: derivedStamp(
      `${data.classes.length.toString()} cls`,
      'Total net worth — the sum of every priced holding. Value Misal cannot identify is stated separately and is never inside this figure.',
    ),
  }
  return [
    ...data.classes.map(
      (row): DataTableRow<ClassView> => ({ kind: 'data', key: row.assetClass, row, stamp: row.stamp }),
    ),
    { kind: 'total', key: 'total', row: total, stamp: total.stamp },
  ]
}

export function Dashboard({ data }: { readonly data: PortfolioData }): ReactNode {
  const readout = data.readout
  const dq = data.dataQuality

  return (
    <>
      <ScreenHead
        title="Dashboard"
        note="Calibration · readout · allocation · concentration · data quality"
      />
      <div className="pad">
        <CalibrationBar
          segments={data.segments}
          netWorth={data.netWorthMinor}
          ledgerBacked={data.ledgerBackedMinor}
          snapshotOnly={data.snapshotOnlyMinor}
          accountsLedger={data.ledgerAccounts}
          accountsTotal={data.accounts.length}
        />

        <ReadoutGrid
          statement={`Derived from ${data.accounts.length.toString()} accounts · nothing observed directly`}
        >
          <ReadoutCell
            hero
            label="Net worth · all accounts"
            metric="net-worth"
            scope="portfolio"
            basis="derived"
            value={readout.netWorth}
            stamp={derivedStamp(
              `${data.accounts.length.toString()} accts`,
              `Derived from the rows of all ${data.accounts.length.toString()} accounts. Nothing on this panel was observed directly.`,
            )}
            sub={[
              {
                label: 'Day change',
                value: readout.dayChange,
                metric: 'day-change',
                emphasis: true,
              },
            ]}
            foot={[
              { label: 'Ledger-backed', value: formatMoney(money(data.ledgerBackedMinor)) },
              {
                label: 'Snapshot only',
                value: formatMoney(money(data.snapshotOnlyMinor)),
                muted: true,
              },
            ]}
            note={`${readout.counts} · day change needs a previous close, which Misal does not store yet`}
          />

          <ReadoutCell
            label="Invested — cost basis"
            metric="cost-basis"
            scope="portfolio"
            basis="ledger"
            value={readout.costBasis}
            note={readout.costNote}
          />

          <ReadoutCell
            label="Unrealised P&L"
            metric="unrealised"
            scope="portfolio"
            basis="ledger"
            value={readout.unrealised}
            tone
            sub={[
              {
                label: 'on measured cost',
                value: readout.unrealisedPct,
                metric: 'unrealised-pct',
                tone: true,
              },
            ]}
          />

          <ReadoutCell
            label="XIRR — annualised"
            metric="xirr"
            scope="portfolio"
            basis="ledger"
            value={readout.xirr}
            meter={{ pct: readout.xirrMeterPct }}
            note={readout.xirrNote}
          />

          <ReadoutCell
            label={`Realised P&L — ${readout.financialYear}`}
            metric="realised"
            scope="portfolio"
            basis="ledger"
            value={readout.realised}
            tone
            sub={[
              { label: 'STCG', value: readout.stcg, metric: 'stcg' },
              { label: 'LTCG', value: readout.ltcg, metric: 'ltcg' },
            ]}
            note="Ledger accounts only · Misal does not estimate the remainder"
          />

          <ReadoutCell
            label="Currency exposure"
            metric="currency-exposure"
            scope="portfolio"
            basis="derived"
            value={readout.currencyExposure}
            {...(readout.currencySplit === null
              ? {}
              : {
                  split: {
                    aPct: readout.currencySplit.aPct,
                    bPct: readout.currencySplit.bPct,
                    aLabel: 'INR',
                    bLabel: 'Other',
                  },
                })}
            note={readout.currencyNote}
          />

          <ReadoutCell
            label="Concentration — top 5"
            metric="concentration"
            scope="portfolio"
            basis="derived"
            value={readout.concentration}
            sub={[
              { label: 'Largest position', value: readout.largestPosition, metric: 'weight' },
            ]}
            note={readout.concentrationNote}
          />
        </ReadoutGrid>

        <div className="dashgrid" style={{ marginTop: '14px' }}>
          <Panel
            title="Net worth by asset class — 12 months"
            meta={`month end · to ${formatDate(data.asOfDate)}`}
            foot="Snapshot classes stack above the ledger classes, so the coverage line is readable in the column too. A month with nothing stored is drawn as a gap — never a value carried backwards."
          >
            <div className="panel-body">
              <NetWorthStackChart
                months={data.months}
                {...(data.historyBegins === undefined ? {} : { historyBegins: data.historyBegins })}
              />
            </div>
          </Panel>

          <Panel title="Asset allocation" meta={formatDate(data.asOfDate)}>
            <DataTable
              caption="Asset allocation by class"
              columns={ALLOCATION_COLUMNS}
              rows={allocationRows(data)}
              state={data.classes.length === 0 ? 'empty' : 'ready'}
              emptyMessage="No priced holding yet — import a statement to fill this."
            />
            <div className="panel-head" style={{ borderTop: '1px solid var(--rule)', borderBottom: 0, background: 'var(--surface)' }}>
              <span className="panel-title">Coverage by metric</span>
            </div>
            <DataTable
              caption="Coverage by metric"
              columns={COVERAGE_COLUMNS}
              rows={data.coverageByMetric.map(
                (row): DataTableRow<CoverageMetricView> => ({
                  kind: 'data',
                  key: row.key,
                  row,
                  stamp: derivedStamp(row.key.slice(0, 6), `${row.label} — coverage computed from the engine's per-metric report.`),
                }),
              )}
              foot="Partial metrics are computed on ledger-backed value only. Misal does not estimate the remainder."
            />
          </Panel>
        </div>

        <div className="dashgrid-2">
          <Panel
            title="Concentration — position share of net worth"
            meta={`Top ${(data.concentration.length > 10 ? 10 : data.concentration.length).toString()} of ${data.positions.length.toString()}`}
            foot="Bars carry the asset-class hue. Values are labelled on every bar — no colour-only reading."
          >
            <div className="panel-body">
              <ConcentrationChart
                rows={data.concentration}
                threshold={CONCENTRATION_THRESHOLD}
              />
            </div>
          </Panel>

          <div>
            <div className="dq">
              <div className="dq-cell">
                <span className="lab">Stale prices</span>
                <div className="dq-n">{dq.stalePrices}</div>
                <div className="cell-note">{dq.staleNote}</div>
              </div>
              <div className="dq-cell">
                <span className="lab">Unresolved instruments</span>
                <div className="dq-n">{dq.unresolvedCount}</div>
                <div className="cell-note">{dq.withheldNote}</div>
              </div>
              <div className="dq-cell">
                <span className="lab">Accounts</span>
                <div className="dq-n">{dq.accountCount}</div>
                <div className="cell-note">{dq.accountNote}</div>
              </div>
              <div className="dq-cell">
                <span className="lab">Price feed</span>
                <div className="dq-n">{dq.priceFeed}</div>
                <div className="cell-note">{dq.priceFeedNote}</div>
              </div>
            </div>

            <Panel
              title="Per account"
              meta="All timestamps local"
              foot="Nothing here is uploaded. Every row was parsed from a file or a read-only key on this machine."
            >
              <DataTable
                caption="Value and freshness per account"
                columns={ACCOUNT_COLUMNS}
                rows={data.accounts.map(
                  (row): DataTableRow<AccountView> => ({
                    kind: 'data',
                    key: row.id,
                    row,
                    stamp: row.stamp,
                  }),
                )}
              />
            </Panel>
          </div>
        </div>
      </div>
    </>
  )
}
