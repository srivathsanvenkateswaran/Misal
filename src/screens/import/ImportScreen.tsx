/**
 * Screen 04 — import.
 *
 * The whole flow: choose which kind of statement, read the request instructions that decide
 * whether it can carry a cost basis at all, pick the file, unlock it if it is encrypted, and read
 * the report.
 *
 * Three things this screen is careful about:
 *
 *   - **It asks which family before it asks for the file.** The format cannot be detected before
 *     decryption, and the two CAS families are unlocked with different things. A single prompt
 *     claiming one rule would be wrong for half of them.
 *   - **A password lives in a promise resolver and nowhere else.** The pipeline asks by calling a
 *     function; this screen answers by rendering a dialog and resolving. Nothing is put in a store,
 *     a query cache, or a log.
 *   - **A document-level failure is not an import.** No `import_run` and no `source_document` are
 *     written for a file that never decoded, so the file stays importable once the user has the
 *     right password. The failure is shown here instead.
 */

import type { ReactNode } from 'react'
import { useCallback, useRef, useState } from 'react'
import {
  DOCUMENT_MESSAGE,
  MemoryStore,
  camsKfinCasPlugin,
  csvDescriptorPlugin,
  loadDescriptor,
  nsdlEcasPlugin,
  pdfjsSource,
  runImport,
  type ExtractPlugin,
  type ImportDeps,
  type ImportOutcome,
} from '@ingestion/index'
import type { PasswordAttempt, PasswordHint, PasswordPrompt } from '@ingestion/pdf/source'
import { listInstruments } from '../../data/client'
import {
  SqliteIngestionStore,
  ignoreUnresolvedInstrument,
  mapUnresolvedInstrument,
  pickStatementFile,
  readStatementBytes,
  unresolvedForDocument,
  type PickedFile,
  type UnresolvedEntryRow,
} from '../../data/import'
import zerodhaTradebook from '@ingestion/csv/descriptors/zerodha-console-tradebook.yaml?raw'
import { ImportReview } from './ImportReview'
import { PasswordDialog } from './PasswordDialog'
import type { InstrumentChoice } from './UnresolvedQueue'
import { SOURCE_FAMILIES, sourceFamily, type SourceFamilyId } from './sources'
import './import.css'

/** Everything the screen does to the outside world, in one place so a test can stand in for it. */
export interface ImportRuntime {
  pickFile: () => Promise<PickedFile | null>
  readBytes: (path: string) => Promise<Uint8Array>
  runImport: (
    bytes: Uint8Array,
    originalName: string,
    password: PasswordPrompt,
    passwordHint: PasswordHint | undefined,
  ) => Promise<ImportOutcome>
  unresolvedForDocument: (documentId: string) => Promise<readonly UnresolvedEntryRow[]>
  listInstruments: () => Promise<readonly InstrumentChoice[]>
  mapUnresolved: (entryId: string, instrumentId: string) => Promise<unknown>
  ignoreUnresolved: (entryId: string) => Promise<void>
}

const PARSER_VERSION = '1'

/**
 * The plugins the application ships.
 *
 * The CSV descriptor is loaded as text and validated at runtime, which is what makes adding a
 * broker a data change rather than a code change. A descriptor that fails validation is dropped
 * rather than crashing the screen: the other importers still work, and the loader's line-and-column
 * error belongs to the contributor's build, not to this user's evening.
 *
 * Only descriptors whose `providerId` is a provider the database already knows can be shipped —
 * `source_document.provider_id` is a foreign key, so a descriptor introducing its own provider
 * would fail at commit. See the note in the branch summary.
 */
function shippedPlugins(): ExtractPlugin[] {
  const plugins: ExtractPlugin[] = [camsKfinCasPlugin, nsdlEcasPlugin]
  const descriptor = loadDescriptor(zerodhaTradebook, 'zerodha-console-tradebook.yaml')
  if (descriptor.ok) plugins.push(csvDescriptorPlugin(descriptor.descriptor))
  return plugins
}

