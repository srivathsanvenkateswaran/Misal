/**
 * Screen 07 — Exchanges.
 *
 * `ExchangesScreen` is the whole screen and needs nothing but a mount point: it loads its own
 * connected accounts, owns the connect flow, runs the sync and reports what it could not see.
 * `runtime` exists so a test can stand in for the IPC boundary; `onSynced` is how the shell learns
 * that committed rows have moved the portfolio.
 *
 * The pieces are exported individually because the disclosure and the sync report are worth
 * reaching from elsewhere — an account row that wants to explain why a crypto account shows no
 * cost basis should be able to render the same words rather than write its own.
 */

export {
  ExchangesScreen,
  type ExchangesScreenProps,
} from './ExchangesScreen'
export { ConnectPanel, type ConnectPanelProps, type CredentialSubmission } from './ConnectPanel'
export { Connections, type ConnectionsProps } from './Connections'
export {
  AcknowledgementRequest,
  NoConnections,
  RefusalNotice,
  ScopeSummary,
  SyncProgressView,
  SyncReportView,
  formatElapsed,
  type SyncProgressViewProps,
  type SyncReportViewProps,
} from './SyncReport'
export {
  CONVERT_BLIND_SPOT,
  SNAPSHOT_CONSEQUENCE,
  providerDisclosure,
  type ProviderDisclosure,
} from './disclosure'
export { REDACTED, describeSafely, redactCredential } from './redact'
export {
  DISCONNECT_COMMAND,
  defaultRuntime,
  isProviderId,
  type ConnectRequest,
  type ConnectionView,
  type ExchangeRuntime,
} from './runtime'
