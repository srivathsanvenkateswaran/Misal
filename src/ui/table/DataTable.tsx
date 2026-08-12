/**
 * `DataTable` — the table shell (spec §8.6, §8.7).
 *
 * Headless-ish on purpose: it owns the mockup's rules, rhythm and the 56px provenance gutter, and
 * nothing else. Sorting, grouping and column visibility belong to the caller (TanStack Table in
 * the app), which is what keeps this shell usable for the holdings table, the allocation table,
 * the coverage-by-metric table and the sync log without any of them bending it.
 *
 * The gutter column is not optional. H6 says every row displaying a figure traceable to a document
 * carries a `SourceStamp`; a table without a gutter has nowhere to put one, so the gutter is part
 * of the shell rather than a column the caller may forget.
 */

import type { ReactNode } from 'react'
import { useId } from 'react'
import type { SourceStampProps } from '../provenance/SourceStamp'
import { SourceStamp } from '../provenance/SourceStamp'
import './DataTable.css'

export type ColumnAlign = 'left' | 'right'

export interface DataTableColumn<R> {
  readonly id: string
  readonly header: ReactNode
  readonly align?: ColumnAlign
  readonly width?: string
  readonly cell: (row: R) => ReactNode
}

export type DataTableRow<R> =
  | {
      readonly kind: 'data'
      readonly key: string
      readonly row: R
      readonly stamp?: SourceStampProps | undefined
    }
  | {
      readonly kind: 'total'
      readonly key: string
      readonly row: R
      readonly stamp?: SourceStampProps | undefined
    }
  | { readonly kind: 'group'; readonly key: string; readonly label: ReactNode }

export type TableState = 'ready' | 'loading' | 'empty' | 'error' | 'refreshing'

export interface DataTableProps<R> {
  readonly columns: readonly DataTableColumn<R>[]
  readonly rows: readonly DataTableRow<R>[]
  readonly caption: string
  /** The gutter column's header. 'Src' in every screen of the mockup. */
  readonly gutterHeader?: string
  readonly state?: TableState
  readonly emptyMessage?: string
  readonly errorMessage?: string
  readonly foot?: ReactNode
  readonly skeletonRows?: number
}

export function DataTable<R>(props: DataTableProps<R>): ReactNode {
  const state = props.state ?? 'ready'
  const columns = props.columns
  const afterId = useId()
  const dataRowCount = props.rows.filter((row) => row.kind !== 'group').length
  const span = columns.length + 1

  return (
    <>
      <a className="btn dtable-skip" href={`#${afterId}`}>
        Skip table ({dataRowCount} rows)
      </a>
      <table
        className="dtable"
        data-state={state}
        data-refreshing={state === 'refreshing' ? 'true' : undefined}
      >
        <caption className="vh">{props.caption}</caption>
        <thead>
          <tr>
            <th className="pgut" scope="col">
              {props.gutterHeader ?? 'Src'}
            </th>
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={column.align === 'right' ? 'num' : undefined}
                style={column.width === undefined ? undefined : { width: column.width }}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {state === 'loading' &&
            Array.from({ length: props.skeletonRows ?? 5 }, (_unused, index) => (
              <tr key={`skeleton-${String(index)}`} aria-hidden="true">
                <td className="pgut">
                  <span className="skel" style={{ height: '18px', width: '34px' }} />
                </td>
                {columns.map((column) => (
                  <td key={column.id}>
                    <span className="skel" style={{ height: '11px' }} />
                  </td>
                ))}
              </tr>
            ))}

          {state === 'empty' && (
            <tr className="dtable-message">
              <td colSpan={span}>{props.emptyMessage ?? 'Nothing to show yet.'}</td>
            </tr>
          )}

          {state === 'error' && (
            <tr className="dtable-message">
              <td colSpan={span} role="alert">
                {props.errorMessage ?? 'This table could not be loaded.'}
              </td>
            </tr>
          )}

          {(state === 'ready' || state === 'refreshing') &&
            props.rows.map((row) => {
              if (row.kind === 'group') {
                return (
                  <tr className="grp" key={row.key}>
                    <td className="pgut" aria-hidden="true" />
                    <th scope="rowgroup" colSpan={columns.length}>
                      {row.label}
                    </th>
                  </tr>
                )
              }
              return (
                <tr className={row.kind === 'total' ? 'tot' : undefined} key={row.key}>
                  <td className="pgut">
                    {row.stamp === undefined ? null : <SourceStamp {...row.stamp} />}
                  </td>
                  {columns.map((column) => (
                    <td key={column.id} className={column.align === 'right' ? 'num' : undefined}>
                      {column.cell(row.row)}
                    </td>
                  ))}
                </tr>
              )
            })}
        </tbody>
      </table>
      <span id={afterId} tabIndex={-1} />
      {props.foot !== undefined && <div className="foot">{props.foot}</div>}
    </>
  )
}