function defaultRuntime(): ImportRuntime {
  const store = new SqliteIngestionStore()
  const deps: ImportDeps = {
    store,
    plugins: shippedPlugins(),
    now: () => new Date().toISOString(),
    newId: () => crypto.randomUUID(),
    pdfSource: pdfjsSource(),
    parserVersion: PARSER_VERSION,
  }
  return {
    pickFile: () => pickStatementFile(),
    readBytes: (path) => readStatementBytes(path),
    runImport: (bytes, originalName, password, passwordHint) =>
      runImport(
        {
          bytes,
          originalName,
          password,
          ...(passwordHint === undefined ? {} : { passwordHint }),
        },
        deps,
      ),
    unresolvedForDocument: (documentId) => unresolvedForDocument(documentId),
    listInstruments: async () =>
      (await listInstruments()).map((row) => ({
        id: row.id,
        displayName: row.displayName,
        isin: row.isin,
        assetClass: row.assetClass,
      })),
    mapUnresolved: (entryId, instrumentId) => mapUnresolvedInstrument(entryId, instrumentId),
    ignoreUnresolved: (entryId) => ignoreUnresolvedInstrument(entryId),
  }
}

interface PendingPassword {
  readonly attempt: number
  readonly hint: PasswordHint
  readonly resolve: (answer: PasswordAttempt | null) => void
}

interface CompletedImport {
  readonly file: PickedFile
  readonly outcome: Extract<ImportOutcome, { status: 'completed' }>
  readonly unlockedWith: string
}

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working'; readonly file: PickedFile }
  | { readonly kind: 'completed'; readonly result: CompletedImport }
  | {
      readonly kind: 'already-imported'
      readonly file: PickedFile
      readonly importedAt: string
    }
  | { readonly kind: 'failed'; readonly file: PickedFile; readonly code: string; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }

export interface ImportScreenProps {
  readonly runtime?: ImportRuntime
  /**
   * Called after an import commits anything.
   *
   * The shell uses this to invalidate the portfolio query. Without it a user imports a statement,
   * watches the review report rows committed, returns to the dashboard and sees the figures they
   * had before - which reads as the import having failed.
   */
  readonly onImported?: () => void
}

