import { describe, expect, it, vi } from 'vitest'
import { DocumentFailure } from '../issues'
import { fakePdfSource } from '../testing/fake-pdf'
import { camsDetailedPages, scannedPages } from '../testing/corpus'
import {
  GENERIC_PASSWORD_HINT,
  PASSWORD_HINTS,
  assertNotScanned,
  openPdf,
  type PasswordPrompt,
} from './source'

const BYTES = new TextEncoder().encode('%PDF-1.7')

function hint(providerId: keyof typeof PASSWORD_HINTS) {
  const value = PASSWORD_HINTS[providerId]
  if (value === undefined) throw new Error('unknown provider')
  return value
}

describe('password handling', () => {
  it('tries the empty password first and never prompts for an open file', async () => {
    const prompt = vi.fn<PasswordPrompt>()
    const opened = await openPdf(fakePdfSource(camsDetailedPages()), BYTES, GENERIC_PASSWORD_HINT, prompt)
    expect(opened.form).toBe('empty')
    expect(prompt).not.toHaveBeenCalled()
  })

  it('asks the CAMS user for the password they chose, not for their PAN', async () => {
    const prompt = vi.fn<PasswordPrompt>().mockResolvedValue('test-password')
    const opened = await openPdf(
      fakePdfSource(camsDetailedPages(), { password: 'test-password' }),
      BYTES,
      hint('cams-kfin-cas'),
      prompt,
    )
    expect(opened.form).toBe('as-typed')
    const passed = prompt.mock.calls[0]?.[1]
    expect(passed?.style).toBe('user-chosen')
    expect(passed?.message).toMatch(/password you chose/i)
    expect(passed?.message).not.toMatch(/PAN/i)
  })

  it('uppercases a depository PAN before trying it', async () => {
    const prompt = vi.fn<PasswordPrompt>().mockResolvedValue('aaaaa0000a')
    const opened = await openPdf(
      fakePdfSource(camsDetailedPages(), { password: 'AAAAA0000A' }),
      BYTES,
      hint('nsdl-ecas'),
      prompt,
    )
    expect(opened.form).toBe('uppercased')
    expect(prompt.mock.calls[0]?.[1].message).toMatch(/PAN/i)
  })

  it('retries a depository file once with PAN and date of birth', async () => {
    const prompt = vi
      .fn<PasswordPrompt>()
      .mockResolvedValue({ password: 'AAAAA0000A', dateOfBirth: '15081985' })
    const opened = await openPdf(
      fakePdfSource(camsDetailedPages(), { password: 'AAAAA0000A15081985' }),
      BYTES,
      hint('cdsl-ecas'),
      prompt,
    )
    // Which form succeeded is recorded. The value never is.
    expect(opened.form).toBe('pan-with-dob')
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('reports that a password is needed when there is no prompt', async () => {
    await expect(
      openPdf(fakePdfSource(camsDetailedPages(), { password: 'x' }), BYTES, GENERIC_PASSWORD_HINT, undefined),
    ).rejects.toMatchObject({ code: 'E_PASSWORD_REQUIRED' })
  })

  it('treats a cancelled prompt as a request for a password, not a wrong one', async () => {
    const prompt: PasswordPrompt = () => Promise.resolve(null)
    await expect(
      openPdf(fakePdfSource(camsDetailedPages(), { password: 'x' }), BYTES, GENERIC_PASSWORD_HINT, prompt),
    ).rejects.toMatchObject({ code: 'E_PASSWORD_REQUIRED' })
  })

  it('reports an unsupported cipher distinctly from a wrong password', async () => {
    await expect(
      openPdf(
        fakePdfSource(camsDetailedPages(), { cipherUnsupported: true }),
        BYTES,
        GENERIC_PASSWORD_HINT,
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'E_PDF_CIPHER' })
  })

  it('never puts the password in the failure it reports', async () => {
    const prompt: PasswordPrompt = () => Promise.resolve('hunter2-secret')
    const error = await openPdf(
      fakePdfSource(camsDetailedPages(), { password: 'right' }),
      BYTES,
      hint('cams-kfin-cas'),
      prompt,
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DocumentFailure)
    expect(JSON.stringify(error)).not.toMatch(/hunter2/)
    expect((error as Error).message).not.toMatch(/hunter2/)
  })
})

describe('scanned files', () => {
  it('refuses a page with no text and image operators', async () => {
    const pdf = await fakePdfSource(scannedPages(), { hasImages: true }).open(BYTES, '')
    await expect(assertNotScanned(pdf)).rejects.toMatchObject({ code: 'E_SCANNED_PDF' })
  })

  it('accepts a sparse page that has no image operators', async () => {
    const pdf = await fakePdfSource(scannedPages(), { hasImages: false }).open(BYTES, '')
    await expect(assertNotScanned(pdf)).resolves.toBeUndefined()
  })

  it('does not even ask the expensive question for a full page of text', async () => {
    const pdf = await fakePdfSource(camsDetailedPages(), { hasImages: true }).open(BYTES, '')
    await expect(assertNotScanned(pdf)).resolves.toBeUndefined()
  })
})
