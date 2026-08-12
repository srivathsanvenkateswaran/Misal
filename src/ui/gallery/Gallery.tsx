/**
 * The component gallery.
 *
 * Every component, in every state the spec names — loading, empty, error, stale, measured and not
 * measured — on one page, so a human can review the set rather than the screenshot of one lucky
 * case. It is also the surface the visual-regression matrix will point at.
 *
 * Mount it at `src/ui/gallery/index.html` in the dev server, or render `<Gallery/>` from anywhere.
 */

import type { ReactNode } from 'react'
import { useState } from 'react'
import { dec } from '@domain/numeric'
import { CalibrationBar } from '../charts/CalibrationBar'
import { ConcentrationChart } from '../charts/ConcentrationChart'
import { HatchPattern } from '../charts/HatchPattern'
import { NetWorthStackChart } from '../charts/NetWorthStackChart'
import { Metric } from '../measured/Metric'
import { SourceStamp, StampGutter } from '../provenance/SourceStamp'
import { StampKeyButton, StampKeyContent } from '../provenance/StampKey'
import { CoverageMeter, SplitBar, WeightBar } from '../readout/CoverageMeter'
import { ReadoutCell, ReadoutGrid } from '../readout/ReadoutCell'
import type { DataTableColumn, DataTableRow } from '../table/DataTable'
import { DataTable } from '../table/DataTable'
import { formatQty } from '../format'
import type { HoldingRow } from './fixtures'
import * as fx from './fixtures'
import '../base.css'
import './Gallery.css'

function Section({
  index,
  title,
  note,
  children,
}: {
  readonly index: string
  readonly title: string
  readonly note: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <section className="gsection">
      <div className="ghead">
        <span className="gno">{index}</span>
        <h2 className="gtitle">{title}</h2>
        <span className="gnote">{note}</span>
      </div>
      {children}
    </section>
  )
}

