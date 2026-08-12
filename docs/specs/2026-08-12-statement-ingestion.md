# Subsystem B — Statement ingestion

**Status:** draft
**Date:** 2026-08-12
**Depends on:** [Subsystem A — core schema and storage](2026-08-12-core-schema-storage.md),
[v1 design](2026-08-12-misal-v1-design.md)
**Blocks:** Subsystem D (valuation engine) in practice — D has nothing to value until B has run

This subsystem turns a file the user drags onto the window into rows in `txn`, `position`,
`account`, `source_document`, `import_run` and `import_issue`. It covers the four Indian
consolidated account statement formats and a declarative framework for broker and exchange CSV
exports.

The core schema is a fixed contract. Where this subsystem needs something the schema does not
carry, it is recorded in [Open questions for core](#open-questions-for-core) rather than invented.

Two claims frame everything below, and both come from research rather than assumption:

1. **There is no single "CAS".** There are two unrelated document families that share a name. The
   CAMS/KFintech *mutual fund* CAS and the NSDL/CDSL *depository* eCAS have different issuers,
   different passwords, different layouts, different asset coverage and — decisively — different
   answers to "does this file contain enough history to compute a cost basis?"
2. **Only one of the four yields `capability = 'ledger'`.** The CAMS/KFintech CAS requested in
   *Detailed* mode from 01-01-1990 is the only Indian statement that carries a complete, from-
   inception transaction ledger. Everything else is a snapshot, or a one-month ledger fragment that
   is operationally a snapshot. Getting this wrong shows XIRR on data that cannot support it, which
   the v1 design forbids.

## Non-negotiables

1. **One bad row never fails an import.** Row-level failures become `import_issue` rows; the run
   still reaches `status = 'completed'` with a non-zero `rows_failed`.
2. **A row that fails is re-runnable.** `import_issue.raw_payload` carries enough JSON to replay
   that single row through normalize → resolve → reconcile → commit without re-reading the file.
3. **Nothing is guessed.** An instrument that does not resolve goes to `unresolved_instrument` with
   its observed value, so the UI can state the exact rupee amount withheld. A new `instrument` row
   is never created from a statement.
4. **No `Number` touches a quantity, price or amount.** Money is `bigint` minor units; quantities,
   prices and rates are `Decimal`. The Subsystem A lint rule applies here with no exemptions,
   including fixtures.
5. **No real statement, and no PDF password, ever enters the repository or a log line.** Passwords
   live in memory for the duration of one decrypt call.
6. **Raw document bytes are never persisted.** Consistent with Subsystem A: Misal records the hash
   and the metadata, not the contents.

## The pipeline

```
acquire → extract → normalize → resolve → reconcile → commit
```

| Stage | Responsibility | Provider-specific? | Failure granularity |
|---|---|---|---|
| acquire | Read bytes, hash, decrypt, extract text or CSV rows, detect format | No | Document |
| extract | Turn decoded input into `RawRecord`s in the provider's own vocabulary | **Yes** | Row |
| normalize | Canonical types: minor units, decimal strings, instants, txn types | No | Row |
| resolve | Attach `instrument_id` and `account_id`; queue misses | No | Row |
| reconcile | Compute `natural_key`, drop in-database and in-document duplicates | No | Row |
| commit | One SQLite transaction writing every table named below | No | Document |

`extract` is the only plugin boundary. A contributor adding a broker implements one function that
receives already-decrypted, already-parsed input and emits raw records; they inherit decryption,
layout reconstruction, numeric canonicalisation, instrument resolution, deduplication, error
collection and the import report for free.

For CSV sources even that function is not written by hand. A single generic plugin interprets a
declarative descriptor, so **adding a broker CSV is a data change, not a code change**. See
[The CSV mapping framework](#the-csv-mapping-framework).

## Stage data shapes

All numeric fields are strings at every stage before `commit`. This is the same rule Subsystem A
applies at the IPC boundary and for the same reason: a JSON number is a double.

### Acquire

```ts
type SourceKind = 'cas-pdf' | 'csv';

interface AcquiredSource {
  readonly contentHash: string;        // sha256 of raw bytes, lowercase hex
  readonly originalName: string;
  readonly byteLength: number;
  readonly kind: SourceKind;
}

/** What a plugin actually receives. Decryption and low-level parsing already happened. */
type DecodedInput =
  | { readonly kind: 'pdf-text'; readonly pages: readonly PdfPage[]; readonly meta: PdfMeta }
  | { readonly kind: 'csv-rows'; readonly rows: readonly (readonly string[])[];
      readonly meta: CsvMeta };

interface PdfPage {
  readonly pageNumber: number;         // 1-based
  readonly width: number;              // points
  readonly height: number;
  readonly rotation: number;           // degrees, 0 | 90 | 180 | 270
  readonly items: readonly TextItem[];
  /** Rows reconstructed by the shared layout engine; see §Layout reconstruction. */
  readonly lines: readonly TextLine[];
}

interface TextItem {
  readonly text: string;
  readonly x: number;                  // left edge, PDF user space, origin bottom-left
  readonly y: number;                  // baseline
  readonly width: number;
  readonly height: number;
  readonly fontName: string;
}

interface TextLine {
  readonly y: number;
  readonly cells: readonly TextItem[]; // sorted by x, whitespace fillers removed
  readonly text: string;               // cells joined by single spaces
}

interface PdfMeta {
  readonly pageCount: number;
  readonly info: Readonly<Record<string, string>>;   // /Title, /Author, /Creator, /Keywords
  readonly encrypted: boolean;
  readonly hasTextLayer: boolean;
}

interface CsvMeta {
  readonly delimiter: string;
  readonly headerRowIndex: number;     // index into rows, -1 when headerless
  readonly headers: readonly string[];
}
```

### Extract

The plugin's entire output vocabulary. Every field is a string exactly as it appeared in the
source, with no interpretation beyond splitting it out of its cell.

```ts
type RawRecord = RawAccount | RawTransaction | RawPosition;

interface RawRef {
  /** Human-locatable origin, written to import_issue.row_ref. 'p.7 r.12', 'row 341'. */
  readonly ref: string;
  /** Verbatim JSON of the source row, written to import_issue.raw_payload for re-run. */
  readonly raw: Readonly<Record<string, string>>;
}

/** A logical account discovered inside the document. One file may declare many. */
interface RawAccount extends RawRef {
  readonly type: 'account';
  /** Stable, realm-qualified identity. See §Account identity. */
  readonly accountKey: string;         // 'mf-folio:hdfc-mutual-fund:12345678/0'
  readonly label: string;              // 'HDFC Mutual Fund · 12345678/0'
  readonly externalRef: string;        // '12345678 / 0'
  readonly capability: 'ledger' | 'snapshot';
  readonly baseCurrency: string;       // ISO-4217
}

interface RawInstrumentRef {
  readonly isin?: string;
  readonly amfiCode?: string;
  readonly exchange?: 'NSE' | 'BSE' | 'NASDAQ' | 'NYSE';
  readonly symbol?: string;
  readonly providerLocalId?: string;   // RTA scheme code, broker scrip code
  readonly name: string;               // always present; feeds unresolved_instrument.raw_name
  readonly assetClassHint?: string;
}

interface RawTransaction extends RawRef {
  readonly type: 'transaction';
  readonly accountKey: string;
  readonly instrument: RawInstrumentRef;
  /** The source's own words. Classification happens in normalize, not here. */
  readonly description: string;
  /** Optional pre-classification when the source has an unambiguous type column. */
  readonly txnType?: TxnType;
  readonly date: string;               // as printed: '15-Nov-2021', '2021-11-15'
  readonly dateFormat: string;         // Luxon format token string, e.g. 'dd-MMM-yyyy'
  readonly timezone: string;           // IANA, e.g. 'Asia/Kolkata'
  readonly quantity?: string;          // signed, as printed
  readonly price?: string;
  readonly amount?: string;
  readonly fees?: string;
  readonly currency: string;
  readonly fxRate?: string;            // only when the document states it
  /** Running balance printed by the source, used for the checksum. Never stored. */
  readonly balanceAfter?: string;
}

interface RawPosition extends RawRef {
  readonly type: 'position';
  readonly accountKey: string;
  readonly instrument: RawInstrumentRef;
  readonly quantity: string;
  readonly asOf: string;
  readonly dateFormat: string;
  readonly timezone: string;
  readonly marketValue?: string;       // feeds unresolved_instrument.observed_value_minor
  readonly currency: string;
}

type TxnType =
  | 'buy' | 'sell' | 'dividend' | 'split' | 'bonus'
  | 'transfer_in' | 'transfer_out' | 'fee' | 'interest' | 'tds';
```

### Normalize, resolve, reconcile

```ts
interface NormalizedTransaction {
  readonly accountKey: string;
  readonly instrument: RawInstrumentRef;
  readonly txnType: TxnType;
  readonly occurredAt: string;         // ISO-8601 with explicit offset: '2021-11-15T00:00:00+05:30'
  readonly occurredDate: string;       // local calendar date 'YYYY-MM-DD' — the natural-key input
  readonly occurredTz: string;
  readonly quantity: DecimalString;    // canonical, source scale preserved
  readonly price?: DecimalString;
  readonly amountMinor?: bigint;
  readonly feesMinor: bigint;
  readonly currency: string;
  readonly fxRate?: DecimalString;
  readonly origin: RawRef;
}

/** A decimal string plus the scale the source printed, because decimal.js discards it. */
interface DecimalString {
  readonly value: string;              // '12.3450' — stored verbatim
  readonly scale: number;              // 4
}

interface ResolvedTransaction extends NormalizedTransaction {
  readonly accountId: string;
  readonly instrumentId: string;
}

interface ReconciledTransaction extends ResolvedTransaction {
  readonly naturalKey: string;
  readonly disposition: 'insert' | 'duplicate-in-db' | 'duplicate-in-document';
}
```

`DecimalString` exists because of a measured library fact: `new Decimal('12.3450').toString()`
returns `'12.345'`, and `.dp()` returns 3. No JavaScript decimal library preserves scale, but
Subsystem A requires trailing zeros to survive because they carry significance in fund statements.
Carrying the scale alongside the value is the only way to satisfy both. Storage writes `value`;
arithmetic goes through `Decimal`; display uses `toFixed(scale)`.

## The extract plugin contract

This is the whole surface a contributor implements.

```ts
interface ExtractPlugin {
  readonly id: string;                 // 'cams-kfin-cas', 'nsdl-ecas', 'csv-descriptor'
  readonly providerId: string;         // FK into provider(id)
  readonly accepts: SourceKind;

  /** Confidence in [0,1] that this plugin owns the input. >0.8 wins; ties are an error. */
  detect(input: DecodedInput): number;

  /** Emit raw records. Must not throw for row-level problems — call sink.issue instead. */
  extract(input: DecodedInput, sink: RecordSink): void | Promise<void>;
}

interface RecordSink {
  account(record: RawAccount): void;
  transaction(record: RawTransaction): void;
  position(record: RawPosition): void;
  issue(issue: RawIssue): void;
}

interface RawIssue {
  readonly severity: 'error' | 'warning';
  readonly code: string;               // from the taxonomy in §Error handling
  readonly message: string;
  readonly ref?: string;
  readonly raw?: Readonly<Record<string, string>>;
}
```

Four deliberate exclusions, each of which would otherwise be reimplemented per provider:

- **No file handle, no password, no I/O.** The plugin sees decoded input. It cannot leak a password
  it never receives.
- **No database access.** It cannot look up an instrument, so it cannot guess one.
- **No `natural_key`, no `content_hash`, no ids.** Idempotency is not a plugin concern.
- **No date, money or decimal parsing.** The plugin reports the string and the format token; the
  shared normalizer does the conversion and owns the error message.

A plugin that throws is a bug, but not a fatal one: the runner catches, records a
`E_PLUGIN_CRASH` issue against the document, and commits whatever was emitted before the throw.

## CAS PDF parsing

### The two document families

| | **MF CAS** | **Depository eCAS** |
|---|---|---|
| Issuer | CAMS, KFintech, FTAMIL (jointly) | NSDL or CDSL |
| Provider ids | `cams-kfin-cas` | `nsdl-ecas`, `cdsl-ecas` |
| Password | **User-chosen at request time** | **PAN of first holder, uppercase** |
| Covers | MF units held in SoA (folio) form, all AMCs | Demat holdings + MF folios via RTA feed |
| Period | Any range; can be from-inception | One month (or half-yearly, holdings only) |
| Transactions | Complete, from inception if requested | One month only |
| Capability | `ledger` (Detailed) / `snapshot` (Summary) | `snapshot` |

The password difference alone justifies keeping them apart in the UI. Prompting a CAMS user for
their PAN is wrong and will make them think the app is asking for something it shouldn't.

Note that the widely repeated claim "CAS PDFs are encrypted with the investor's PAN" — it appears
in the docstring of the reference Python implementation — is **true only for the depository eCAS**.
The CAMS/KFintech request form has explicit `PASSWORD` and `CONFIRM PASSWORD` fields and the
delivery email says to use the password submitted with the request. KFintech enforces a minimum of
8 characters with mixed case, a digit and a symbol.

### Acquiring: what the UI must tell the user

Ingestion quality is decided before the file exists, so the import screen carries request
instructions per provider. For CAMS/KFintech these are load-bearing, not decoration:

- Statement type **Detailed (Includes transaction listing)**, not Summary.
- Period **Specific Period**, FROM DATE **01-01-1990** (the form's own placeholder text).
- Folio listing **With Zero balance folios**.

A statement requested for the current financial year has non-zero opening balances and therefore
cannot produce a cost basis. Misal detects this (see [Capability](#capability-assignment)) and says
so rather than silently computing a wrong XIRR.

### Password handling

```ts
type PasswordPrompt = (attempt: number, hint: PasswordHint) => Promise<string | null>;

interface PasswordHint {
  readonly providerId: string;
  readonly style: 'user-chosen' | 'pan-uppercase';
  readonly message: string;
}
```

Rules:

1. Try the empty password first. Some depository files and most re-prints are unencrypted.
2. On `NEED_PASSWORD`, prompt with the provider-appropriate copy. For `cams-kfin-cas`: "the
   password you chose when you requested the statement". For `nsdl-ecas` / `cdsl-ecas`: "the PAN of
   the first account holder, in capitals".
3. For depository files, if the uppercase-PAN attempt fails, retry once with
   `PAN + DDMMYYYY` before reporting failure. The PAN-only rule is what both depositories'
   published FAQs state, but the PAN+DOB variant is repeated widely enough that a single silent
   retry is cheaper than a support thread. Log which form succeeded — never the value.
4. Three prompt rounds, then abort with `E_PASSWORD_INCORRECT`.
5. **No `source_document` row is written for a document that never decrypted.** Writing one would
   burn the `content_hash` uniqueness and permanently block re-importing the same file with the
   right password. `source_document` is inserted in the commit transaction, not at acquire.
6. Passwords are never persisted, never written to `import_issue.raw_payload`, never logged. They
   are function arguments and nothing else. The PAN+DOB helper composes the candidate in memory
   from fields the user types into a form that does not save.

Failure modes and what the user sees:

| Condition | Code | Message |
|---|---|---|
| Encrypted, no password given | `E_PASSWORD_REQUIRED` | "This statement is password protected." |
| Wrong password after 3 tries | `E_PASSWORD_INCORRECT` | Provider-specific hint, restated |
| Unsupported cipher | `E_PDF_CIPHER` | "Unsupported PDF encryption." Should not occur |
| No text layer | `E_SCANNED_PDF` | "This looks like a scan or a photo." |
| Text layer, no known format | `E_UNKNOWN_FORMAT` | "Not a statement Misal recognises." |

### Scanned files

CAS PDFs are always text-based, so a scan means the user has photographed or re-printed something.
Detection is two-stage because the reliable test is expensive:

1. Cheap: count non-whitespace characters across all pages. Below roughly 50 per page, suspect.
2. Confirming: request the page operator list and look for image-painting operators.

On confirmation, fail the document with `E_SCANNED_PDF`. **OCR is out of scope** — see
[Out of scope](#out-of-scope). The message must offer the two real remedies: request a fresh
statement from the RTA, or import the broker's CSV instead.

NSDL eCAS files are digitally signed. Misal reads them and never rewrites them; any tooling that
re-saves a signed PDF invalidates the signature, and a user who later needs to prove provenance
would be holding a broken document.

### Text extraction and layout reconstruction

Text extraction produces items in content-stream order, not reading order, and carries no notion of
a table. A shared layout engine — used by every PDF plugin, owned by this subsystem, not by any
plugin — turns items into `TextLine`s:

1. **Drop rotated text.** Watermarks are drawn vertically down the page edge and bleed fragments
   like `CAMS L` and `KFINTECH 4.` into scheme names and registrar fields. Reject any item whose
   transform matrix satisfies `|b| > |a|`.
2. **Drop zero-height whitespace fillers**, but keep their `width` — the inter-item gap is the best
   available column-boundary signal.
3. **Bucket by baseline** with a tolerance of about half the font height, then sort by `x`.
4. **De-duplicate overlaid glyphs.** Both families draw some columns twice at a sub-point offset;
   naive extraction yields `22002200` for `2020`, which parses as the year 2200. Collapse items
   with identical text within 1pt of each other.
5. **Repair character-level interleave.** CDSL interleaves a Devanagari translation into every
   header cell character by character, and bold rendering doubles glyphs
   (`TTrraannssaaccttiioonn`). **Never match CDSL headers by string equality.** Match on
   ASCII-token subsets after de-doubling, or fall back to fixed column bands.
6. **Normalise text.** Strip U+00AD soft hyphens (inserted mid-ISIN at wrap points), map U+2010–
   U+2014 and U+2212 to ASCII `-`, and map the backtick that both depositories emit for `₹`.
7. **Column assignment.** Seed column x-bands from the header row, then assign cells by band. For
   right-aligned numeric columns use a narrow right-anchored zone, because left-aligned description
   text bleeds into the amount column's nominal midpoint.

Two structural rules apply to both families and are the source of most parser bugs:

- **Section context carries across page breaks.** A scheme header, a folio header or an
  `ISIN : ...` anchor is printed once; the rows that follow it continue onto subsequent pages under
  a repeated *column* header with no repeated *section* header. The parser holds the current
  context and resets it only on an explicit new section, never on a page boundary.
- **Repeated page furniture is stripped before parsing.** Running headers, the NSDL navigation
  strip, `Page n of m`, and the CAMS generator footer are removed by matching them against the
  first page's furniture.

### Format detection

`detect` runs against the first two pages plus PDF metadata. Metadata is checked first because it
is unambiguous and survives layout changes.

- **`cams-kfin-cas`, CAMS-generated.** No useful metadata. Footer contains `CAMSCASWS`.
- **`cams-kfin-cas`, KFintech-generated.** Footer contains `KFINCASWS`, or legacy `KARVYCASWS`.
- **`nsdl-ecas`.** Metadata `/Title: NSDL-Consolidated Account Statement` and
  `/Creator: NSDL-CAS Team`. Text `National Securities Depository Limited`, `About NSDL`.
- **`cdsl-ecas`.** Metadata `/Title: Central Depository Services (India) Ltd`. Text
  `Central Depository Services (India) Limited` and the page-1 banner
  `CONSOLIDATED ACCOUNT STATEMENT (CAS) FOR SECURITIES HELD IN DEMAT`.

The generator footer is the *issuing* RTA and is distinct from each scheme's `Registrar :` value —
a CAMS-generated statement routinely contains KFintech-serviced folios. Only the footer decides
which sub-parser runs.

Within the MF CAS, Detailed versus Summary is decided by the title: `Consolidated Account
Statement` versus `Consolidated Account Summary`. Some templates prefix `Detailed` or `Summary`, so
match case-insensitively on `consolidated\s+account\s+(statement|summary)` and read the captured
word.

Two documents must be detected and **rejected with a specific message**, because silently
half-parsing them is worse than refusing:

- **The DP transaction statement.** Titled `TRANSACTION STATEMENT`, issued by the depository
  participant rather than the depository, terminated by `~~~End of Statement~~~` rather than
  `***End of Statement***`, and carrying two settlement-ID columns the CAS does not have. Code
  `E_DP_STATEMENT`.
- **The MF Central statement.** A different template with sections `SUMMARY OF HOLDINGS AS ON`,
  `TRANSACTION DETAILS`, `LOAD STRUCTURES`, and no running unit balance. Code
  `E_MFCENTRAL_UNSUPPORTED`.

### CAMS/KFintech MF CAS — Detailed

Document nesting, in the order it appears:

```
header block ─ investor name, address, contacts, period '01-Apr-1990 To 27-Aug-2024'
PORTFOLIO SUMMARY ─ AMC | cost | market, ending in Total
  AMC line          'HDFC Mutual Fund'
    folio line      'Folio No: 12345678 / 0 PAN: ABCDE1234F KYC: OK  PAN: OK'
      scheme line   '<code>-<name> - ISIN: <isin>(Advisor: ...) Registrar : CAMS'
        Opening Unit Balance: ...
        transaction rows
        Closing Unit Balance: ...  NAV on <d>: INR ...
          Total Cost Value: ...  Market Value on <d>: INR ...      [one physical line]
        load/exit-load trailer paragraph
```

**Scheme line.** The leading token is the **RTA's internal scheme code**, not the ISIN — `B92`,
`D767`, `128TSDGG`, `PP001ZG`, sometimes containing a space. The ISIN appears later as a labelled
suffix (`- ISIN: INF209K01BR9`, spacing varies) and may be absent or split across a line wrap.
**The AMFI scheme code is never printed** — only the ISIN — which is why AMFI-code resolution
depends on the AMFI NAV file rather than the statement.

Fields to capture per scheme: `rtaCode`, `name`, `isin`, `advisor`, `registrar`. The registrar
label is literally `Registrar :` with a space before the colon and its value frequently wraps onto
the next line. Annotations `(Demat)`, `(Non-Demat)`, `(formerly ...)`, `(erstwhile ...)` are
excised from the name, not truncated at.

**Transaction table.** Columns, in visual order:

`Date` | `Transaction` | `Amount (INR)` | `Units` | `NAV` or `Price (INR)` | `Unit Balance`

The header spans two physical lines and the fifth column is labelled `NAV` in older templates and
`Price` in current ones; accept both. Detect the header by counting hits from the label set
`{Date, Transaction, Amount, Units, Price, NAV, Unit, Balance}` — four or more on adjacent lines.

**Negatives are parentheses, never a leading minus**, on both amount and units:
`Redemption Of Units (197,513.41) (49.988) 3,949.2317 0.000`. NAV and unit balance are always
unsigned. Digit grouping is **Western** (`1,723,338.01`), unlike the depository statements.

**Transaction classification.** The description column is free text with heavy per-AMC and per-RTA
variation, so classification is ordered rules over the description plus the sign of the units
column, not a lookup table. Order matters:

| # | Units | Description test | Result |
|---|---|---|---|
| 1 | any | dividend rate pattern `@ Rs.<n> per unit` | `dividend`; reinvest also emits a `buy` |
| 2 | none | no amount either | event row — skipped, not an error |
| 3 | none | `stamp` or `stt` | levy — folded into the adjacent trade's fees |
| 4 | none | `tds` | `tds` |
| 5 | > 0 | `gift` | `transfer_in` |
| 6 | > 0 | `switch`, `s t p`, `systematic transfer` | `transfer_in` |
| 7 | > 0 | `sip`, `systematic`, `instal`+`ment`, `sys.`+`invest` | `buy` (SIP) |
| 8 | > 0 | — | `buy` |
| 9 | < 0 | `gift` | `transfer_out` |
| 10 | < 0 | reversal words (see below) | reversal — inverted sign of the original type |
| 11 | < 0 | `switch`, `s t p` | `transfer_out` |
| 12 | < 0 | — | `sell` |

Reversal words, all observed in real statements: `reversal`, `rejection`, `dishonoured`,
`mismatch`, `insufficient balance`, `payment not received`.

Notes on the rules, all of which come from observed strings rather than guesswork:

- The SIP spellings are the main hazard. Real examples include `SIP Purchase`, `Purchase-SIP`,
  `Purchase-SIP (ECS) - Instalment 100/156`, `Systematic Investment (12/60)`,
  `Systematic Purchase (Continuous Offer) Instalment No - 10`, `Sys. Investment (8/1000)` and
  `SIP Insure (13/21)`. Two counter styles coexist: `- Instalment 5/937` (CAMS) and `(5/1000)`
  (KFintech).
- KFintech statements suffer letter-spacing corruption — `S ystematic Investment`,
  `S witch Out`, `R edemption`, `I DCW Reinvestment`. Classification runs against a whitespace-
  collapsed lowercase form of the description with single-letter-plus-space sequences rejoined.
- `S T P In` / `S T P Out` are letter-spaced by the issuer, not by extraction damage. The rule set
  must match `s\s*t\s*p` rather than `stp`.
- Dividend rows are wrapped in `***`, and the IDCW rename means all of `Dividend`, `Div.`, `IDCW`,
  `IDCW Payout`, `IDCW Reinvestment`, `Reinvestment of IDCW` appear across the corpus.
- Rows containing `Folio No:` are not folio headers if they carry a date — gift transactions embed
  a folio number in their description.

**Levies are folded, not emitted.** `*** Stamp Duty ***` appears as its own row with an amount and
no units, immediately after the purchase it belongs to, and **the purchase amount is already net of
it** (`1,999.90 + 0.10 = 2,000.00`). Under s.55 stamp duty forms part of the cost of acquisition,
so it is added to the parent transaction's `fees_minor` and the parent's `amount_minor` is left as
printed. STT on redemptions is likewise folded. TDS is emitted as a separate `tds` transaction
because the user needs it as a distinct cashflow at tax time.

Folding levies is also what keeps idempotency correct: two SIPs in the same folio on the same date
each generate a `*** Stamp Duty ***` row of the same amount with zero units, which under the
schema's natural key would collide and silently discard one. Folding removes the collision
entirely. The residual case is discussed in [Open questions for core](#open-questions-for-core).

**Self-checksums.** The statement validates itself, and this is the single highest-value
correctness mechanism available:

- Per row: `previousBalance + units == printedBalance`, tolerance 0.005 units.
- Per scheme: `openingBalance + Σ units == Closing Unit Balance`, same tolerance.
- Per document: the sum of scheme market values equals the `PORTFOLIO SUMMARY` total.

A mismatch means a dropped row or a sign misparse. It is recorded as a `W_BALANCE_MISMATCH`
warning against the scheme with both figures in the message, and the affected scheme's
transactions are still committed — but the account is downgraded to `capability = 'snapshot'`,
because a ledger that does not reconcile must not drive XIRR.

### CAMS/KFintech MF CAS — Summary

Title `Consolidated Account Summary`, period collapses to `As on <date>`. One row per holding:

`Folio No.` | `ISIN` | `Scheme Name` | `Cost Value` | `Closing Unit Balance` | `NAV Date` | `NAV` |
`Market Value` | `Registrar`

Emits `RawPosition` only, and `capability = 'snapshot'`. Two layout hazards: folio and ISIN glue
together with no separator (`910124242826/0INF846K01859`), so anchor on the fixed 12-character ISIN
shape; and long scheme names wrap into continuation lines containing only the name column.

### NSDL eCAS

Coverage is genuinely cross-depository: an NSDL CAS contains the user's CDSL demat accounts as
well, plus MF folios fed by the RTAs. Which depository issues it is decided by whichever demat
account was opened earlier, with an investor override — so a user cannot be told in advance which
they will receive, and the UI must accept either.

Sections, with the anchor that identifies each:

| Section | Anchor | Emits |
|---|---|---|
| Account roster | `Your Demat Account and Mutual Fund Folios` | `RawAccount`, one per line |
| Portfolio composition | `PORTFOLIO COMPOSITION` | Asset-class hints only |
| NSDL demat holdings | `ISIN / Stock Symbol` header | `RawPosition` |
| CDSL demat holdings, embedded | `Current Bal.` / `Safekeep Bal.` stacked header | `RawPosition` |
| MF folio holdings | `Mutual Fund Folios (F)` | `RawPosition` |
| Demat transactions | `Transactions` + `for the period from` | `RawTransaction` |
| MF folio transactions | `Mutual Funds Transaction Statement for the` | `RawTransaction` |

Column sets differ per section and there are three distinct demat holdings shapes in one document:

- **NSDL equities, 6 columns:** `ISIN / Stock Symbol` | `Company Name` | `Face Value in ₹` |
  `No. of Shares` | `Market Price in ₹` | `Value in ₹`. The ISIN cell carries the exchange symbol
  (`AXISBANK.NSE`) or the literal `NOT LISTED` on its second line — a free `nse`/`bse` alias.
- **NSDL corporate bonds, 7 columns:** adds `Coupon Rate/Frequency`, `Maturity Date`,
  `Face Value Per Bond in ₹`.
- **CDSL block embedded in an NSDL CAS, 7 columns with three stacked sub-balances per cell.**
  Quantity is the **Current Balance**, the first line of the third column; that is the figure for
  which `quantity × price` reproduces the printed value even when units are pledged.

The MF folios section carries 10 columns including `Average Cost Per Units`, `Total Cost` and
`Annualised Return(%)`. Misal ingests units and value; it **does not import the statement's cost or
return figures**, because the valuation engine computes those and two sources of truth for the same
number is how a net-worth tool starts disagreeing with itself.

The demat transaction ledger is 8 columns —
`Date` | `Order No` | `Description` | `Instruction Details` | `Opening Balance` | `Debit` |
`Credit` | `Closing Balance` — grouped under standalone `ISIN : <isin> -` anchor rows. The empty
case prints `NO TRANSACTION RECORDED FOR THE GIVEN PERIOD`.

### CDSL eCAS

A different document, not a variant. Anchors: `CONSOLIDATED ACCOUNT STATEMENT (CAS) FOR SECURITIES
HELD IN DEMAT`, `STATEMENT OF TRANSACTIONS`, `HOLDING STATEMENT AS ON <DD-MM-YYYY>`,
`HOLDING STATEMENT OF BONDS AS ON <DD-MM-YYYY>`, `MUTUAL FUND UNITS HELD AS ON <DD-MM-YYYY>`.

- **Transactions, 9 uniform columns:** `ISIN` | `Security` | `Transaction (Particulars)` | `Date` |
  `Op. Bal` | `Credit` | `Debit` | `Cl. Bal` | `Stamp Duty`. Continuation rows blank the ISIN and
  security cells, so those carry forward.
- **Holdings, 9 columns:** each sub-balance is its own column rather than stacked —
  `Current Bal` | `Frozen Bal` | `Pledge Bal` | `Pledge Setup Bal` | `Free Bal` | `Market Price /
  Face Value` | `Value`. Null cells are `--`, not `0.000`.
- **MF units, 9 columns:** `Scheme Name` | `ISIN` | `Folio No.` | `Closing Bal (Units)` | `NAV` |
  `Cumulative Amount Invested` | `Valuation` | `Unrealised Profit/Loss` | `%`. The AMC name is *not*
  in this table; join back to the `Account Details` / `MF Folios` block by folio number.
- Dates are `DD-MM-YYYY` throughout, where NSDL mixes `DD-Mon-YYYY` and uppercase `DD-MMM-YYYY`
  between sections. Descriptors and format tokens are therefore per-section, not per-document.
- Footnote markers are appended directly to ISIN cells (`!!` unlisted, `##` under liquidation) and
  are defined by the document's own `Note:` legend. Strip only the markers the legend defines —
  stripping `#` blindly destroys the AMC/series separator that is legitimately inside security
  names.

Both depositories use **Indian digit grouping** (`2,55,43,509.28`). A comma strip works; a
locale-aware parse does not.

### Capability assignment

`account.capability` is set by ingestion, never by the user, and it is the flag on which the UI
decides whether XIRR and cost basis may be displayed. The rule:

| Source | Condition | Capability |
|---|---|---|
| CAMS/KFin Detailed | Every `Opening Unit Balance` is zero **and** all checksums pass | `ledger` |
| CAMS/KFin Detailed | Any non-zero opening balance | `snapshot` + `W_INCOMPLETE_HISTORY` |
| CAMS/KFin Detailed | Any scheme checksum fails | `snapshot` + `W_BALANCE_MISMATCH` |
| CAMS/KFin Summary | always | `snapshot` |
| NSDL eCAS | always | `snapshot` |
| CDSL eCAS | always | `snapshot` |

The depository rows deserve their reasoning spelled out, because the naive read of the format is
that it *does* contain transactions and therefore *should* be a ledger.

It does contain transactions — a genuine per-ISIN ledger with opening and closing balances. But
**each file covers exactly one month.** A single eCAS is a one-month ledger fragment bolted to an
end-of-period snapshot. Cost basis and XIRR require history from the account's inception, which
would mean a contiguous run of every monthly statement since the demat account was opened,
with no gaps. Worse, a missing month and a dormant month are indistinguishable without cross-
checking period headers, because half-yearly statements are issued precisely when there were no
transactions.

So: the transactions are ingested, because they are real facts with real provenance and discarding
them would be the silent data loss the design forbids. But the account stays `snapshot`, positions
remain authoritative for it, and the valuation engine must not fold its ledger. **Capability is
therefore also the fold gate**, not merely a display gate. This is a constraint on Subsystem D and
is called out again in [Open questions for core](#open-questions-for-core), because the schema has
no per-transaction marker distinguishing an authoritative ledger row from an informational one.

Capability is monotonic upward per account: a folio that arrives first in a Summary statement and
later in a Detailed one is upgraded to `ledger`. It is never silently downgraded — a downgrade
always writes a warning issue naming the document that caused it.

### Account identity

One CAS PDF declares many accounts, and the same logical account arrives from more than one
document type. An MF folio appears in the CAMS CAS *and* in the MF section of the NSDL eCAS. If
those become two `account` rows, every overlapping transaction gets a different `account_id`,
therefore a different `natural_key`, therefore no deduplication — and the user's net worth doubles.
This is the exact failure the design calls the worst one available.

Accounts are therefore keyed on a **realm-qualified identity string**, not on the document that
introduced them:

| Realm | Key shape | Example |
|---|---|---|
| MF folio | `mf-folio:<amc-slug>:<folio>` | `mf-folio:hdfc-mutual-fund:12345678/0` |
| Demat | `demat:<dp-id>-<client-id>` | `demat:IN300394-12345678` |
| Demat (BO ID only) | `demat:bo:<16-digit-bo-id>` | `demat:bo:1208340012345678` |

Rules:

- Folio numbers are **RTA-scoped, not globally unique**, so the AMC slug is mandatory in the key.
  The sub-account suffix (`/ 0`) is preserved; folios differing only in suffix are different
  accounts.
- The key is stored in `account.external_ref`. Resolution looks up by `external_ref` **regardless
  of `provider_id`**; the provider recorded is whichever document created the row first.
- CDSL BO IDs are the concatenation of DP ID and client ID and are rendered doubled by bold text
  (`1122008833...`). De-double before use, and prefer the split DP/client form when both are
  available so the two shapes converge on one key.

### Multi-account documents

`source_document.account_id` is a single nullable column, but one CAS names dozens of accounts. The
rule: for a document declaring more than one account, `source_document.account_id` is `NULL` and
the account attribution lives on each `txn` and `position` row, which is where it is actually
needed. `page_ref` is set to the document-wide page span; per-record page references live in
`import_issue.row_ref` and in the raw payload.

## The CSV mapping framework

### Why declarative

The v1 design's whole bet is that a stranger can add a broker without breaking anyone's numbers.
Procedural parsing code makes that a code review of arbitrary logic with database access. A
descriptor makes it a data review against a schema, testable purely from a fixture, with no way to
express "guess this instrument" or "round this number".

A single `csv-descriptor` plugin implements `ExtractPlugin` and interprets descriptors. Adding a
broker is: drop a `.yaml` file into `providers/`, drop a redacted fixture and expected JSON into
`fixtures/`, open a PR.

### Descriptor format

YAML, validated with a Zod schema at load time and at build time in CI. Type declaration:

```ts
interface CsvDescriptor {
  readonly descriptorVersion: 1;
  readonly id: string;                       // 'zerodha-console-tradebook'
  readonly providerId: string;
  readonly displayName: string;
  readonly emits: 'transactions' | 'positions';
  readonly capability: 'ledger' | 'snapshot';

  readonly detect: DetectRule;
  readonly file: FileOptions;
  readonly account: AccountRule;
  readonly instrument: InstrumentRule;
  readonly columns: Readonly<Record<string, ColumnRule>>;
  readonly typeRules?: readonly TypeRule[];
  readonly postconditions?: readonly Postcondition[];
}

interface DetectRule {
  /** All header names that must be present (case- and whitespace-insensitive). */
  readonly requiredHeaders: readonly string[];
  /** Optional headers that raise confidence when present. */
  readonly signalHeaders?: readonly string[];
  /** Literal text that must appear somewhere in the preamble rows. */
  readonly preambleContains?: readonly string[];
}

interface FileOptions {
  readonly delimiter: string;                // never auto-detected
  readonly encoding: 'utf-8' | 'utf-16le' | 'windows-1252';
  readonly headerRow: 'auto' | number;       // 'auto' = first row matching requiredHeaders
  readonly skipRowsMatching?: readonly string[];   // anchored regexes, e.g. '^Total'
  readonly timezone: string;                 // IANA
  readonly currency: string | { readonly column: string };
}

interface AccountRule {
  readonly realm: 'demat' | 'mf-folio' | 'broker' | 'exchange';
  /** Template over column names; missing columns fall back to `constant`. */
  readonly keyTemplate?: string;             // 'demat:{dp_id}-{client_id}'
  readonly constant?: string;                // single-account exports
  readonly labelTemplate: string;
}

interface InstrumentRule {
  readonly isin?: string;                    // column name
  readonly amfiCode?: string;
  readonly symbol?: string;
  readonly exchange?: string | { readonly constant: 'NSE' | 'BSE' | 'NASDAQ' | 'NYSE' };
  readonly providerLocalId?: string;
  readonly name: string;                     // required
  readonly assetClassHint?: string | { readonly constant: string };
}

type ColumnRule =
  | { readonly kind: 'date'; readonly column: string; readonly format: string }
  | { readonly kind: 'decimal'; readonly column: string; readonly transform?: NumericTransform }
  | { readonly kind: 'money'; readonly column: string; readonly transform?: NumericTransform }
  | { readonly kind: 'text'; readonly column: string }
  | { readonly kind: 'constant'; readonly value: string }
  | { readonly kind: 'computed'; readonly expr: ComputedExpr };

interface NumericTransform {
  /** Characters stripped before parsing. Default: ',', currency symbols, spaces. */
  readonly strip?: readonly string[];
  /** How the source encodes a negative value. */
  readonly negative?: 'leading-minus' | 'trailing-minus' | 'parentheses' | 'never';
  /** Flip the sign when another column matches. */
  readonly signFrom?: { readonly column: string; readonly negativeWhen: readonly string[] };
  /** Reject rather than round when precision exceeds the target. */
  readonly onExcessPrecision?: 'round-half-up' | 'error';
}

/** Deliberately not an expression language. Four operations, no user-defined functions. */
type ComputedExpr =
  | { readonly op: 'multiply'; readonly left: string; readonly right: string }
  | { readonly op: 'add'; readonly terms: readonly string[] }
  | { readonly op: 'negate'; readonly of: string }
  | { readonly op: 'abs'; readonly of: string };

interface TypeRule {
  readonly when: MatchExpr;
  readonly type: TxnType;
}

type MatchExpr =
  | { readonly column: string; readonly equals: readonly string[]; readonly ignoreCase?: boolean }
  | { readonly column: string; readonly matches: string }        // anchored regex
  | { readonly column: string; readonly sign: 'positive' | 'negative' | 'zero' }
  | { readonly all: readonly MatchExpr[] }
  | { readonly any: readonly MatchExpr[] };

interface Postcondition {
  readonly kind: 'running-balance' | 'row-total' | 'non-empty';
  readonly params: Readonly<Record<string, string>>;
  readonly severity: 'error' | 'warning';
}
```

Three constraints on the format are load-bearing:

- **`ComputedExpr` is four operations, not an expression language.** A descriptor that can run
  arbitrary arithmetic is a code review again. Four operations cover derived amounts and sign
  flips, which is all any real export needs. If a fifth is genuinely required, it is added to the
  union and reviewed once, centrally.
- **Delimiter and encoding are mandatory and never sniffed.** Auto-detection silently corrupts
  files with an embedded semicolon or a lone BOM; an explicit value is one line for the contributor
  and one fewer silent failure class for the user.
- **The schema is strict.** Unknown keys are rejected, because a typo'd key that passes silently
  is a mapping the contributor believes is active and is not.

### Worked example A — Zerodha Console tradebook

An equities ledger with an explicit side column and an ISIN in the file. Column names below are as
observed in the Console export; the fixture is the authority and CI fails if they drift.

```yaml
descriptorVersion: 1
id: zerodha-console-tradebook
providerId: zerodha-console
displayName: Zerodha Console — tradebook
emits: transactions
capability: ledger

detect:
  requiredHeaders: [symbol, isin, trade_date, trade_type, quantity, price]
  signalHeaders: [order_execution_time, exchange, segment, series]

file:
  delimiter: ","
  encoding: utf-8
  headerRow: auto
  timezone: Asia/Kolkata
  currency: INR

account:
  realm: broker
  constant: "broker:zerodha"
  labelTemplate: "Zerodha"

instrument:
  isin: isin
  symbol: symbol
  exchange: exchange
  name: symbol
  assetClassHint: { constant: indian_equity }

columns:
  date:     { kind: date, column: trade_date, format: "yyyy-MM-dd" }
  quantity:
    kind: decimal
    column: quantity
    transform:
      negative: never
      signFrom: { column: trade_type, negativeWhen: [sell] }
  price:    { kind: decimal, column: price }
  amount:   { kind: computed, expr: { op: multiply, left: quantity, right: price } }
  description: { kind: text, column: trade_type }

typeRules:
  - when: { column: trade_type, equals: [buy],  ignoreCase: true }
    type: buy
  - when: { column: trade_type, equals: [sell], ignoreCase: true }
    type: sell

postconditions:
  - kind: non-empty
    params: {}
    severity: error
```

What this exercises: header auto-detection, a single-account export, ISIN present so resolution is
a direct hit, sign taken from a side column rather than from the number, and a computed
consideration. Note what the descriptor does *not* say: nothing about deduplication, nothing about
`instrument_id`, nothing about currency conversion. Those are inherited.

The tradebook carries no brokerage or STT, so `fees_minor` is zero and the ledger's cost basis is
gross of charges. That is a real limitation of the source and is surfaced in the import report as
`W_FEES_ABSENT`, not papered over.

### Worked example B — a contributed broker with a hostile export

Illustrative rather than observed, and deliberately built to exercise every hard feature at once: a
three-line preamble before the header, Indian digit grouping, parenthesised debits, a free-text
narration column instead of a side column, a proprietary scrip code with no ISIN, a separate
charges column, and a `Total` footer row.

```csv
Account Statement
Client: ****1234    Period: 01-Apr-2024 to 31-Mar-2025
Generated on 02-Apr-2025

Txn Date,Narration,Scrip Code,Scrip Name,Qty,Rate,Net Amount,Charges
15-Apr-2024,BUY - DELIVERY,532540,TCS LTD,10,3,850.50,"(38,505.00)",42.30
22-Jul-2024,"SELL - DELIVERY, T+1",532540,TCS LTD,4,4,120.00,"16,480.00",31.15
30-Sep-2024,DIVIDEND CREDIT,532540,TCS LTD,,,"600.00",0.00
Total,,,,,,"(21,425.00)",73.45
```

```yaml
descriptorVersion: 1
id: mybroker-account-statement
providerId: mybroker
displayName: MyBroker — account statement
emits: transactions
capability: ledger

detect:
  requiredHeaders: ["Txn Date", "Narration", "Scrip Code", "Net Amount"]
  preambleContains: ["Account Statement"]

file:
  delimiter: ","
  encoding: windows-1252
  headerRow: auto
  skipRowsMatching: ["^Total$"]
  timezone: Asia/Kolkata
  currency: INR

account:
  realm: broker
  constant: "broker:mybroker"
  labelTemplate: "MyBroker"

instrument:
  providerLocalId: "Scrip Code"
  name: "Scrip Name"
  assetClassHint: { constant: indian_equity }

columns:
  date: { kind: date, column: "Txn Date", format: "dd-MMM-yyyy" }
  quantity:
    kind: decimal
    column: Qty
    transform:
      negative: never
      signFrom: { column: Narration, negativeWhen: ["^SELL"] }
  price:  { kind: decimal, column: Rate, transform: { strip: [","] } }
  amount:
    kind: money
    column: "Net Amount"
    transform:
      strip: [",", "₹"]
      negative: parentheses
      onExcessPrecision: error
  fees:   { kind: money, column: Charges, transform: { strip: [","] } }
  description: { kind: text, column: Narration }

typeRules:
  - when: { all: [ { column: Narration, matches: "^BUY\\b" },
                   { column: Qty, sign: positive } ] }
    type: buy
  - when: { all: [ { column: Narration, matches: "^SELL\\b" },
                   { column: Qty, sign: positive } ] }
    type: sell
  - when: { column: Narration, matches: "DIVIDEND" }
    type: dividend

postconditions:
  - kind: row-total
    params: { amount: amount, quantity: quantity, price: price, fees: fees, tolerance: "0.01" }
    severity: warning
```

Three things this example is designed to demonstrate:

- **The dividend row has no quantity and no price**, so `sign` matching on `Qty` would fail. The
  ordered rules put the dividend match after the two trade matches and test only the narration.
- **`Scrip Code` is a BSE code with no ISIN**, so resolution falls through to a `provider-local`
  alias scoped to `mybroker`. On a fresh database that alias does not exist, so **every row of this
  file lands in `unresolved_instrument`** with `observed_value_minor` populated from the amount.
  The import still completes; the review queue shows one entry for TCS with the exact rupee value
  withheld; resolving it once retroactively releases all three rows. That is the intended
  behaviour, not a degraded one.
- **The `Total` footer** would otherwise parse as a transaction with a null date. `skipRowsMatching`
  removes it; without the rule the row produces one `E_DATE_PARSE` issue and the import still
  commits the other three.

### Descriptor authoring workflow

1. Export a real file. Run `misal fixtures redact <file>` to produce a redacted copy.
2. Write the descriptor. Errors are reported against the YAML source with line and column, by
   joining the validator's issue path to the YAML parser's source ranges.
3. Run `misal fixtures record <descriptor> <fixture>` to emit the expected normalized JSON.
4. Eyeball the JSON. It is the golden file and the actual review artefact — reviewers read the
   diff of expected output, not the descriptor logic.
5. Open a PR with descriptor, fixture and golden file. CI validates the descriptor against the Zod
   schema, replays the fixture, and diffs.

## Normalize

Provider-agnostic and the only place where strings become typed values.

**Dates.** Parsed strictly with the format token the record carries and the zone it names. Strict
means a mismatched format fails rather than being reinterpreted: `1-Jan-2024` against
`dd-MMM-yyyy` is an error, `31-Feb-2024` is an error. Month names are parsed with an explicit `en`
locale so a non-English system locale does not break `Jan`.

**Date-only sources produce an instant at local midnight with the offset preserved** —
`2024-01-01T00:00:00+05:30` — and `occurred_tz = 'Asia/Kolkata'`. This matters more than it looks:
converting to a UTC wall-clock string first gives `2023-12-31T18:30:00Z`, and every downstream
date-only operation then reports the trade a day early. Financial-year boundaries and the
31-Jan-2018 grandfathering date both sit on exactly this fault line.

**The natural key uses the local calendar date, not the UTC date.** `NormalizedTransaction`
carries `occurredDate` for this purpose. A key computed from the UTC instant would shift by a day
for every IST midnight and break deduplication across two statements of the same trade.

**Money.** Decimal string to minor units by shifting the decimal point with string operations
against the currency's static exponent. Never a float multiply, never `Math.round`. If the source
has more fractional digits than the exponent and they are not all zeros, apply the descriptor's
`onExcessPrecision`: `error` fails the row, `round-half-up` rounds and emits `W_AMOUNT_ROUNDED`
carrying the original string. The default for statement plugins is `error`.

**Quantities and prices.** Kept as `DecimalString` with the source scale. Canonicalisation strips
grouping separators and currency glyphs, normalises Unicode minus signs, and rejects anything the
Subsystem A rules forbid: exponent notation, more than one `.`, embedded whitespace. The decimal
library accepts `1_000` and `0x1f` as valid input, so **input is validated against an explicit
decimal-string regex before it is handed to the library**, never after.

**FX.** `fx_rate` is populated only when the source document states a rate. Otherwise it is left
`NULL` and the valuation engine resolves it from the `fx_rate` table. Ingestion does not fetch.

## Resolve

Two resolutions happen here: account and instrument.

**Account.** Look up `account.external_ref` equal to the record's `accountKey`, ignoring
`provider_id`. Create on miss with the capability the source declared. On hit, apply the monotonic
capability rule from [Capability assignment](#capability-assignment).

**Instrument.** The schema's resolution order, in order, stopping at the first hit:

1. **ISIN** — `instrument.isin`, then `instrument_alias` with `scheme = 'isin'`.
2. **AMFI scheme code** — `instrument_alias` with `scheme = 'amfi'`.
3. **Exchange + symbol** — `instrument_alias` with `scheme = 'nse'` or `'bse'`, matched on the
   exchange the record names. A symbol without an exchange never matches; that is the whole point
   of the alias table's composite key.
4. **Provider-local** — `instrument_alias` with `scheme = 'provider-local'` and
   `provider_id` equal to the record's provider. This is what keeps E*TRADE's `INFY` from
   colliding with the NSE line.

**A miss creates an `unresolved_instrument` row and never anything else.** Not a new `instrument`,
not a fuzzy name match, not a "probably this" with a confidence score. The MF CAS never prints an
AMFI code, so mutual funds resolve on ISIN or not at all in v1; mapping ISIN to AMFI code from the
AMFI NAV file belongs to Subsystem D's price service, and the instrument catalogue it seeds is what
makes step 2 useful in practice.

`observed_value_minor` is populated from the record's market value where the source prints one, or
from `quantity × price` where it does not. This is what lets the UI say "₹1,24,300 withheld from
totals" rather than "some holdings unresolved", and it is worth the extra work at ingest time
because the alternative is a coverage figure that is itself a guess.

Records whose instrument does not resolve are **not** written to `txn` or `position`. They exist as
`unresolved_instrument` plus an `import_issue` of severity `warning` with code
`W_UNRESOLVED_INSTRUMENT`, and their raw payload is retained so that resolving the instrument later
replays them. Resolution in the review queue writes the alias, sets `resolved_instrument_id`, and
re-runs every retained payload that referenced the same raw identifier.

## Reconcile

Two independent mechanisms, both from Subsystem A.

**Document level — `source_document.content_hash`.** SHA-256 of the raw bytes. A file already
present is reported to the user as "already imported on <date>, no changes made" with a link to the
existing `import_run`. This is not an error and does not create an `import_run`.

The hash is of the **encrypted** bytes as they sit on disk, which means the same statement
re-downloaded with a different password produces a different hash. That is accepted: the natural
key catches the resulting duplicate transactions, so the outcome is a second `source_document` with
zero committed rows and a full `rows_duplicate` count. Visible and harmless.

**Row level — `txn.natural_key`.** A deterministic hash over
`account_id | instrument_id | type | occurredDate | quantity.value | amountMinor`, with a fixed
field separator and a canonical serialisation of each field. Notes:

- `occurredDate` is the **local calendar date**, per the normalize rules above.
- `quantity.value` is the canonical decimal string *including trailing zeros*, so a source printing
  `10.000` and another printing `10` produce different keys. This is a real hazard for the same
  trade arriving from two providers. Mitigation: the key is computed over the quantity trimmed of
  trailing zeros while storage retains them. Scale is significant for display, not for identity.
- `amountMinor` may be `NULL` for splits and bonuses; it serialises as an empty field, not as `0`.

Three dispositions:

| Disposition | Meaning | Counted as |
|---|---|---|
| `insert` | Key not seen | `rows_committed` |
| `duplicate-in-db` | Key exists in `txn` | `rows_duplicate` |
| `duplicate-in-document` | Key seen earlier in this run | `rows_duplicate`, plus a warning |

`duplicate-in-document` gets a warning where `duplicate-in-db` gets none, because two identical
rows in one file are more likely to be two genuinely distinct events that the natural key cannot
distinguish than a re-import. See [Open questions for core](#open-questions-for-core).

**Positions** reconcile on the schema's `UNIQUE (account_id, instrument_id, as_of)`. A re-import of
the same statement is a no-op; a corrected statement for the same date is an update, because a
position is a restatement of a fact rather than an event. Updates write a `W_POSITION_RESTATED`
warning naming both source documents so the change is visible rather than silent.

## Commit

One SQLite transaction per document, owned by the Subsystem A repository layer.

Order: `source_document` → `account` (insert or update) → `instrument_alias` (only for aliases the
source proves, such as an ISIN and exchange symbol printed on the same row of a resolved
instrument) → `txn` → `position` → `unresolved_instrument` → `import_run` → `import_issue`.

`import_run.status` outcomes:

| Outcome | status | Meaning |
|---|---|---|
| Everything parsed | `completed` | `rows_failed = 0` |
| Some rows failed | `completed` | `rows_failed > 0`. **A first-class outcome, not an error** |
| Document-level failure | `failed` | No password, scanned, unknown format, plugin crash |

A `failed` run with no `source_document` is impossible under the schema's `NOT NULL` foreign key,
which is precisely why document-level failures that occur before decryption **do not create an
`import_run` at all** — they are returned to the UI as a typed error and shown on the import
screen. Only failures discovered after a successful decode create a run.

The `import_run` counters are the import report. They must reconcile:
`rows_read = rows_committed + rows_duplicate + rows_failed + rows_skipped`, where skipped rows are
the non-financial event rows the MF CAS is full of. `rows_skipped` has no column in the schema; see
[Open questions for core](#open-questions-for-core).

## Error handling

### Codes

Prefix `E_` for errors, `W_` for warnings. Warnings never fail a row; errors fail exactly one row,
except the document-level codes which fail the document.

**Document level**

| Code | Cause |
|---|---|
| `E_PASSWORD_REQUIRED` | Encrypted, no password supplied |
| `E_PASSWORD_INCORRECT` | Three failed attempts |
| `E_PDF_CIPHER` | Encryption handler not supported |
| `E_SCANNED_PDF` | No text layer; image operators present |
| `E_UNKNOWN_FORMAT` | No plugin returned confidence above threshold |
| `E_AMBIGUOUS_FORMAT` | Two plugins tied above threshold — a corpus bug, must fail loudly |
| `E_DP_STATEMENT` | A DP transaction statement, not a CAS |
| `E_MFCENTRAL_UNSUPPORTED` | MF Central template |
| `E_DESCRIPTOR_INVALID` | Descriptor failed schema validation |
| `E_PLUGIN_CRASH` | Plugin threw; partial output committed |
| `E_HEADER_NOT_FOUND` | CSV header row not located |

**Row level**

| Code | Cause |
|---|---|
| `E_DATE_PARSE` | Date does not match the declared format |
| `E_NUMERIC_PARSE` | Value is not a valid decimal string after canonicalisation |
| `E_AMOUNT_PRECISION` | More fractional digits than the currency exponent, non-zero |
| `E_MISSING_COLUMN` | Descriptor names a column the file does not have |
| `E_MISSING_REQUIRED_FIELD` | No date, or no quantity on a trade |
| `E_UNCLASSIFIED_TRANSACTION` | No type rule matched and no fallback |
| `E_ROW_SHAPE` | Column count differs from the header |

**Warnings**

| Code | Meaning |
|---|---|
| `W_UNRESOLVED_INSTRUMENT` | Queued for review; value withheld from totals |
| `W_BALANCE_MISMATCH` | Scheme or ISIN checksum failed; capability downgraded |
| `W_INCOMPLETE_HISTORY` | Non-zero opening balance; capability downgraded |
| `W_AMOUNT_ROUNDED` | Excess precision rounded; original in the raw payload |
| `W_DUPLICATE_IN_DOCUMENT` | Identical natural key twice in one file |
| `W_POSITION_RESTATED` | An existing position for the same date was overwritten |
| `W_FEES_ABSENT` | Source carries no charges; cost basis is gross |
| `W_CAPABILITY_DOWNGRADE` | An account moved from `ledger` to `snapshot` |
| `W_UNKNOWN_SECTION` | A recognised document contained a section the parser skipped |

`W_UNKNOWN_SECTION` is the corpus's early-warning system. Both CAS families drift year to year —
`Stamp Duty` appeared after 2020, `Annualised Return(%)` and `Sovereign Gold Bonds` later still. A
parser that silently ignores unrecognised sections looks correct until the year it isn't.

### Re-running a row

`import_issue.raw_payload` holds the JSON the plugin emitted, which is sufficient to re-enter the
pipeline at `normalize`. Re-run is triggered from the import report or automatically when an
instrument is resolved in the review queue. It runs in its own transaction, appends to the existing
`import_run` counters, and marks the issue resolved.

The schema has no column for marking an issue resolved; see
[Open questions for core](#open-questions-for-core). Until then the implementation deletes the
issue row on successful re-run, which loses the audit trail of what was fixed and is the weakest
part of this design.

## Library choices

Chosen after measurement, not from reputation. Each line names the reason and the trap.

**PDF: `pdfjs-dist`, legacy build, Apache-2.0.** It is the only maintained, permissively licensed
JavaScript library that both decrypts and exposes per-item coordinates, and both are mandatory
here. Verified to handle RC4-40, RC4-128, AESV2-128 and AESV3-256 (R5 and R6), which matters
because CDSL files observed in 2024 use AES-256/R6 while NSDL files from 2020 use AES-128.
`PasswordException` with `code` 1 versus 2 cleanly distinguishes "needs a password" from "wrong
password", which the UI needs to word its prompt correctly.

**Use the legacy build, not the modern one.** The modern worker calls `Math.sumPrecise`, which
shipped only in Safari 26.2, so macOS WKWebView — the Tauri default — throws at load on anything
older. The legacy build ships the polyfill. Bundle `cmaps/` and `standard_fonts/` locally and point
`cMapUrl` and `standardFontDataUrl` at them: Indian CAS PDFs rely on non-embedded standard fonts
and produce garbled text without them.

**Rejected:** `unpdf` (bundles the modern build; fails on the same polyfill), `pdf-lib` (cannot
decrypt, unmaintained since 2022), `pdf2json` and `pdf-parse` (Node-only), `@hyzyla/pdfium` (opens
encrypted files but returns flat text with no coordinates, which makes column reconstruction
impossible). **MuPDF is technically the best tool here** — it has real structured-text extraction
with block and line geometry — **and is disqualified by AGPL-3.0.** Distributing a desktop
application is distribution; the licence would propagate to the whole of Misal. The same pressure
pushed the reference Python implementation off GPL/AGPL dependencies. `BeyondIRR/cas2json` is a
useful structural reference for exactly this reason and must not become a dependency.

**CSV: `papaparse`, MIT.** Zero dependencies, browser-native, and `dynamicTyping` defaults to
`false` — verified that `1234.5000` survives as the string `"1234.5000"` and `007` as `"007"`.
Never enable `dynamicTyping`. Set `skipEmptyLines: 'greedy'`, because the default emits a phantom
row for a trailing newline and then reports a `TooFewFields` error about it. PapaParse never
throws; errors land in `result.errors` and must be checked explicitly. `csv-parse` is the
stricter alternative with real browser builds and would be a reasonable swap if RFC-4180
conformance ever matters more than bundle size.

**Decimal: `decimal.js`, MIT**, as fixed by Subsystem A. Three traps, all verified: it discards
trailing zeros (hence `DecimalString`); it accepts `1_000` and `0x1f` as valid input, so validate
with a regex before constructing; and `toString()` switches to exponent notation at 1e21 and below
1e-7, so persistence uses `toFixed(scale)` and the exponent thresholds are pinned globally.
Configure precision and rounding once, in one module.

**Dates: `luxon`, MIT.** The only one of the four candidates that takes the zone as a first-class
parse argument, which this subsystem needs on every single date. It is also the strictest: it
rejects `1-Jan-2024` against `dd-MMM-yyyy` where `date-fns` accepts it, and rejects `31-Feb-2024`
where non-strict `dayjs` silently rolls it to 2 March. Its `invalidExplanation` strings are usable
verbatim as row error messages. `Temporal` reached Stage 4 in ES2026 but WebKit support is partial,
so it is not usable in a Tauri webview yet; revisit when it is.

**Descriptor validation: `zod` v4, MIT**, over `yaml` (eemeli), ISC. Zod's `prettifyError` gives
contributor-readable messages, and `toJSONSchema` emits a JSON Schema from the same source of
truth, so editor autocomplete for descriptor authors is free. `yaml` exposes CST source ranges, so
a Zod issue path maps back to a line and column with a caret. That pairing is the single
highest-leverage thing available for descriptor authoring ergonomics. Use `z.strictObject`
throughout and a discriminated union on `kind`. **`ajv` is rejected**: it compiles validators with
`new Function`, which a strict Tauri CSP forbids.

One YAML trap to document for contributors: both YAML libraries coerce `007` to `7` and
`1234.5000` to `1234.5`. Descriptors contain column names and format tokens rather than values, so
this is mostly theoretical — but any value-bearing field must be quoted, and the loader parses with
the failsafe schema where it can.

## Fixtures and golden files

The corpus is the project's most valuable asset after the schema, and it is also the one most
likely to leak somebody's net worth. Real statements never enter the repository. There is prior art
for how badly this goes: several public repositories contain unredacted CAS text dumps with live
PANs, folio numbers and holdings.

### Three tiers

**Tier 1 — text-layer fixtures. The primary corpus.** A JSON dump of the `PdfPage[]` structure
after extraction and before layout reconstruction: items with text, coordinates, dimensions and
font names. These are produced by a redaction tool from a real statement, run offline on the
contributor's machine, and are what almost every parser test executes against. They need no PDF, no
password and no decryption, so tests are fast and deterministic.

**Tier 2 — synthetic encrypted PDFs.** Generated by a committed fixture generator from a template
plus fake data, encrypted with a known password (`test-password` for the MF family,
`AAAAA0000A` for the depository family). One per encryption handler the corpus must cover. These
exercise the decryption path and the scanned-file detector; there are perhaps a dozen of them and
they never contain real data.

**Tier 3 — CSV fixtures.** Redacted real exports. CSVs are far easier to redact than PDFs because
the structure is explicit.

### Redaction

`misal fixtures redact` is a committed tool, not a manual process, because manual redaction is how
a folio number survives. It replaces, preserving length, character class and check-digit validity
where the format has one:

| Field | Replacement |
|---|---|
| PAN | `AAAAA0000A`, deterministic per distinct input within a file |
| Aadhaar | `000000000000` |
| Names, addresses, email, phone | Fixed synthetic values from a small pool |
| Folio numbers | Sequential synthetic, consistently remapped across the file |
| DP ID, client ID, BO ID | Synthetic, consistent, correct length |
| Bank account numbers | Zeroed |
| Amounts and quantities | **Scaled by a fixed per-file factor**; derived figures recomputed |
| ISINs | **Preserved.** They name a public security, not a person, and are the thing under test |
| Scheme and security names | Preserved |
| Dates | Preserved |

Amount scaling is the part that is easy to get wrong. Scaling naively breaks the running-balance
and portfolio-total checksums, and a fixture whose checksums do not balance cannot test the
checksum logic. The tool scales the primitive quantities and recomputes every derived figure.

### Enforcement

Redaction that depends on discipline fails. Three mechanisms:

1. A pre-commit hook and a CI job scan every added file for PAN-shaped, Aadhaar-shaped, 16-digit-BO-
   shaped and email-shaped strings outside the synthetic pool, and for `%PDF` bytes outside the
   generated-fixtures directory. Both fail the change.
2. Fixtures live only in `fixtures/`, and the CI job fails on any `.pdf` or `.csv` elsewhere.
3. `CONTRIBUTING.md` states that fixtures are produced by the tool and PRs adding hand-edited
   fixtures are closed unreviewed. Reviewing a redaction by eye is not a control.

### Golden files

A golden file is the canonical JSON of the **normalized** records — after normalize, before
resolve. Stopping there is deliberate: resolution depends on the local instrument catalogue, so a
golden file that included `instrument_id` would encode a machine's database state and break for
every contributor. Resolution, reconciliation and commit are tested separately against a seeded
in-memory database.

Serialisation is canonical: keys sorted, numbers as strings, records sorted by
`(accountKey, date, ref)`, two-space indent, trailing newline. A diff must be readable, because the
diff is the review.

## Testing

**Golden-file tests.** Every fixture, every descriptor. `fixture in → golden JSON out`, byte-exact.
This is the backbone and the thing that lets a stranger add a broker without breaking anyone's
numbers.

**Descriptor validation tests.** Every descriptor in the repository validates against the Zod
schema, and a set of deliberately broken descriptors produces the expected error paths and
messages. Contributor-facing error quality is a tested property, not an aspiration.

**Decryption tests.** One synthetic encrypted PDF per handler (RC4-40, RC4-128, AESV2, AESV3-R5,
AESV3-R6). Assertions: correct password opens; no password yields `code = 1`; wrong password
yields `code = 2`; the password never appears in any log line, error message or `raw_payload`.

**Scanned-file test.** A synthetic image-only PDF yields `E_SCANNED_PDF`, and a text PDF with very
little text on one page does not.

**Idempotency tests.** Three cases, all from Subsystem A's contract: the same file twice leaves
counts unchanged; two CAS statements with overlapping periods covering a shared trade commit that
trade once; the same MF folio arriving from a CAMS CAS and from an NSDL eCAS resolves to one
account and one set of transactions. The third is the one that catches the account-identity bug and
it must exist from day one.

**Capability tests.** A Detailed CAS with zero opening balances yields `ledger`. The same fixture
with one opening balance edited non-zero yields `snapshot` plus `W_INCOMPLETE_HISTORY`. A Summary
CAS, an NSDL eCAS and a CDSL eCAS all yield `snapshot`. A folio seen first in a Summary and then in
a Detailed statement is upgraded.

**Checksum tests.** For every MF CAS fixture, the running unit balance reconciles per row and per
scheme. A mutated fixture with one transaction row deleted produces `W_BALANCE_MISMATCH` and a
capability downgrade — not a crash, and not silence.

**Row-level resilience — property tests.** For each fixture, generate mutations: delete a random
row, corrupt a random numeric cell, blank a random date, duplicate a random row, truncate a random
line. Invariants: the import always reaches `completed` or a typed document-level failure, never an
unhandled exception; `rows_read` always equals the sum of its parts; every failed row has a
`raw_payload` that round-trips through re-run.

**Unresolved-queue test.** A CSV with no ISINs on a fresh database commits zero transactions,
queues one `unresolved_instrument` per distinct instrument with a non-zero `observed_value_minor`,
and completes. Resolving the alias and re-running commits all previously failed rows and leaves the
queue empty.

**Numeric fidelity tests.** A quantity of `12.3450` survives extract → normalize → storage →
read-back as exactly `12.3450`, trailing zero intact. An amount of `₹48,32,150.00` becomes
`483215000`. A parenthesised `(1,234.56)` becomes `-123456`. No test may construct an expected
value using `Number`.

**Format-drift canary.** A test asserts that every section header encountered across the whole
fixture corpus is one the parser claims to recognise. A new fixture containing an unrecognised
section fails the build rather than emitting `W_UNKNOWN_SECTION` into a report nobody reads.

## Out of scope

- **OCR.** Scanned or photographed statements are refused with a clear message. Adding OCR would
  add a large dependency and produce numbers whose accuracy cannot be asserted, which contradicts
  the design's rule that no estimated figure is presented as exact.
- **MF Central statements.** A different template from a portal whose future is uncertain. Detected
  and refused by name so the user knows why.
- **DP transaction statements**, contract notes, capital-gains statements, and AMC-specific account
  statements. Detected and refused where they are recognisable.
- **Excel and encrypted-zip inputs.** CSV only in v1. Users can export CSV from every source that
  offers XLSX.
- **Automatic statement retrieval.** Misal never logs into CAMS, KFintech, NSDL or CDSL, and never
  reads the user's email. Files arrive because the user drags them in.
- **Broker and exchange APIs.** Subsystem C for crypto; Indian and US broker APIs are deferred past
  v1 for the token-expiry reasons in the design.
- **Corporate-action inference.** Where a statement prints a bonus or split as a transaction it is
  ingested; Misal does not derive one from an unexplained quantity change. That belongs to
  Subsystem D.
- **Cost-basis and P&L computation.** Ingestion writes facts. Every derived figure — including the
  cost and annualised-return columns the statements themselves print — is Subsystem D's.
- **Multi-file batch import as a single unit.** Files are imported one at a time, each its own
  `import_run`. Ordering does not matter because the natural key is order-independent.

## Open questions for core

Seven things this subsystem wants that the schema does not carry. None is blocking; each has a
stated workaround.

1. **No per-transaction authority marker.** Depository eCAS transactions are real facts but must
   not be folded into positions, because a one-month fragment is not a history. Today the only
   signal is `account.capability`, which makes capability a fold gate as well as a display gate and
   couples this subsystem to Subsystem D through an implicit contract. A nullable
   `txn.authority TEXT CHECK (authority IN ('ledger','informational'))` would make it explicit.
   *Workaround: capability is the gate, documented in both specs.*

2. **`account.external_ref` has no uniqueness constraint.** Account identity across providers — the
   same MF folio from a CAMS CAS and an NSDL eCAS — depends entirely on ingestion looking up by
   `external_ref` before inserting. A `UNIQUE` index would make the double-account bug impossible
   rather than merely tested against. *Workaround: an idempotency test that would catch it.*

3. **The natural key cannot distinguish two genuinely identical transactions.** Two SIP instalments
   in the same scheme on the same date for the same amount produce one key, and the second is
   silently discarded as a duplicate. Folding levies into their parent removes the common case, but
   the residual case is real data loss. An occurrence ordinal in the key — deterministic within a
   document, derived from position — would fix it at the cost of weakening cross-document
   deduplication for reordered statements. *Workaround: `W_DUPLICATE_IN_DOCUMENT` makes it visible.*

4. **`import_issue` has no resolution state.** There is no `resolved_at`, no `resolved_by_run_id`,
   and no `stage` column saying whether the failure happened in extract, normalize or resolve.
   Re-running a row therefore deletes its issue, which loses the audit trail of what was fixed. A
   two-column addition would make the import report a history rather than a to-do list.

5. **`import_run` has no `rows_skipped`.** The MF CAS is full of non-financial event rows —
   address updates, nominee registrations, KYC changes — that are correctly ignored. With only
   `read`, `committed`, `duplicate` and `failed`, the counters cannot be made to reconcile without
   miscounting skipped rows as one of the other four. *Workaround: counted as `duplicate`, which is
   wrong and will confuse a user reading the report.*

6. **`import_run` records no parser identity.** There is no plugin id and no plugin version, so
   after a parser fix there is no way to find which past imports were produced by the buggy version
   and offer to re-run them. *Workaround: none. The user would have to re-import by hand.*

7. **`unresolved_instrument` has no asset-class hint.** The statement usually knows — an MF CAS row
   is a mutual fund, an NSDL equities table row is Indian equity — and the review queue would be
   materially faster to work through if it could pre-select the class. `raw_name` is the only place
   to put it today, which mixes data with a hint. *Workaround: the UI infers the class from the
   source document's provider, which is right most of the time and therefore worse than a stated
   value.*
