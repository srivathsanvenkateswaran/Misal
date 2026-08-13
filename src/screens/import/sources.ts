/**
 * What the user is asked before a file is chosen.
 *
 * The format cannot be detected before decryption, so the screen has to ask which family the file
 * belongs to — and asking is not a cost, because the request instructions differ per family and
 * they decide the quality of everything downstream.
 *
 * **The two CAS families do not share a password rule.** The CAMS/KFintech mutual fund statement
 * is opened with a password the user chose on the request form; the NSDL and CDSL depository
 * statements are opened with the first holder's PAN in capitals. The widely repeated claim that
 * "CAS PDFs are encrypted with the investor's PAN" is true only of the second kind, and prompting
 * a CAMS user for their PAN would make the application look like it is asking for something it has
 * no business with.
 */

import { PASSWORD_HINTS, type PasswordHint } from '@ingestion/pdf/source'

export type SourceFamilyId = 'cams-kfin-cas' | 'nsdl-ecas' | 'cdsl-ecas' | 'csv'

export interface SourceFamily {
  readonly id: SourceFamilyId
  readonly label: string
  readonly summary: string
  /** Absent for CSV, which is never encrypted. */
  readonly passwordHint?: PasswordHint
  /** How to ask for the file so that it can support a cost basis. Load-bearing, not decoration. */
  readonly instructions: readonly string[]
  /** What Misal can compute from this source once it is in. Stated before the import, not after. */
  readonly capability: string
}

const CAMS_HINT = PASSWORD_HINTS['cams-kfin-cas']
const NSDL_HINT = PASSWORD_HINTS['nsdl-ecas']
const CDSL_HINT = PASSWORD_HINTS['cdsl-ecas']

export const SOURCE_FAMILIES: readonly SourceFamily[] = [
  {
    id: 'cams-kfin-cas',
    label: 'CAMS / KFintech mutual fund CAS',
    summary: 'Every mutual fund folio held in statement-of-account form, from all AMCs.',
    ...(CAMS_HINT === undefined ? {} : { passwordHint: CAMS_HINT }),
    instructions: [
      'Request it as Detailed (Includes transaction listing) — not Summary.',
      'Choose Specific Period and set the FROM DATE to 01-01-1990.',
      'Choose With Zero balance folios.',
      'The password is the one you typed on the request form, not your PAN.',
    ],
    capability:
      'Requested that way, this is the only Indian statement that carries a complete transaction ' +
      'history, which is what cost basis and XIRR need. Requested for this financial year it is a ' +
      'snapshot, and Misal will say so rather than compute a return it cannot stand behind.',
  },
  {
    id: 'nsdl-ecas',
    label: 'NSDL consolidated account statement',
    summary: 'Demat holdings plus the mutual fund folios the registrars feed to NSDL.',
    ...(NSDL_HINT === undefined ? {} : { passwordHint: NSDL_HINT }),
    instructions: [
      'The monthly statement emailed by NSDL, as received.',
      'The password is the PAN of the first account holder, in capitals.',
      'If that is refused, add the first holder’s date of birth below and Misal will try the ' +
        'PAN + DDMMYYYY form once.',
    ],
    capability:
      'Each file covers one month, so it is a holdings snapshot with a month of transactions ' +
      'attached. Those transactions are imported, but they cannot make a cost basis on their own.',
  },
  {
    id: 'cdsl-ecas',
    label: 'CDSL consolidated account statement',
    summary: 'The CDSL equivalent. Which depository issues yours is not something you choose.',
    ...(CDSL_HINT === undefined ? {} : { passwordHint: CDSL_HINT }),
    instructions: [
      'The monthly statement emailed by CDSL, as received.',
      'The password is the PAN of the first account holder, in capitals.',
    ],
    capability:
      'Each file covers one month, so it is a holdings snapshot with a month of transactions ' +
      'attached. Those transactions are imported, but they cannot make a cost basis on their own.',
  },
  {
    id: 'csv',
    label: 'Broker or exchange CSV',
    summary: 'A tradebook or account statement exported as CSV.',
    instructions: [
      'Export the full period the broker offers, not the current year.',
      'CSV exports are not encrypted, so nothing is asked for here.',
    ],
    capability:
      'A tradebook is a ledger and supports cost basis. A holdings export is a snapshot. Misal ' +
      'reads which it is from the file rather than asking.',
  },
]

export function sourceFamily(id: SourceFamilyId): SourceFamily {
  const found = SOURCE_FAMILIES.find((family) => family.id === id)
  if (found === undefined) throw new Error(`unknown source family ${id}`)
  return found
}
