/**
 * The flow, driven through a stand-in runtime.
 *
 * What matters here is not that a button renders. It is that the screen asks the right password
 * question for the family the user picked, that a document-level failure is reported as "nothing
 * was written" rather than as a broken import, and that a queue entry can be mapped from the report
 * without any of it blocking.
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ImportOutcome } from '@ingestion/index'
import type { PasswordAttempt, PasswordHint, PasswordPrompt } from '@ingestion/pdf/source'
import type { UnresolvedEntryRow } from '../../data/import'
import { ImportScreen, type ImportRuntime } from './ImportScreen'

const FILE = { path: '/statements/cas.pdf', name: 'cas.pdf', byteLength: 2_400_000 }

const COMPLETED: Extract<ImportOutcome, { status: 'completed' }> = {
  status: 'completed',
  contentHash: '4f9c00000000000000000000000000000000000000000000000000000000a713',
  documentId: 'd1',
  runId: 'r47',
  pluginId: 'cams-kfin-cas',
  counters: { read: 8, committed: 5, duplicate: 1, skipped: 1, failed: 1, withheld: 1 },
  issues: [
    { severity: 'error', code: 'E_DATE_PARSE', message: 'not a valid date', ref: 'p.11 r.3' },
  ],
  accountIds: ['a1'],
}

const QUEUE: UnresolvedEntryRow[] = [
  {
    id: 'u1',
    sourceDocumentId: 'd1',
    accountId: 'a1',
    rawIdentifier: 'isin:INF179K01YV8',
    rawName: 'HDFC BALANCED ADVANTAGE FUND',
    assetClassHint: 'mutual_fund',
    observedQuantity: '412.882',
    observedValueMinor: '11864000',
    currency: 'INR',
    firstSeenAt: '2026-08-12T10:44:00Z',
  },
]

function runtime(over: Partial<ImportRuntime> = {}): ImportRuntime {
  return {
    pickFile: vi.fn().mockResolvedValue(FILE),
    readBytes: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    runImport: vi.fn().mockResolvedValue(COMPLETED),
    unresolvedForDocument: vi.fn().mockResolvedValue(QUEUE),
    listInstruments: vi.fn().mockResolvedValue([
      { id: 'i-hdfc', displayName: 'HDFC Balanced Advantage', isin: null, assetClass: 'mutual_fund' },
    ]),
    mapUnresolved: vi.fn().mockResolvedValue({ aliasScheme: 'isin', released: 1 }),
    ignoreUnresolved: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

const choose = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Choose a file' }))
}

describe('ImportScreen', () => {
  it('states the request instructions that decide whether a cost basis is possible', () => {
    render(<ImportScreen runtime={runtime()} />)
    expect(
      screen.getByText(/Detailed \(Includes transaction listing\)/),
    ).toBeInTheDocument()
    expect(screen.getByText(/FROM DATE to 01-01-1990/)).toBeInTheDocument()
  })

  it('does not claim one password rule for both CAS families', () => {
    render(<ImportScreen runtime={runtime()} />)
    expect(screen.getByText(/The password is the one you typed on the request form/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: /NSDL consolidated account statement/ }))
    expect(
      screen.getByText(/the PAN of the first account holder, in capitals/),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/The password is the one you typed on the request form/),
    ).not.toBeInTheDocument()
  })

  it('asks for a password the way the chosen family expects, and answers the pipeline', async () => {
    let asked: PasswordHint | null = null
    let answered: string | PasswordAttempt | null | undefined
    const deferred = vi.fn(
      async (
        _bytes: Uint8Array,
        _name: string,
        password: PasswordPrompt,
        hint: PasswordHint | undefined,
      ) => {
        asked = hint ?? null
        answered = await password(1, hint ?? { providerId: 'x', style: 'user-chosen', message: '' })
        return COMPLETED
      },
    )
    render(<ImportScreen runtime={runtime({ runImport: deferred })} />)
    fireEvent.click(screen.getByRole('radio', { name: /NSDL consolidated account statement/ }))
    choose()

    const dialog = await screen.findByRole('dialog')
    expect(asked).not.toBeNull()
    expect(screen.getByLabelText('PAN of the first holder')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('PAN of the first holder'), {
      target: { value: 'abcde1234f' },
    })
    fireEvent.change(screen.getByLabelText(/date of birth/i), { target: { value: '01011980' } })
    fireEvent.submit(dialog)

    await screen.findByRole('heading', { name: /Import completed/ })
    // The pipeline uppercases and composes the candidates; the screen passes on what was typed.
    expect(answered).toEqual({ password: 'abcde1234f', dateOfBirth: '01011980' })
    // What is recorded on the report is the shape of the answer, never the answer.
    expect(screen.getByText(/PAN \+ date of birth/)).toBeInTheDocument()
    expect(screen.queryByText(/abcde1234f/i)).not.toBeInTheDocument()
  })

  it('offers no date-of-birth field where the password is user-chosen', async () => {
    const deferred = vi.fn(
      async (
        _bytes: Uint8Array,
        _name: string,
        password: PasswordPrompt,
        hint: PasswordHint | undefined,
      ) => {
        await password(1, hint ?? { providerId: 'x', style: 'user-chosen', message: '' })
        return COMPLETED
      },
    )
    render(<ImportScreen runtime={runtime({ runImport: deferred })} />)
    choose()

    await screen.findByRole('dialog')
    expect(screen.getByLabelText('Statement password')).toBeInTheDocument()
    expect(screen.queryByLabelText(/date of birth/i)).not.toBeInTheDocument()
  })

  it('renders the report, including the rows it could not read', async () => {
    render(<ImportScreen runtime={runtime()} />)
    choose()

    await screen.findByRole('heading', { name: /Import completed — 5 rows applied/ })
    expect(screen.getByText('not a valid date')).toBeInTheDocument()
    expect(await screen.findByText(/₹1,18,640 withheld from every total/)).toBeInTheDocument()
  })

  it('maps a queue entry from the report without blocking anything', async () => {
    const deps = runtime()
    render(<ImportScreen runtime={deps} />)
    choose()

    await screen.findByRole('heading', { name: /Import completed/ })
    const select = await screen.findByLabelText('Map to')
    fireEvent.change(select, { target: { value: 'i-hdfc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Map' }))

    await waitFor(() => {
      expect(deps.mapUnresolved).toHaveBeenCalledWith('u1', 'i-hdfc')
    })
    expect(
      await screen.findByText(/every identifier in this document is mapped/),
    ).toBeInTheDocument()
    expect(screen.getByText(/the next statement carrying it resolves/)).toBeInTheDocument()
  })

  it('reports a file it has seen before as a no-op rather than an error', async () => {
    const seen: ImportOutcome = {
      status: 'already-imported',
      contentHash: 'abc',
      documentId: 'd1',
      importedAt: '2026-03-14T09:00:00Z',
    }
    render(<ImportScreen runtime={runtime({ runImport: vi.fn().mockResolvedValue(seen) })} />)
    choose()

    expect(await screen.findByText(/was already imported on 2026-03-14/)).toBeInTheDocument()
    expect(screen.getByText(/No changes were made and no import was recorded/)).toBeInTheDocument()
  })

  it('says nothing was written when the document itself could not be read', async () => {
    const failed: ImportOutcome = {
      status: 'failed',
      contentHash: 'abc',
      code: 'E_SCANNED_PDF',
      message: 'This looks like a scan or a photo.',
    }
    render(<ImportScreen runtime={runtime({ runImport: vi.fn().mockResolvedValue(failed) })} />)
    choose()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('E_SCANNED_PDF')
    expect(alert).toHaveTextContent('Nothing was written.')
    // The file must stay importable: a document that never decoded writes no source_document, so
    // its content hash is not burned.
    expect(alert).toHaveTextContent(/The file stays importable/)
  })

  it('treats a closed file picker as nothing having happened', async () => {
    const deps = runtime({ pickFile: vi.fn().mockResolvedValue(null) })
    render(<ImportScreen runtime={deps} />)
    choose()
    await waitFor(() => {
      expect(deps.pickFile).toHaveBeenCalled()
    })
    expect(deps.readBytes).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('cancels the import when the password dialog is dismissed', async () => {
    let answered: string | PasswordAttempt | null | undefined = undefined
    const deferred = vi.fn(
      async (
        _bytes: Uint8Array,
        _name: string,
        password: PasswordPrompt,
        hint: PasswordHint | undefined,
      ) => {
        answered = await password(2, hint ?? { providerId: 'x', style: 'user-chosen', message: '' })
        const refused: ImportOutcome = {
          status: 'failed',
          contentHash: 'abc',
          code: 'E_PASSWORD_REQUIRED',
          message: 'This statement is password protected.',
        }
        return refused
      },
    )
    render(<ImportScreen runtime={runtime({ runImport: deferred })} />)
    choose()

    await screen.findByRole('dialog')
    expect(screen.getByText(/Attempt 2 of 3/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel import' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('E_PASSWORD_REQUIRED')
    expect(answered).toBeNull()
  })
})
