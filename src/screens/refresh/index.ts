/**
 * Screen 07 — Refresh.
 *
 * `RefreshPanel` is the whole screen and needs nothing but a mount point: it reads its own rows,
 * plans its own refresh and reports what happened where it happened. `runtime` exists so a test can
 * stand in for the network and the IPC boundary — every test of this screen injects one, and none
 * of them opens a socket. `onRefreshed` is how the shell learns that stored prices moved and that
 * the cached valuation is now out of date.
 *
 * `buildPlan` and `buildReport` are exported alongside it because they are the interesting half:
 * what a refresh would do, and what it did, as data rather than as markup.
 */

export { RefreshPanel } from './RefreshPanel'
export type {
  NetworkStatement,
  RefreshPanelProps,
  RefreshProgress,
  RefreshRequest,
  RefreshRuntime,
} from './RefreshPanel'
export { STATUS_LABEL, buildPlan, buildReport, countByStatus } from './plan'
export type {
  Freshness,
  PlanRow,
  ProviderLoad,
  RefreshPlan,
  RefreshRun,
  ReportRow,
  ReportStatus,
  SavedPriceRow,
} from './plan'