function State({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactNode {
  return (
    <>
      <span className="gstate">{label}</span>
      {children}
    </>
  )
}

const HOLDINGS_COLUMNS: readonly DataTableColumn<HoldingRow>[] = [
  {
    id: 'instrument',
    header: 'Instrument',
    width: '250px',
    cell: (row) => (
      <span className="inst">
        {row.name}
        <span className="sub">{row.detail}</span>
      </span>
    ),
  },
  { id: 'accounts', header: 'Accounts', cell: (row) => row.accounts },
  {
    id: 'quantity',
    header: 'Quantity',
    align: 'right',
    cell: (row) =>
      row.key === 'total'
        ? ''
        : formatQty(row.quantity, row.quantityUnit === undefined ? {} : { unit: row.quantityUnit }),
  },
  {
    id: 'avg-cost',
    header: 'Avg cost',
    align: 'right',
    // On the total row this column is not an average cost but a ledger-scope subtotal presented in
    // a whole-portfolio row — the most misreadable cell in the design, so it says so in a sub-line
    // and carries the portfolio-scope coverage that H2 then requires of it.
    cell: (row) =>
      row.key === 'total' ? (
        <>
          <Metric
            value={row.avgCost}
            metric="cost-basis"
            scope="portfolio"
            basis="ledger"
            size="table"
          />
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
    cell: (row) => (
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
      <Metric value={row.value} metric="value" scope="position" basis="derived" size="table" />
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
        scope={row.key === 'total' ? 'portfolio' : 'position'}
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
        scope={row.key === 'total' ? 'portfolio' : 'position'}
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
        {`${row.weight}%`}
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
        scope="position"
        basis="derived"
        size="table"
        tone
      />
    ),
  },
]

const HOLDINGS_ROWS: readonly DataTableRow<HoldingRow>[] = [
  {
    kind: 'group',
    key: 'grp-mf',
    label: (
      <>
        <span className="classdot cd-s2" aria-hidden="true" />
        Mutual funds · 3 positions · ₹16,42,380 · 33.99% · <span className="badge">Ledger</span>
      </>
    ),
  },
  ...fx.HOLDING_ROWS.slice(0, 1).map(
    (row): DataTableRow<HoldingRow> => ({ kind: 'data', key: row.key, row, stamp: row.stamp }),
  ),
  {
    kind: 'group',
    key: 'grp-us',
    label: (
      <>
        <span className="classdot cd-s4" aria-hidden="true" />
        US equity · 1 position · ₹11,18,428 · 23.15% ·{' '}
        <span className="badge badge-snap">Snapshot — no transaction history</span>
      </>
    ),
  },
  ...fx.HOLDING_ROWS.slice(1).map(
    (row): DataTableRow<HoldingRow> => ({ kind: 'data', key: row.key, row, stamp: row.stamp }),
  ),
  { kind: 'total', key: 'total', row: fx.TOTAL_ROW, stamp: fx.TOTAL_ROW.stamp },
]

export function Gallery(): ReactNode {
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('system')

  const applyTheme = (next: 'system' | 'light' | 'dark'): void => {
    setTheme(next)
    const root = globalThis.document.documentElement
    if (next === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', next)
  }

  return (
    <div className="gwrap">
      <header className="gmast">
        <div>
          <div className="gmark">Misal</div>
          <div className="gsub">
            Component gallery · every component in every state · against the approved mockup
          </div>
        </div>
        <div className="gswatches">
          <span className="gsub">Theme</span>
          {(['system', 'light', 'dark'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`btn${theme === option ? ' btn-strong' : ''}`}
              onClick={() => {
                applyTheme(option)
              }}
            >
              {option}
            </button>
          ))}
          <StampKeyButton />
        </div>
      </header>

      <Section index="01" title="SourceStamp" note="Border style encodes data health · 18px tall · 56px gutter">
        <div className="grow">
          <SourceStamp {...fx.CAS_STAMP} />
          <SourceStamp {...fx.ETR_STAMP} />
          <SourceStamp {...fx.DRV_STAMP} />
          <SourceStamp {...fx.GRW_STALE_STAMP} />
          <SourceStamp
            code="DCX"
            reference="api key"
            variant="ledger"
            description="Source: CoinDCX read-only API key. Full trade and deposit ledger since July 2023."
          />
        </div>
        <State label="In the gutter — stamped, and the D1 empty spacer">
          <div className="grow">
            <StampGutter stamp={fx.CAS_STAMP} />
            <StampGutter />
          </div>
        </State>
        <State label="Stamp key — a help affordance (D2), shown here expanded inline as on first run">
          <div className="panel">
            <StampKeyContent />
          </div>
        </State>
      </Section>

      <Section index="02" title="CalibrationBar" note="Real rupee scale · minor ticks each lakh · majors each ₹5L">
        <State label="Ready — the mockup's figures">
          <CalibrationBar
            segments={fx.CALIBRATION_SEGMENTS}
            netWorth={fx.NET_WORTH}
            ledgerBacked={fx.LEDGER_BACKED}
            snapshotOnly={fx.SNAPSHOT_ONLY}
            accountsLedger={4}
            accountsTotal={6}
          />
        </State>
        <State label="0% coverage — the harshest honest case: fully hatched, caret at the origin">
          <CalibrationBar
            segments={fx.ALL_SNAPSHOT_SEGMENTS}
            netWorth={fx.NET_WORTH}
            ledgerBacked={fx.R('0')}
            snapshotOnly={fx.NET_WORTH}
            accountsLedger={0}
            accountsTotal={6}
          />
        </State>
        <State label="100% coverage — no hatch anywhere, and coverage is still displayed">
          <CalibrationBar
            segments={fx.ALL_LEDGER_SEGMENTS}
            netWorth={fx.NET_WORTH}
            ledgerBacked={fx.NET_WORTH}
            snapshotOnly={fx.R('0')}
            accountsLedger={6}
            accountsTotal={6}
          />
        </State>
        <State label="Loading — the ruler is drawn, the segments are a skeleton, no numeral is invented">
          <CalibrationBar
            segments={fx.CALIBRATION_SEGMENTS}
            netWorth={fx.NET_WORTH}
            ledgerBacked={fx.LEDGER_BACKED}
            snapshotOnly={fx.SNAPSHOT_ONLY}
            accountsLedger={4}
            accountsTotal={6}
            state="loading"
          />
        </State>
        <State label="Empty — first run: a calibrated instrument with nothing to measure">
          <CalibrationBar
            segments={[]}
            netWorth={fx.R('0')}
            ledgerBacked={fx.R('0')}
            snapshotOnly={fx.R('0')}
            accountsLedger={0}
            accountsTotal={0}
            state="empty"
          />
        </State>
        <State label="Error">
          <CalibrationBar
            segments={[]}
            netWorth={fx.R('0')}
            ledgerBacked={fx.R('0')}
            snapshotOnly={fx.R('0')}
            accountsLedger={0}
            accountsTotal={6}
            state="error"
            errorMessage="Prices for 2 instruments could not be read (E_PRICE_STORE). Net worth is withheld until they can be."
          />
        </State>
      </Section>

      <Section index="03" title="HatchPattern" note="One meaning: value with no transaction history">
        <div className="grow">
          <svg width="360" height="46" role="img" aria-label="The 45 degree hatch over each asset-class hue.">
            <HatchPattern />
            {(['s1', 's2', 's3', 's4', 's5', 'other'] as const).map((series, index) => (
              <g key={series}>
                <rect className={`f-${series}`} x={index * 60} y={0} width={56} height={46} />
                {index >= 3 && (
                  <rect className="hatch" x={index * 60} y={0} width={56} height={46} />
                )}
              </g>
            ))}
          </svg>
          <div className="gswatches">
            <span className="lg">
              <span className="sw sw-s1" />
              Indian equity — ledger
            </span>
            <span className="lg">
              <span className="sw sw-s4 sw-h" />
              US equity — snapshot
            </span>
            <span className="lg muted">
              Hatched fill = holdings snapshot only, no transaction history
            </span>
          </div>
        </div>
      </Section>

      <Section index="04" title="ReadoutCell" note="D1: one panel-level statement instead of seven identical DRV stamps">
        <State label="Ready — the seven dashboard cells">
          <ReadoutGrid statement="Derived from 6 accounts · nothing observed directly">
            <ReadoutCell
              hero
              label="Net worth · all accounts"
              metric="net-worth"
              scope="portfolio"
              basis="derived"
              value={fx.netWorthValue}
              stamp={fx.DRV_STAMP}
              sub={[
                { label: 'Day change', value: fx.dayChangeValue, metric: 'day-change', tone: true, emphasis: true },
                { label: ' ', value: fx.dayChangePctValue, metric: 'day-change', tone: true },
              ]}
              foot={[
                { label: 'Ledger-backed', value: '₹34,73,722' },
                { label: 'Snapshot only', value: '₹13,58,428', muted: true },
              ]}
              note="6 accounts · 12 positions · 5 asset classes"
            />
            <ReadoutCell
              label="Invested — cost basis"
              metric="cost-basis"
              scope="portfolio"
              basis="ledger"
              value={fx.costBasisValue}
              note="Ledger accounts only · excludes ₹13,58,428 of snapshot holdings"
            />
            <ReadoutCell
              label="Unrealised P&L"
              metric="unrealised"
              scope="portfolio"
              basis="ledger"
              value={fx.unrealisedValue}
              tone
              sub={[
                { label: 'on measured cost', value: fx.unrealisedPctValue, metric: 'unrealised-pct', tone: true },
              ]}
            />
            <ReadoutCell
              label="XIRR — annualised"
              metric="xirr"
              scope="portfolio"
              basis="ledger"
              value={fx.xirrValue}
              meter={{ pct: dec('71.90') }}
              note="214 cash flows since 07 Jul 2023"
            />
            <ReadoutCell
              label="Realised P&L — FY 2026-27"
              metric="realised"
              scope="portfolio"
              basis="ledger"
              value={fx.realisedValue}
              tone
              sub={[
                { label: 'STCG', value: fx.stcgValue, metric: 'stcg' },
                { label: 'LTCG', value: fx.ltcgValue, metric: 'ltcg' },
              ]}
              note="01 Apr 2026 → 12 Aug 2026 · ledger accounts only"
            />
            <ReadoutCell
              label="Currency exposure"
              metric="currency-exposure"
              scope="portfolio"
              basis="derived"
              value={fx.currencyExposureValue}
              split={{ aPct: dec('76.85'), bPct: dec('23.15'), aLabel: 'INR', bLabel: 'USD' }}
              note="USD $12,790.80 @ ₹87.4400 · rate 12 Aug 2026"
            />
            <ReadoutCell
              label="Concentration — top 5"
              metric="concentration"
              scope="portfolio"
              basis="derived"
              value={fx.concentrationValue}
              sub={[{ label: 'Largest position', value: fx.largestPositionValue, metric: 'weight' }]}
              note="Caterpillar (CAT) exceeds the 20% single-position flag"
            />
          </ReadoutGrid>
        </State>

        <State label="Not measured — a snapshot-only portfolio: reasons, never zeros">
          <ReadoutGrid statement="Derived from 2 accounts · neither supplies transaction history">
            <ReadoutCell
              label="Invested — cost basis"
              metric="cost-basis"
              scope="portfolio"
              basis="snapshot"
              value={fx.notMeasuredCost}
              stamp={fx.ETR_STAMP}
            />
            <ReadoutCell
              label="XIRR — annualised"
              metric="xirr"
              scope="portfolio"
              basis="snapshot"
              value={fx.notMeasuredXirr}
            />
            <ReadoutCell
              label="Gold — current value"
              metric="value"
              scope="class"
              basis="snapshot"
              value={fx.notPriced}
              stamp={fx.GRW_STALE_STAMP}
            />
            <ReadoutCell
              label="Unresolved holding"
              metric="value"
              scope="position"
              basis="snapshot"
              value={fx.notCounted}
            />
          </ReadoutGrid>
        </State>

        <State label="Loading and refreshing (stale)">
          <ReadoutGrid statement="Derived from 6 accounts · nothing observed directly">
            <ReadoutCell
              label="Invested — cost basis"
              metric="cost-basis"
              scope="portfolio"
              basis="ledger"
              value={fx.costBasisValue}
              state="loading"
            />
            <ReadoutCell
              label="Unrealised P&L"
              metric="unrealised"
              scope="portfolio"
              basis="ledger"
              value={fx.unrealisedValue}
              tone
              state="refreshing"
              note="Refreshing · the previous value stays visible, with its as-of stamp"
            />
            <ReadoutCell
              label="XIRR — annualised"
              metric="xirr"
              scope="portfolio"
              basis="ledger"
              value={fx.xirrValue}
              state="loading"
            />
            <ReadoutCell
              label="Realised P&L — FY 2026-27"
              metric="realised"
              scope="portfolio"
              basis="ledger"
              value={fx.realisedValue}
              state="loading"
            />
          </ReadoutGrid>
        </State>

        <State label="Error — the whole grid is replaced, and the head persists so the failure is named">
          <ReadoutGrid
            statement="Derived from 6 accounts"
            state="error"
            errorMessage="Valuation failed: no exchange rate for 12 Aug 2026 (E_FX_MISSING). Retry after refreshing prices."
          />
        </State>
      </Section>

      <Section index="05" title="DataTable" note="26px rows · the 18px stamp drops into the gutter">
        <State label="Ready — a mixed portfolio: the snapshot rows visibly withhold cost and P&L">
          <div className="panel">
            <DataTable
              caption="Holdings, grouped by asset class"
              columns={HOLDINGS_COLUMNS}
              rows={HOLDINGS_ROWS}
              foot={
                <>
                  “Not measured” means Misal has no transaction history for that position — it is
                  not zero, and it is not a loss. Cost, unrealised P&amp;L and the total above cover
                  ₹34,73,722 of ₹48,32,150 (71.9%).
                </>
              }
            />
          </div>
        </State>
        <State label="Loading — skeleton rows, gutter included, no fake numerals">
          <div className="panel">
            <DataTable
              caption="Holdings, loading"
              columns={HOLDINGS_COLUMNS.slice(0, 5)}
              rows={[]}
              state="loading"
            />
          </div>
        </State>
        <State label="Empty">
          <div className="panel">
            <DataTable
              caption="Holdings, empty"
              columns={HOLDINGS_COLUMNS.slice(0, 5)}
              rows={[]}
              state="empty"
              emptyMessage="No positions yet — import #47 completed but produced no holdings."
            />
          </div>
        </State>
        <State label="Error — the header row is retained so the user knows what failed">
          <div className="panel">
            <DataTable
              caption="Holdings, error"
              columns={HOLDINGS_COLUMNS.slice(0, 5)}
              rows={[]}
              state="error"
              errorMessage="Positions could not be read from the local database (E_STORE_LOCKED). Retry."
            />
          </div>
        </State>
      </Section>

      <Section index="06" title="Charts" note="Hand-authored SVG · no charting library · every bar directly labelled">
        <State label="12-month stacked column — snapshot classes stack above the ledger classes">
          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">Net worth by asset class — 12 months</span>
              <span className="panel-meta">Sep 2025 → Aug 2026 · month end</span>
            </div>
            <div className="panel-body">
              <NetWorthStackChart months={fx.TWELVE_MONTHS} />
            </div>
            <div className="legend">
              <span className="lg">
                <span className="sw sw-s1" />
                Indian equity
              </span>
              <span className="lg">
                <span className="sw sw-s2" />
                Mutual funds
              </span>
              <span className="lg">
                <span className="sw sw-s3" />
                Crypto
              </span>
              <span className="lg">
                <span className="sw sw-s4 sw-h" />
                US equity
              </span>
              <span className="lg">
                <span className="sw sw-s5 sw-h" />
                Gold
              </span>
            </div>
            <div className="foot">
              Snapshot classes stack above the ledger classes, so the coverage line is readable in
              the column too.
            </div>
          </div>
        </State>
        <State label="H10 — months before history begins are gaps, never back-filled">
          <div className="panel">
            <div className="panel-body">
              <NetWorthStackChart months={fx.MONTHS_WITH_GAPS} historyBegins="FEB 2026" />
            </div>
          </div>
        </State>
        <State label="Loading / empty / error">
          <div className="panel">
            <div className="panel-body">
              <NetWorthStackChart months={fx.TWELVE_MONTHS} state="loading" />
            </div>
            <NetWorthStackChart months={[]} state="empty" />
            <NetWorthStackChart months={[]} state="error" />
          </div>
        </State>
        <State label="Concentration — top 5 plus the aggregate, with the 20% single-position rule">
          <div className="panel" style={{ maxWidth: '560px' }}>
            <div className="panel-head">
              <span className="panel-title">Concentration — position share of net worth</span>
              <span className="panel-meta">Top 5 of 12</span>
            </div>
            <div className="panel-body">
              <ConcentrationChart rows={fx.CONCENTRATION_TOP5} threshold={dec('20')} />
            </div>
            <div className="foot">
              Bars carry the asset-class hue. Values are labelled on every bar — no colour-only
              reading.
            </div>
          </div>
        </State>
        <State label="Concentration — fewer than two positions">
          <div className="panel" style={{ maxWidth: '560px' }}>
            <ConcentrationChart rows={fx.CONCENTRATION_TOP5.slice(0, 1)} threshold={dec('20')} />
          </div>
        </State>
        <State label="Coverage meter — 71.9%, 0%, 100% · and the currency split bar">
          <div className="grow">
            <div style={{ width: '220px' }}>
              <span className="lab">Measured</span>
              <CoverageMeter pct={dec('71.90')} />
            </div>
            <div style={{ width: '220px' }}>
              <span className="lab">Nothing measured</span>
              <CoverageMeter pct={dec('0')} />
            </div>
            <div style={{ width: '220px' }}>
              <span className="lab">Fully measured</span>
              <CoverageMeter pct={dec('100')} />
            </div>
            <div style={{ width: '220px' }}>
              <span className="lab">Currency exposure</span>
              <SplitBar aPct={dec('76.85')} bPct={dec('23.15')} aLabel="INR" bLabel="USD" />
            </div>
          </div>
        </State>
      </Section>
    </div>
  )
}
