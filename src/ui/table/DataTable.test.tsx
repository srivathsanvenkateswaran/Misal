import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Metric } from '../measured/Metric'
import * as fx from '../gallery/fixtures'
import type { HoldingRow } from '../gallery/fixtures'
import { assertHonest, honestyViolations } from '../testing/assert-honest'
import type { DataTableColumn, DataTableRow } from './DataTable'
import { DataTable } from './DataTable'

const COLUMNS: readonly DataTableColumn<HoldingRow>[] = [
  { id: 'name', header: 'Instrument', cell: (row) => row.name },
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
        scope="position"
        basis="ledger"
        size="table"
      />
    ),
  },
  {
    id: 'price',
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
        {row.priceNote !== undefined && <span className="sub">{row.priceNote}</span>}
      </>
    ),
  },
]

const ROWS: readonly DataTableRow<HoldingRow>[] = [
  { kind: 'group', key: 'grp', label: 'Mutual funds · 3 positions' },
  ...fx.HOLDING_ROWS.map(
    (row): DataTableRow<HoldingRow> => ({ kind: 'data', key: row.key, row, stamp: row.stamp }),
  ),
  { kind: 'total', key: 'total', row: fx.TOTAL_ROW, stamp: fx.TOTAL_ROW.stamp },
]

describe('DataTable', () => {
  it('renders a semantic table with the gutter column and real header scopes', () => {
    const { container } = render(
      <DataTable caption="Holdings" columns={COLUMNS} rows={ROWS} />,
    )
    expect(screen.getByRole('table', { name: 'Holdings' })).toBeInTheDocument()
    expect(container.querySelector('thead th.pgut')?.textContent).toBe('Src')
    expect(container.querySelectorAll('thead th')).toHaveLength(COLUMNS.length + 1)
    expect(container.querySelector('.grp th')).toHaveAttribute('scope', 'rowgroup')
    expect(container.querySelector('tr.tot')).not.toBeNull()
    assertHonest(container)
  })

  it('stamps every figure-bearing row (H6)', () => {
    const { container } = render(<DataTable caption="Holdings" columns={COLUMNS} rows={ROWS} />)
    for (const row of container.querySelectorAll('tbody tr')) {
      if (row.querySelector('[data-metric]') === null) continue
      expect(row.querySelector('td.pgut .pmark')).not.toBeNull()
    }
    expect(honestyViolations(container)).toEqual([])
  })

  it('withholds cost and P&L on the snapshot rows rather than showing a zero (H1, H3)', () => {
    const { container } = render(<DataTable caption="Holdings" columns={COLUMNS} rows={ROWS} />)
    const snapshotRow = container.querySelector('tbody tr:nth-of-type(3)')
    expect(snapshotRow?.textContent).toContain('Caterpillar Inc')
    expect(snapshotRow?.querySelector('[data-not-measured]')?.textContent).toContain('Not measured')
    expect(snapshotRow?.textContent).not.toContain('₹0')
    assertHonest(container)
  })

  it('says how old a stale price is, in words, beside an alert stamp (H7)', () => {
    const { container } = render(<DataTable caption="Holdings" columns={COLUMNS} rows={ROWS} />)
    const staleRow = container.querySelector('[data-stale-days="15"]')?.closest('tr')
    expect(staleRow?.textContent).toContain('15 d old')
    expect(staleRow?.querySelector('[data-stamp-alert="true"]')).not.toBeNull()
    assertHonest(container)
  })

  it('loads with skeleton rows that preserve the gutter, and no numerals', () => {
    const { container } = render(
      <DataTable caption="Holdings" columns={COLUMNS} rows={[]} state="loading" skeletonRows={4} />,
    )
    expect(container.querySelectorAll('tbody tr')).toHaveLength(4)
    expect(container.querySelectorAll('tbody td.pgut')).toHaveLength(4)
    expect(container.querySelector('[data-metric]')).toBeNull()
    expect(container.querySelector('tbody')?.textContent).toBe('')
    assertHonest(container)
  })

  it('names what is absent when empty, rather than rendering zeros', () => {
    render(
      <DataTable
        caption="Holdings"
        columns={COLUMNS}
        rows={[]}
        state="empty"
        emptyMessage="No positions yet — import #47 completed but produced no holdings."
      />,
    )
    expect(screen.getByText(/No positions yet/)).toBeInTheDocument()
  })

  it('keeps the header row on error so the user knows what failed', () => {
    const { container } = render(
      <DataTable
        caption="Holdings"
        columns={COLUMNS}
        rows={[]}
        state="error"
        errorMessage="Positions could not be read (E_STORE_LOCKED)."
      />,
    )
    expect(container.querySelectorAll('thead th')).toHaveLength(COLUMNS.length + 1)
    expect(screen.getByRole('alert')).toHaveTextContent('E_STORE_LOCKED')
  })

  it('offers a skip link rather than putting every row in the tab order', () => {
    render(<DataTable caption="Holdings" columns={COLUMNS} rows={ROWS} />)
    expect(screen.getByRole('link', { name: /Skip table \(4 rows\)/ })).toBeInTheDocument()
  })
})