export function ImportScreen(props: ImportScreenProps): ReactNode {
  const runtimeRef = useRef<ImportRuntime | null>(props.runtime ?? null)
  runtimeRef.current ??= defaultRuntime()
  const runtime = runtimeRef.current

  const [familyId, setFamilyId] = useState<SourceFamilyId>('cams-kfin-cas')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [pending, setPending] = useState<PendingPassword | null>(null)
  const [unresolved, setUnresolved] = useState<readonly UnresolvedEntryRow[]>([])
  const [instruments, setInstruments] = useState<readonly InstrumentChoice[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [queueNote, setQueueNote] = useState<string | null>(null)
  const unlocked = useRef<string>('nothing — the file was not encrypted')

  const family = sourceFamily(familyId)

  const prompt = useCallback<PasswordPrompt>(
    (attempt, hint) =>
      new Promise<PasswordAttempt | null>((resolve) => {
        setPending({ attempt, hint, resolve })
      }),
    [],
  )

  const start = async (): Promise<void> => {
    setQueueNote(null)
    let file: PickedFile | null
    try {
      file = await runtime.pickFile()
    } catch (error) {
      setPhase({ kind: 'error', message: describe(error) })
      return
    }
    if (file === null) return

    unlocked.current = 'nothing — the file was not encrypted'
    setPhase({ kind: 'working', file })

    try {
      const bytes = await runtime.readBytes(file.path)
      const outcome = await runtime.runImport(bytes, file.name, prompt, family.passwordHint)

      if (outcome.status === 'already-imported') {
        setPhase({ kind: 'already-imported', file, importedAt: outcome.importedAt })
        return
      }
      if (outcome.status === 'failed') {
        setPhase({ kind: 'failed', file, code: outcome.code, message: outcome.message })
        return
      }

      setPhase({
        kind: 'completed',
        result: { file, outcome, unlockedWith: unlocked.current },
      })
      // Committed rows are now in the database, so anything showing portfolio figures is stale.
      // Fired even when rows_failed is non-zero: a partial import still changed the totals.
      props.onImported?.()
      const [queue, catalogue] = await Promise.all([
        runtime.unresolvedForDocument(outcome.documentId),
        runtime.listInstruments(),
      ])
      setUnresolved(queue)
      setInstruments(catalogue)
    } catch (error) {
      setPhase({ kind: 'error', message: describe(error) })
    } finally {
      setPending(null)
    }
  }

  const answerPassword = (answer: PasswordAttempt | null): void => {
    if (pending === null) return
    if (answer !== null) {
      // What is recorded is the shape of the answer, never the answer.
      unlocked.current =
        pending.hint.style === 'pan-uppercase'
          ? answer.dateOfBirth === undefined
            ? 'PAN of the first holder'
            : 'PAN + date of birth'
          : 'the password chosen when the statement was requested'
    }
    pending.resolve(answer)
    setPending(null)
  }

  const onMap = (entryId: string, instrumentId: string): void => {
    setBusyId(entryId)
    void runtime
      .mapUnresolved(entryId, instrumentId)
      .then(() => {
        setUnresolved((entries) => entries.filter((entry) => entry.id !== entryId))
        setQueueNote(
          'Mapped. Misal has learned that identifier, so the next statement carrying it resolves ' +
            'without asking. The rows this import withheld are released when a document containing ' +
            'them is imported again.',
        )
      })
      .catch((error: unknown) => {
        setQueueNote(describe(error))
      })
      .finally(() => {
        setBusyId(null)
      })
  }

  const onIgnore = (entryId: string): void => {
    setBusyId(entryId)
    void runtime
      .ignoreUnresolved(entryId)
      .then(() => {
        setUnresolved((entries) => entries.filter((entry) => entry.id !== entryId))
        setQueueNote(
          'Dismissed. Its value stays out of every total and the entry stays in Settings → ' +
            'Review queue.',
        )
      })
      .catch((error: unknown) => {
        setQueueNote(describe(error))
      })
      .finally(() => {
        setBusyId(null)
      })
  }

  return (
    <main className="imp-screen">
      <h1 className="imp-title">Import</h1>

      {phase.kind !== 'completed' && (
        <Chooser
          familyId={familyId}
          onFamily={setFamilyId}
          onChoose={() => {
            void start()
          }}
          busy={phase.kind === 'working'}
        />
      )}

      {phase.kind === 'working' && (
        <p className="imp-status" role="status">
          Reading {phase.file.name}…
        </p>
      )}

      {phase.kind === 'already-imported' && (
        <div className="panel imp-panel imp-note">
          <div className="panel-body">
            <strong>{phase.file.name} was already imported on {phase.importedAt}.</strong>
            <p className="muted">
              No changes were made and no import was recorded, because nothing happened. Misal
              recognises a file by the checksum of its bytes.
            </p>
          </div>
        </div>
      )}

      {phase.kind === 'failed' && (
        <div className="panel imp-panel imp-failure" role="alert">
          <div className="panel-body">
            <span className="lab">{phase.code}</span>
            <strong className="imp-banner-line">{phase.message}</strong>
            <p className="muted">
              Nothing was written. {remedy(phase.code)} The file stays importable — Misal records a
              document only once it has read one.
            </p>
          </div>
        </div>
      )}

      {phase.kind === 'error' && (
        <div className="panel imp-panel imp-failure" role="alert">
          <div className="panel-body">
            <strong className="imp-banner-line">The import could not be completed</strong>
            <p className="muted">{phase.message} Nothing was written.</p>
          </div>
        </div>
      )}

      {phase.kind === 'completed' && (
        <>
          {queueNote !== null && (
            <p className="imp-status" role="status">
              {queueNote}
            </p>
          )}
          <ImportReview
            file={{ name: phase.result.file.name, byteLength: phase.result.file.byteLength }}
            contentHash={phase.result.outcome.contentHash}
            documentId={phase.result.outcome.documentId}
            runId={phase.result.outcome.runId}
            pluginId={phase.result.outcome.pluginId}
            parserLabel={family.label}
            stampCode={stampCode(familyId)}
            pageRef={pageRefOf(phase.result.outcome)}
            unlockedWith={phase.result.unlockedWith}
            counters={phase.result.outcome.counters}
            issues={phase.result.outcome.issues}
            accountCount={phase.result.outcome.accountIds.length}
            unresolved={unresolved}
            instruments={instruments}
            onMap={onMap}
            onIgnore={onIgnore}
            busyId={busyId}
            onImportAnother={() => {
              setUnresolved([])
              setQueueNote(null)
              setPhase({ kind: 'idle' })
            }}
          />
        </>
      )}

      {pending !== null && (
        <PasswordDialog
          attempt={pending.attempt}
          hint={pending.hint}
          fileName={phase.kind === 'working' ? phase.file.name : 'This statement'}
          onSubmit={answerPassword}
          onCancel={() => {
            answerPassword(null)
          }}
        />
      )}
    </main>
  )
}

function Chooser({
  familyId,
  onFamily,
  onChoose,
  busy,
}: {
  readonly familyId: SourceFamilyId
  readonly onFamily: (id: SourceFamilyId) => void
  readonly onChoose: () => void
  readonly busy: boolean
}): ReactNode {
  const family = sourceFamily(familyId)
  return (
    <div className="panel imp-panel">
      <div className="panel-head">
        <span className="panel-title">Import a statement</span>
        <span className="panel-meta">Files arrive because you chose one</span>
      </div>
      <div className="panel-body">
        <fieldset className="imp-families">
          <legend className="lab">What are you importing?</legend>
          {SOURCE_FAMILIES.map((candidate) => (
            <label key={candidate.id} className="imp-family">
              <input
                type="radio"
                name="source-family"
                value={candidate.id}
                checked={candidate.id === familyId}
                onChange={() => {
                  onFamily(candidate.id)
                }}
              />
              <span>
                <span className="imp-family-label">{candidate.label}</span>
                <span className="sublab">{candidate.summary}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="imp-instructions">
          <span className="lab">How to request it</span>
          <ul>
            {family.instructions.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="conf">{family.capability}</p>
        </div>

        <div className="imp-queue-actions">
          <button className="btn btn-strong" type="button" onClick={onChoose} disabled={busy}>
            Choose a file
          </button>
          <span className="conf">
            Misal never logs into a registrar, never reads your email, and never copies the file.
          </span>
        </div>
      </div>
    </div>
  )
}

function stampCode(familyId: SourceFamilyId): string {
  switch (familyId) {
    case 'cams-kfin-cas':
      return 'CAS'
    case 'nsdl-ecas':
      return 'NSD'
    case 'cdsl-ecas':
      return 'CDS'
    case 'csv':
      return 'CSV'
  }
}

/**
 * What a stamp on this report points at.
 *
 * The document's own page span is recorded on `source_document.page_ref`, but the import outcome
 * does not carry it back, so the stamps say which document rather than which page. A specific page
 * reference lives on each issue and is used where there is one.
 */
function pageRefOf(outcome: Extract<ImportOutcome, { status: 'completed' }>): string {
  return outcome.pluginId.includes('csv') ? 'rows' : 'document'
}

/** The two document-level failures a user can actually do something about. */
function remedy(code: string): string {
  if (code === 'E_SCANNED_PDF') {
    return `${DOCUMENT_MESSAGE.E_SCANNED_PDF} Request a fresh statement from the registrar, or import the broker's CSV instead.`
  }
  if (code === 'E_PASSWORD_INCORRECT' || code === 'E_PASSWORD_REQUIRED') {
    return 'Check which password this family uses — the two CAS families do not share one.'
  }
  return ''
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'Unknown failure.'
}

/**
 * A store that keeps an import in memory.
 *
 * Exported so the gallery and the screen tests can exercise the real pipeline without a database.
 * It is the same `MemoryStore` the ingestion tests use, and it enforces the same constraints.
 */
export { MemoryStore as InMemoryIngestionStore }
