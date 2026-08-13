# Known issues

Defects and gaps identified during implementation but not yet fixed. Recorded here rather than
left in a branch description, so they survive the worktree they were found in.

Each entry states the consequence, because "known issue" without a consequence gets deprioritised
forever.

## Blocking before v1 ships

### Startup blocks on the keychain with no way to say so

`db::open()` is called from Tauri's `setup`, which runs before any UI exists. It calls
`secrets::database_key()`, which on macOS can raise an authorization prompt — and on Linux blocks
until a keyring daemon answers.

Found by running the built app rather than by any test: every test injects a key directly and never
touches the keychain, so the entire real startup path was unexercised.

**Consequence:** the window appears, empty, and the application does nothing. No database is
created, no error is shown, and the user is left looking at an unexplained system password box with
no indication of what is asking or why. Denying it produces no visible outcome either. On a fresh
machine this is the very first thing a new user experiences.

Aggravated in development because each rebuild produces a new unsigned binary, which macOS treats
as a different application, so approving one build does not carry to the next.

**Fix direction:** do not open the store in `setup`. Let the window render, then open it, and give
the failure a real screen — "Misal needs access to its encryption key in your keychain, which is
where your database password is kept" — with a retry. That also makes the Linux passphrase fallback
reachable, which today it is not, for the same reason.

### ~~A signed request pinned its origin but not its credential~~ — FIXED

`credential_for` in `src-tauri/src/sync.rs` selected the keychain reference with
`SELECT keychain_key FROM credential_ref WHERE account_id = ?1` and never joined
`account.provider_id`, while everything else about the request — adapter, signing scheme, method,
path, host — was re-derived from the Rust-side tables precisely so the caller could not choose it.
The account id and the adapter id arrive in one object from the frontend, and nothing made them
agree.

**Consequence:** with CoinDCX connected as `a1` and Binance as `a2`, a request of
`{adapterId: 'binance', accountId: 'a1', path: '/api/v3/myTrades'}` passed every guard and opened
TLS to `api.binance.com` carrying `X-MBX-APIKEY: <the CoinDCX key>`. CoinDCX issues no read-only
keys, so that is a trade-and-withdrawal credential landing in a third party's request logs. Pinning
the origin without pinning the credential only decides *which* third party receives the secret.

Fixed by re-deriving the pairing from `account.provider_id` — the column `commit_credential` writes
and nothing else does — before any stored credential is read, and by selecting the reference
through a join on that column so there is no ordering of statements in which the key is read first
and checked second. A mismatch is named in the error rather than looking like an absent row.

Two further doors to the same confusion were closed in the same pass, both being the shape of the
original: an account id from the caller paired with an exchange id that nothing checked it against.

- `upsert_document` filed a page under any `(accountId, providerId)` pair it was handed.
  `start_run` reads the provider back off that row to stamp the run, so every transaction under it
  would have cited a provenance that was a fiction.
- `commit_credential` upserted the account with `ON CONFLICT (id) DO UPDATE SET label`, which
  leaves `provider_id` alone. Committing a Binance key onto an existing CoinDCX account id left the
  row saying CoinDCX while `credential_ref` pointed at the Binance secret — the same confusion
  arriving through the connect flow instead of the transport.

**Standing lesson, and the reason this survived a guard module with tests:** every existing test
here — `one_adapter_cannot_borrow_anothers_endpoint`,
`the_signing_scheme_is_fixed_per_exchange` — uses a single fixture account, and a credential cannot
be aimed at the wrong exchange when there is only one. The fixture, not the assertions, was the
limit. The regression test now creates two accounts on two exchanges, and asserts on the *text* of
the refusal: without the fix the borrowed lookup still fails, one step later and for an unrelated
reason, so `is_err()` alone would have passed against the defect.

Reachability, stated honestly: both fields come from one options object today, so exploiting this
needed a compromised bundle or a contributed adapter. That is the same threat model
`src/adapters/allowlist.ts` names as the reason the Rust allowlist is duplicated at all.

### App bundle shipped with no icon — FIXED

`tauri.conf.json` had no `bundle.icon` array. The icons existed in `src-tauri/icons/` because
`tauri icon` generated them, but that command writes files and does not register them in a config
that was hand-written beforehand. The bundle had no `Contents/Resources` and no `CFBundleIconFile`,
so the application had no icon on any platform.

Caught by a person looking at the dock, which is the only way it could have been caught: nothing
about it is observable from a test.

### ~~Two divergent `natural_key` implementations~~ — FIXED

Resolved by `src/domain/natural-key.ts`, now the single definition used by both subsystems, with
a conformance test that computes a key through each call path and asserts they match. The date
parameter is a local calendar date and the function throws on an ISO instant, so the worst of the
four divergences cannot be reintroduced silently.

One residual, by design rather than oversight: the shared function deliberately refuses to derive
a calendar date from an instant, because the correct basis differs by source. Exchanges timestamp
in UTC and their exports agree, so `exchangeLocalDate` slices the instant; statements state a
local date and must never be sliced from UTC. Each caller now names its choice in code.

The original description is kept below, because the failure mode is worth recognising again.

### Two divergent `natural_key` implementations (historical)

Ingestion and the exchange adapters each compute `txn.natural_key` independently, and they do not
agree:

| | field list |
|---|---|
| `src/ingestion/` | account, instrument, type, local date, trailing-zero-trimmed quantity, `amountMinor` |
| `src/adapters/sync/natural-key.ts` | the same, **plus the exchange trade id** |

The adapters added the trade id for a real reason: without it, two identical commission rows from
different pages of the same API response collapse into one key, while `occurrence` counts only
within a document and the unique index spans all of them. So neither field list is simply wrong.

**Consequence:** deduplication only works within a source. A user who imports a CSV export of their
exchange trades *and* connects the same exchange by API gets both copies, because the two paths
produce different keys for the same trade. That inflates net worth — the same class of failure as
the mutual-fund folio doubling that `account.identity_key` was added to prevent, and it is
currently unguarded: nothing fails if the two field lists disagree.

**Fix direction:** one shared `naturalKey()` in `src/domain/`, consumed by both subsystems, with a
conformance test asserting both produce identical keys for the same logical transaction. Where a
discriminator is genuinely needed, it belongs in `occurrence` rather than folded into the key.

Cross-source dedup between a CSV export and an API sync of the same exchange may not be fully
solvable — a CSV that omits trade ids cannot be matched with confidence. If so, say so in the
import UI rather than silently producing duplicates.

### ~~Account identity depends on an AMC name slug~~ — FIXED

Resolved by the canonical AMC registry in `src/ingestion/amc/`. A folio's identity is now
`mf-folio:<registry id>:<folio>`, resolved from **the ISIN issuer prefix first** and a curated
alias table on the printed name second. The prefix — the first seven characters of a mutual fund
ISIN, `INF179K` — is the only AMC identifier these statements carry that does not vary with the
template, and both families print it: the CAMS scheme line as `- ISIN: …`, the NSDL eCAS in the
mutual fund folios table. Both parsers now scan the whole document for AMC evidence before any
identity key is built, because the CAMS CAS prints the folio line *before* the scheme line that
carries the ISIN, and keying at the folio line is what forked the folio.

That prefixes are AMC-scoped was checked rather than assumed, against AMFI's complete NAV file
(51 fund houses, ~17,800 scheme rows): no prefix appears under two houses. Registrar codes, which
the original fix direction proposed, turned out to be the wrong instrument — `Registrar :` names
CAMS or KFintech, and one registrar services dozens of AMCs.

The fixtures no longer agree by accident: `AMC_SPELLINGS` in `src/ingestion/testing/corpus.ts`
carries three real forms per house — the fund form, the legal-entity form and a
punctuation/whitespace variant — the NSDL fixture prints the legal entity by default, and
`amc-identity.test.ts` imports every pairing and asserts one account.

Migration 0004 re-keys folios already in the database. Two residuals, both deliberate:

- **A database that already forked a folio is not merged.** Where two accounts would rewrite onto
  the same canonical key, both are left exactly as they were. Merging them cannot fix the totals:
  `txn.natural_key` is a hash over `account_id`, SQL cannot recompute it, so both copies of every
  transaction would survive the merge — and deleting one account would discard transactions the
  user's own statements assert. The pair stays visible as two accounts against one folio number.
  A repair path belongs in the review queue, where a human can confirm it, not in a migration.
- **An unrecognised fund house gets a provisional identity, not a canonical one.** The key carries
  an `unverified~` marker — `~` cannot occur in a registry id — and the import report raises
  `W_AMC_UNRECOGNISED`. Where the statement printed an ISIN, the provisional token is the unknown
  issuer prefix, so the folio is still stable across documents. Where it printed only a name that
  the registry does not list, it is not, and the warning says so in those words.

The original description is kept below, because the failure mode is worth recognising again.

### Account identity depends on an AMC name slug (historical)

`identity_key` for a mutual fund folio is built from a slugified AMC name. The test fixtures print
"HDFC Mutual Fund" in both documents, but a real NSDL eCAS printing "HDFC Asset Management Company
Limited" slugs differently.

**Consequence:** the same folio becomes two accounts and its units are counted twice — exactly the
failure the identity key exists to prevent, and the test suite would not catch it because both
fixtures happen to agree.

**Fix direction:** a canonical AMC table keyed on registrar codes, rather than string
normalisation of a printed name.

### ~~Every NSDL demat holding is attributed to the first demat account in the file~~ — FIXED

Resolved by a per-account section cursor in `src/ingestion/pdf/nsdl-ecas.ts`. Each holding is now
attributed to the demat account whose header block it is printed under, holdings are held until the
whole document has been read, and a holding that no header claims **fails its row** with
`E_MISSING_REQUIRED_FIELD` rather than being attached to whichever account came first.

The layout was researched rather than assumed, and three of the obvious assumptions were wrong:

- There is **no `Depository :` label**. The depository is carried by the account-type line itself,
  literally `NSDL Demat Account` or `CDSL Demat Account`, matched anchored at both ends because the
  phrase "demat account" also appears in the numbered notes at the back of the statement and an
  unanchored match opens phantom sections there.
- **`DP Name :` is the CDSL-issued CAS's label, not this document's.** In an NSDL eCAS the
  participant's name is an *unlabelled* cell between the account-type line and the identifiers, so
  it is read positionally. The label is still accepted, because accepting it costs nothing.
- **A CDSL account inside an NSDL CAS is not printed as a 16-digit BO ID.** It is stated in NSDL's
  own `DP ID` / `Client ID` form and differs only in that the DP ID is eight digits rather than `IN`
  plus six. The previous roster reader required `IN`, so it dropped CDSL accounts entirely — the
  same class of loss one column along, and fixed here too. The 16-digit form is still accepted, for
  the CDSL-issued CAS.

Section context deliberately survives a page break, because one account's holdings run over several
pages under a repeated *column* header with no repeated account header. It is reset only by the
next account header, by the roster anchor, or by `Mutual Fund Folios (F)` — never by a totals row,
because `Sub Total` / `Total` / `Grand Total` are optional and a section that lacks one would
swallow the next account's rows.

Fixtures: `nsdlEcasTwoDematPages` in `src/ingestion/testing/corpus.ts` declares an NSDL account and
a CDSL account under one PAN, **with the same ISIN genuinely held in both** — the case that lost
units — and `nsdlEcasOrphanHoldingPages` removes one header block to exercise the refusal.
`src/ingestion/pipeline.test.ts` asserts at the store that both holdings of that ISIN survive and
that no two positions share `(account, instrument, as_of)`; that test finds only one row against the
old parser.

The two other places the same flaw could live were checked. The **MF folio path** never had it: a
folio number is printed on its own row and joined back to the roster, which is why that section was
correct all along. *That conclusion was wrong, and the entry below says why — the join was on the
folio **number**, which is not an identity.* The **transaction path** does not have it because it
does not exist — this parser
reads no transactions at all today, though the spec describes an 8-column demat ledger grouped under
`ISIN : <isin>` anchor rows. Whoever implements it inherits the same requirement: a ledger row is
attributed to the account section it sits in, or it fails.

Three residuals, all deliberate:

- **A one-account statement that prints no header at all is still attributed.** Where the document
  declares exactly one demat account *and* no account header was read anywhere in it, there is only
  one account a holding can belong to. That is a deduction, not a guess, and it is narrowed by the
  "anywhere in it" clause: once the file has been seen printing account headers, a holdings block
  without one is a hole in the parse and its rows fail.
- **A damaged header between two accounts still merges them.** Because context carries across page
  breaks, a second account's header that fails to parse leaves the first account in scope and its
  holdings land there. Only a header that fails *before any* account has been seen is detectable.
  Closing this needs a signal the research could not confirm — whether the header repeats on every
  continuation page. If it does, requiring one per page turns this from a silent merge into a
  visible failure.
- **The roster's column geometry is unverified.** `readRoster` reads `DP ID` and `Client ID` as two
  x-bands, which is what the corpus fixture and the ingestion spec describe. The strongest external
  source available — a mature open-source parser written against real files — instead shows them as
  one inline `DP Id : … Client Id : …` run inside the participant-name cell, with no folio column on
  a demat row and a *count* where the fixture puts a folio number. Neither could be checked against
  a real statement, so nothing was changed on the strength of it. The fix above is insulated from
  the answer: account headers on the detail pages register their own accounts, so demat attribution
  survives a roster that does not parse. What would not survive is the MF folio path, which joins on
  the roster's fund-house column.

The original description is kept below, because the failure mode is worth recognising again.

### Every NSDL demat holding is attributed to the first demat account in the file (historical)

Found while fixing the AMC identity key, and it is the same failure class one layer along.
`readDematHolding` in `src/ingestion/pdf/nsdl-ecas.ts` picks its account with

```ts
const account = [...accounts.values()].find((a) => a.key.startsWith('demat:'))
```

— the *first* demat account the roster declared, for every holding in the file. An NSDL eCAS
routinely lists more than one demat account, and it lists them precisely because the investor has
more than one; the holdings sections that follow are per account, and the parser does not track
which one it is inside. The MF folio path does not have this problem, because a folio number
appears on its own row and is joined back to the roster.

**Consequence:** with two or more demat accounts, every share lands under the first. Net worth
totals are unaffected — the holdings are all still counted once — but per-account values are wrong,
the second account looks empty, and any future per-account cost basis or XIRR is computed against
the wrong set of transactions. It also makes the position uniqueness constraint
`(account_id, instrument_id, as_of)` collide when the same ISIN is genuinely held in two accounts,
so one of the two holdings is silently restated over the other and **that** does lose units.

**Fix direction:** the demat holdings section is introduced by a header naming its DP ID and client
ID. Carry that as section context the way the CAMS parser carries the folio, and fail the section
with an issue rather than guessing when no account header has been seen. The single-account
fixture cannot catch this; a two-demat-account fixture is the first thing the fix needs.

### ~~The NSDL eCAS keys MF folios on the folio number alone~~ — FIXED

Resolved by `FolioRoster` and `emitFolioRecords` in `src/ingestion/pdf/nsdl-ecas.ts`. The roster's
folio claims are now keyed on `FolioAmcIndex.scope(printedName, folio)` — the same (house, number)
pair the identity key itself uses — instead of on the folio number, and that scope is carried
through both the account loop and the position loop. A scheme row under a number two houses claim is
attributed by **its own ISIN issuer prefix**; where the prefix names neither claimant, or names no
house the registry knows, the row **fails** with `E_MISSING_REQUIRED_FIELD` rather than joining to
whichever roster line printed last. A shared number is reported in its own right, as
`W_FOLIO_NUMBER_SHARED`, which says that folio numbers are registrar-scoped and that each scheme was
attributed by its ISIN.

Found by adversarial review of the branch that fixed the demat path, which had explicitly cleared
the MF path as "correct all along" — it was checked for the *demat* flaw, which it does not have,
and the check stopped there.

Fixture: `nsdlEcasSharedFolioPages` in `src/ingestion/testing/corpus.ts` prints folio `12345678 / 0`
under **two** fund houses, each scheme carrying its own issuer prefix (`INF179K` HDFC,
`INF200K` SBI); `nsdlEcasSharedFolioStrayIsinPages` gives one of them an Axis ISIN that neither
claimant issued, to exercise the refusal. Every existing fixture gives each folio a distinct number,
which is exactly why a last-writer-wins map read as correct — the defect is invisible until two
houses claim one number. `nsdl-ecas.test.ts` also imports the eCAS and then the registrar's own CAS
for the SBI folio and asserts the units land on **one** account id; that test finds two against the
old parser.

Two residuals, both deliberate:

- **A scheme row the roster does not account for now fails rather than being dropped.** It was
  previously discarded in silence, because the join simply missed. An error the user can see is the
  point; a row that vanishes is not.
- **Two houses whose names the registry does not know, claiming one number, cannot be told apart
  by name.** Their schemes still separate correctly when the ISINs resolve, and fail visibly when
  they do not. There is no third option that is not a guess.

One hole is left open, deliberately but not comfortably:

- **A shared folio number whose roster names only *one* of the two houses still merges.** If the
  second roster row's DP Name cell is blank or does not parse, there is one claimant, both houses'
  schemes are attributed to it, and `resolveAmc` picks whichever issuer prefix printed first —
  the original defect, arriving through an unreadable roster instead of through the map. The
  evidence to catch it is already on the rows: schemes under one folio number whose ISINs resolve
  to *two* registry houses are two folios whatever the roster managed to print, and the pair
  (issuer prefix, folio number) is a complete identity with no guess in it. It is not implemented
  here because it changes the single-claimant path, which is where `W_AMC_NAME_CONFLICT` lives —
  a roster that *misnames* one house must keep merging into one account, and telling that apart
  from a roster that *missed* a house needs the ISIN-count rule above stated as a deliberate
  design decision rather than smuggled in beside a fix. The same reasoning applies to a roster
  that does not parse at all: every scheme row then fails, where each row on its own carries both
  a folio number and an ISIN, and could stand up its own account.

### The NSDL eCAS keys MF folios on the folio number alone (historical)

`folioAmc` in `src/ingestion/pdf/nsdl-ecas.ts` was `Map<folio, dpName>`, written once per roster row
and last-writer-wins:

```ts
folioAmc.set(folio, dpName)
```

Mutual fund folio numbers are issued per registrar rather than globally, which is the entire reason
`FolioAmcIndex.scope(printedName, folio)` exists and the reason the fund house is mandatory in
`mf-folio:<amc>:<folio>`. Two roster rows carrying number `12345678` — one under HDFC, one under SBI
— therefore produced **one** account: the account loop emitted one row per folio *number*,
`readMfFolio` filed both houses' schemes into one evidence bucket, and `resolveAmc` handed the
account to whichever ISIN issuer prefix printed first. One of the two folios got no account at all.

**Consequence:** the units of the losing house are reported against the winning house's account, and
the folio the statement named is missing. That alone is a per-account error rather than a total one
— but when that house's own CAMS or KFintech CAS is imported it scopes correctly and creates its own
account, while the eCAS copy of the same units still sits inside the other house's account.
`derivePositions` works per `(accountId, instrumentId)`, so **both are counted**: the same doubled
net worth `account.identity_key` was introduced to prevent, arriving through the parser instead of
through the key. The only signal was a `W_AMC_NAME_CONFLICT`, raised in one print order out of two,
and its wording describes a name/ISIN disagreement rather than a folio merge — so a user reading it
would look for a misspelled fund house, not for a missing account.

### ~~Three ways for the review queue to destroy a disclosure about missing money~~ — FIXED

Found by adversarial review of the ingestion write path. Three separate defects, one failure: **an
action the interface invites silently deleted the statement that money is missing from net worth.**
The withheld figure is the one number in Misal that exists purely to be believed literally — "some
holdings unresolved" is not a fact a user can act on and "₹1,18,640 withheld" is — and all three
turned it into a number that was quietly wrong.

The root cause was that `resolved_at` carried three meanings at once. It was the *only* "still open"
predicate in the system (`queries.rs::list_unresolved`, `ingest.rs::unresolved_for_document`,
`valuation/portfolio.ts`), so anything that stopped the queue asking also stopped the money being
counted as absent. Migration 0006 separates them: `ignored_at` (do not ask again), `mapped_at` (the
user named it), `resolved_at` (**the rows are in the ledger**). Only the last one silences the
disclosure, and only `commit_batch` may set it, keyed on rows that actually exist.

- **Dismissing an unresolved instrument erased the money it was withholding.** `ignore_unresolved`
  set `resolved_at`, so the rupee figure fell to zero, the count fell to zero, and the dashboard
  replaced the disclosure with the affirmative claim `Every identifier in every document is mapped`
  — of a holding it had never identified, permanently, because nothing reopens a closed entry.
  Dismissal now sets `ignored_at` and the value goes on being disclosed, which is the truth: the
  user asked not to be chased, not for the holding to be counted.

- **Mapping an unresolved instrument made its transactions unrecoverable.** An import whose rows all
  failed to resolve writes zero `txn` rows but does write a `source_document` carrying the content
  hash, so re-importing returned `already-imported`. Mapping wrote the alias and closed the entry,
  and nothing ever re-ran the withheld rows — while the report told the user they "are released when
  a document containing them is imported again", which was never true of the document that had just
  withheld them. Mapping now records the answer and leaves the entry open and disclosing; the
  content-hash short-circuit stands aside for a document with rows still withheld, so importing the
  same file again lands them; and `commit_batch` closes the entry at that moment. The report copy
  now names that path instead of promising one that did not exist.

  **Not fixed as originally proposed, and the reason is worth recording.** The intended fix was to
  re-run the retained `import_issue.raw_payload` rows through commit. It cannot be done from that
  column, whose doc comment claims it is "sufficient to replay it from normalize". It is not: a CAS
  transaction's payload is `{date, description, amount, units, price, balance}`, which names neither
  the folio nor the ISIN, so nothing in it can say which account or instrument the row belonged to.
  Replay needs the document, and Misal deliberately never copies the file. Either the payload has to
  become a serialised `RawTransaction` — a plugin-wide change, and one that starts storing the
  user's rows twice — or re-reading the file stays the mechanism. `raw_payload` is still written and
  still read by nothing.

- **Each import inserted a fresh unresolved row, so the withheld total doubled per statement.** Two
  statements naming the same unmapped ISIN reported two instruments and twice the rupees for one
  holding; a monthly eCAS made it twelve a year. The exchange path (`sync.rs::record_unresolved`)
  had always guarded the identical insert. Ingestion now guards it the same way, updates the
  observed value on the open row instead — `coalesce`, so a tradebook with no valuation column
  cannot blank a figure a holdings statement printed — and migration 0006 both collapses the
  duplicates an existing database already holds and adds a partial unique index so the rule is
  structural rather than a convention two call sites have to remember.

One consequence worth knowing: because only one entry stays open per identifier per account, an
entry raised by January's statement is the one February's import touches. `last_seen_document_id`
carries the latest sighting so February's import report still lists what February could not
identify, rather than showing an empty queue while withholding rows.

### ~~The review queue had three states in the schema and no screen showing any of them~~ — FIXED

Migration 0006 split `ignored_at` and `mapped_at` out of `resolved_at` so that dismissing an entry
would stop Misal asking without deleting the disclosure that money is missing. It landed in the
database and in the import path, and then had nowhere to go: `queries.rs::list_unresolved` returns
dismissed and mapped-but-not-landed entries, and no screen rendered them. The import screen shows
only what the document just imported could not identify, and its own copy told the user that
"dismissed items stay in Settings → Review queue" — a screen that did not exist.

**Consequence while it stood:** the withheld figure on the dashboard was correct and unexplainable.
A user dismissed an entry, the tile went on saying ₹1,18,640 was being held out of every total, and
there was no list anywhere that could say which holding, from which account, or why — nor any way to
put a dismissal back. The split columns bought honesty in the total at the cost of an unreachable
one. A dismissal was, in practice, still irreversible; only the arithmetic had been fixed.

`accounts.rs::review_queue` and the `Review queue` panel on the settings screen now show every entry
still withholding value, grouped as open, mapped-but-not-landed, and dismissed, each labelled for
what it actually is, each carrying its own rupee figure, and each state carrying a sentence saying
what it does and does not mean for net worth. A dismissed entry counts toward the total exactly as an
open one does, and can be put back with one button.

Two things the panel deliberately does not do. It does not offer to map an instrument — that belongs
beside the document that raised the entry, where the units, dates and page reference are, and
choosing without them is guesswork. And it does not print a zero for an entry whose source stated no
value: those are counted and named separately, because an unknown amount added in as zero is a total
that looks complete and is not.

### ~~There was no way to delete an account~~ — FIXED

Reviewers found that when a valuation failure was caused by one bad account, the only recovery was
deleting the encrypted database — and with it every statement ever imported, every hand-entered
correction and every instrument mapping the user had made. The immediate cause of that particular
failure is fixed, but the absence of a delete is what made it catastrophic rather than annoying, and
that absence was the general case.

`accounts.rs::account_delete` removes the account, its transactions, its positions, its sync cursors,
its exchange state, its review-queue entries, its credential reference **and its keychain entry**, in
one transaction. Three rules, each of which is tested:

- **The keychain entry goes first**, mirroring `disconnect.rs`. If the keychain refuses, the command
  fails and every row stays, so the user sees an account that is still there — which is true.
  Removing the rows first and failing afterwards would leave a live, full-access API key on the
  machine belonging to an account they can no longer see.
- **It all happens or none of it does.** A half-deleted account — positions gone, transactions kept —
  is a portfolio silently missing a slice of its history with no error anywhere to explain it.
- **Shared source documents are detached, not deleted.** A CAMS consolidated statement carries
  several folios, and every fact table references `source_document` with `ON DELETE CASCADE`, so
  deleting a document another account's rows still cite would delete *that* account's transactions as
  a side effect. Documents nothing else references go with the account; documents another account's
  rows still cite are kept and their `account_id` cleared.

Instruments, prices, aliases and exchange rates are deliberately kept. They are shared and are not
any one account's property; removing them would take other accounts' holdings down with them.

The confirmation states the loss in figures — the label, the transaction count, the holding count and
the value the valuation engine currently attributes to the account — and requires the user to type the
account's name. A bare "Are you sure?" is answered by the same reflex that pressed the button before
it. The value comes from `buildPortfolioView`, not from a second calculation in SQL, so it is the
figure the dashboard shows; when it cannot be computed the confirmation says why rather than printing
a blank in the middle of a sentence about irreversible loss.

### Deleting one folio of a multi-folio statement blocks re-importing that statement

`source_document.content_hash` is UNIQUE and is the first line of import idempotency: the same file
cannot be imported twice. Deleting an account removes the documents nothing else references, which
frees their hashes — so re-importing a single-account statement after deleting its account works, and
is the documented recovery path.

A *shared* statement is kept, correctly, because another account's rows still cite it. Its hash is
therefore still taken.

**Consequence:** a user who deletes one folio out of a CAMS CAS covering four of them cannot restore
it by re-importing that CAS. The import short-circuits as `already-imported` and nothing lands. The
only recoveries are a different statement covering the folio, or deleting the other three accounts as
well, which is the opposite of what they wanted. Nothing warns them: the confirmation says the
statement is kept, which sounds protective, and it is — for the other three.

**Fix direction:** the same stand-aside the mapped-rows fix already added. `ingest.rs` lets a document
past the content-hash check when it still has rows withheld; the equivalent here is to let it past
when it carries rows for an account that no longer exists. That is not a change this branch may make
— `ingest.rs` is owned elsewhere — and it needs a way to ask "does this document name an account we
no longer hold", which the parse knows before the hash check runs.

### The deletion preview and the deletion are two separate commands

`account_deletion_preview` and `account_delete` each take the storage mutex on their own. Between the
two, a sync or an import can commit rows to the account being deleted.

**Consequence:** the user confirms "412 transactions" and 418 are removed. The outcome line reports
the true figure, so nothing is misreported after the fact, but the number they agreed to was already
stale when they read it. Small today — nothing runs on a schedule, and an exchange sync is manual —
and it becomes real the moment any background refresh writes transactions.

**Fix direction:** return an opaque token from the preview, computed from the counts, and have the
delete refuse a token that no longer matches. Cheaper than holding a lock across a user's decision,
and it fails loudly rather than silently deleting more than was agreed.

### ~~`read_statement_bytes` was an arbitrary-file read exposed to the webview~~ — FIXED

`ingest.rs` did `std::fs::read(path)` on a caller-supplied path with no binding to the file picker's
result, no extension check and no size cap, so `invoke('read_statement_bytes', {path:
'~/.ssh/id_rsa'})` returned the bytes.

This is the mirror of an invariant two sibling modules already assert in their own headers:
`export.rs` refuses any command taking a caller-supplied *destination*, and `http.rs` refuses any
command taking a caller-supplied *URL*, both for the same stated reason — a local-first application
one XSS away from being an exfiltration tool. The source side had no such guard.

`pick_statement_file` now records the chosen `PathBuf` in managed state and returns an opaque
handle; `read_statement_bytes` accepts only a handle, and the frontend never learns the path because
it has no use for one. The extension is enforced at registration rather than left to the dialog's
filter, which can be typed past, and a 64 MB cap bounds the read.

**Consequence had it shipped:** any script reaching the IPC bridge could read any file the user
could, one call at a time, from an application whose whole premise is that data does not leave the
machine.

## Valuation engine

### ~~`PriceService.priceAt` returns the nearest preceding price, not an exact match~~ — FIXED

Fixed by making the not-measured branch the only place a stale price can be reached, following
`Measured`. A date selector is now answered exactly or not at all: when the table holds no row on
the requested date, `priceAt` returns `{ ok: false }` with a `PRICE_NOT_ON_DATE` error carrying
`requested`, `staleByDays`, and the preceding row as `lastKnown`. Because the failing branch has no
`value` field, reading `value.close` for a day that has no price is a compile error rather than a
silently stale figure on screen.

`'latest'` is deliberately unchanged — "the most recent row" is exactly what that selector asks
for, and its freshness is already reported by `priceAge`.

One caller genuinely wants last-known-price semantics: `xirrForScope`'s `priceOn`, because a
cashflow is dated by the day it happened and most such days have no published close. It now names
`lastKnown` explicitly, so the carry-forward is a visible decision at the one site that needs it
instead of a default everyone inherits.

The original description is kept below, because the shape of the failure is worth recognising
again: a result type that is *technically* honest — the record did state its own `asOf` — but whose
easiest reading is the wrong one.

### `PriceService.priceAt` returns the nearest preceding price (historical)

A caller asking for a price on a date with no row receives an older row instead. The returned
record states its own `asOf`, so a careful caller can detect this, but a caller that reads only
`close` will silently show a stale price as if it were the requested day's.

**Consequence:** a holding could be valued at a price from days earlier without the UI marking it
stale. Directly undermines the staleness indicator the design promises.

### ~~Instant comparisons are lexicographic on ISO strings~~ — FIXED

Fixed by `compareInstants` in `src/valuation/calendar.ts`, which normalises to epoch milliseconds
before ordering, and is now used by the snapshot selection in `src/valuation/positions.ts`.

Normalising at comparison time rather than enforcing a `Z` suffix at the storage boundary was the
deliberate choice: `occurred_at` keeps the source's offset on purpose — a statement's local trade
date must not be re-derived from UTC, which is the same distinction the `natural_key` entry above
settled — so the offsets have to survive in storage and the ordering has to cope with them.

Two failure modes were fixed, not one. The known-wrong-winner case is the obvious one; the second
was worse and unstated: a row written at a large positive offset sorts *after* the valuation
instant as text while genuinely preceding it, so it was filtered out entirely and the holding
dropped out of net worth rather than merely being valued from the wrong row.

**Still lexicographic, and correct to be:** comparisons on `IsoDate` (`fx.ts`, `price/*.ts`,
`xirr.ts`). Those are `YYYY-MM-DD` with no offset to disagree about, where string order *is*
chronological order.

### Cross-account corporate-action check keys on ex-date alone

If two accounts record the same split a day apart, each appears to the other to be missing it, and
both get downgraded.

**Consequence:** false `not_measured` results that hide otherwise-valid metrics.

### Missing arithmetic helpers live in the wrong layer

`powDec`, `roundDec` and `mulDivMinor` were needed by the valuation engine and were added to
`src/valuation/arithmetic.ts`. They are general numeric operations and belong in
`src/domain/numeric.ts`, where the float ban already exempts the module and the tests are
concentrated.

**Consequence:** a second subsystem needing them will either duplicate them or import across a
boundary that should not exist.

**Still open.** Deliberately left alone while fixing the two price/time defects above: the move
lands in `src/domain/numeric.ts`, and doing it from a branch scoped to `src/valuation/` would
conflict with concurrent work there. It needs its own branch that owns both directories.

### `NotMeasuredReason` has no member for a blocked grandfathering FMV

Currently borrows `unknown_tax_regime`, which reports the wrong reason to the user.

### `BONUS_UNITS_MISMATCH` is unreachable

Nothing in the schema stores a bonus ratio, so units credited cannot be cross-checked against an
expected figure. The check exists but can never fire.

**Fix direction:** either store the ratio during ingestion or delete the dead branch. Leaving an
unreachable validation implies a guarantee that does not exist.

### Twelve Data rate limiting is incomplete

The daily quota is enforced; the per-minute limit is not, and there is no retry or backoff.

**Consequence:** a burst of requests can trip the provider's minute limit and fail a sync with no
recovery.

### ~~Choosing USD as the base currency froze every exchange rate, permanently and silently~~ — FIXED

`settings.rs` offered `["INR", "USD"]` as base currencies while nothing in the engine read the
setting. Selecting USD made `refreshFx` early-return for good, so no USD/INR row was ever written
again — but `valueFromRows` hardcodes INR and converts through `FxTable.latest`, which, unlike
`on`, had no age bound at all.

**Consequence, as it stood:** net worth kept moving every day on refreshed prices while the FX leg
was pinned to the day the setting changed. Nothing marked it: FX age appeared in neither `priceAge`
nor `stalePriceCount`. The refresh note claimed foreign holdings "will stay out of net worth",
which was the opposite of the truth — they stayed *in*, at a frozen rate. And because
`foreignCurrencies` is computed against the configured base, a portfolio held entirely in USD
produced no foreign currencies at all and returned before the note was pushed, so the user whose
whole portfolio was affected was the only one told nothing.

Fixed in three places:

- `CURRENCIES` is `["INR"]`, and the Settings control disables itself when the core offers one
  value. A choice that renames the totals without converting them is worse than no choice. The
  screen's footnote now says that, rather than saying the setting does nothing.
- `FxTable.latest` takes the valuation date and refuses a rate older than `MAX_FX_LATEST_AGE_DAYS`
  (7), returning `FX_RATE_STALE` carrying the rate's own date and age. The holding leaves net worth
  with a warning naming the age, exactly as it does when no rate was ever stored. **A stale rate is
  refused, never extrapolated** — a bounded absence is auditable and a frozen number is not. Seven
  days rather than `on`'s three because `latest` is bounded against the user's refresh habit, not
  against a market weekend.
- The `FX_BASE_UNSUPPORTED` note is raised before anything is counted as needed, names the
  currencies quoted against INR, and describes what actually happens: totals moving on refreshed
  prices against a frozen rate, and holdings dropping out once the rate passes the bound.

**Residual, deliberate:** the bound only becomes visible when the engine values a portfolio. An FX
rate whose age is between a failed refresh and the bound is still not reflected in `priceAge` or
`stalePriceCount`, which count price age alone. Surfacing FX age as a first-class staleness input
belongs with whoever next owns `src/valuation/portfolio.ts`'s coverage reporting.

## Interface

### ~~A single missing period was drawn as a continuous line~~ — FIXED

`NavHistoryChart`'s gap threshold was `Math.max(MIN_GAP_DAYS, median * 2)`, consumed by a strict
`delta > threshold`. In any regular series one missing observation produces a delta of exactly
twice the cadence, so the commonest shape of a gap was the one shape that could never be flagged: a
month-end series missing June has deltas of 28, 31, 30, 31, **61**, 31, 30 — median 31, threshold
62, and 61 > 62 is false. A weekly series missing one week gives 14 against 14.

**Consequence, as it stood:** the line was drawn straight through the hole, `data-gaps` read 0, the
aria-label dropped its "N periods no price is stored for" clause, and the accessible table lost its
"not interpolated" row. The file's own header promises the opposite, and the only existing test
used a five-month hole, which cleared the threshold by accident of size.

Fixed to `Math.max(MIN_GAP_DAYS, Math.floor(median * 3 / 2))`. Relaxing the comparison to `>=`
would not have been enough: calendar months run 28 to 31 days, so a missing February gives 59
against a threshold of 62. At `3/2` the threshold sits above the widest ordinary month (31 → 46)
and below the narrowest doubled one (28 × 2 = 56). Tests cover a missing June, a missing February
and a missing week, all three of which fail against `median * 2`.

## Screens and display

Three defects found by adversarial review of the view-model and the screens, all fixed together on
`fix/display-honesty`. They share a shape worth naming: each made the interface *state* something
the data underneath did not support, and each survived because no fixture reached the state that
would have exposed it. Every one now has a test that fails without its fix.

### ~~XIRR was withheld for a metric that could be computed, and the user was blamed for it~~ — FIXED

Both XIRR call sites in `src/screens/view-model.ts` — the portfolio readout and the per-instrument
view — constructed `new FxTable([])`. `rows.fxRates` was on the same parameter, and `valueFromRows`
in `src/data/portfolio.ts` already builds a real table from it under a comment naming this exact
construction as a previously-fixed regression. These two sites never got that fix.

With an empty table, `buildCashflows` cannot date any foreign transaction that has no per-row
`fx_rate`, so it returns `MISSING_FX`. XIRR is solved over the whole scope at once, so **one such
row withheld the figure for the rupee holdings beside it too**.

The reason given was then wrong twice over. Everything except `MISSING_PRICE` was mapped to
`no_transaction_history`, so the instrument screen printed "no transaction history" directly above
the lot table listing that history — and `no_fx_rate` had existed in `NotMeasuredReason` all along.

**Consequence:** the headline return figure read "Not measured — no transaction history" for a
portfolio whose history was fully imported and visible on the same screen. The coverage panel
disagreed out loud: `pairFxUsable` counts a pair as XIRR-eligible whenever the daily table can date
its transactions, so a coverage percentage in the high eighties sat beside a blank figure.

Fixed by seeding both tables from `rows.fxRates`, and by an exhaustive `xirrReason` mapping:
`MISSING_FX` → `no_fx_rate`, the three numerical failures (`NO_SIGN_CHANGE`, `NO_BRACKET`,
`NOT_CONVERGED`) → `no_convergence`, and only the genuine history gaps to
`no_transaction_history`.

**Scope, stated so it is not overstated:** this recovers the flows the *stored* table can date.
`refresh.ts` fetches only `'latest'` and `FxTable.on` backfills three days, so a vest older than
the stored rates still returns `MISSING_FX` — it is now named as a missing rate rather than blamed
on absent history. Filling that gap needs historical FX fetching, which nothing does yet.

### ~~Coverage percentages rounded half-up, so 99.95% and up printed as "100.0%"~~ — FIXED

`Dashboard.tsx`, `Holdings.tsx` and `CoverageMeter.tsx` each formatted coverage with
`formatPct(pct, { decimals: 1 })`, and `roundDec` rounds half-up. `historyCoveragePct` clamps to
`99.99` *specifically* so that `100.00` can only mean exact equality — `coverage.ts` calls the
alternative "a lie by rounding… the single most likely way this feature loses the user's trust".
Rounding at the display boundary handed that guarantee straight back.

`CalibrationBar.tsx` records the same bug being found and fixed there by routing through the
truncating `coveragePercent`. These three sites never got the treatment, and inside a single
`ReadoutCell` the printed coverage line read "99.9%" while the meter's accessible name — the only
figure a screen-reader user gets — said "Coverage 100.0 percent".

**Consequence:** a portfolio with ₹39 of unmeasured value in ₹7.9 lakh claimed complete coverage,
in the one indicator whose entire job is to say what the product cannot measure.

Fixed by `coverageText` in `CoverageMeter.tsx`, which routes all three sites through
`coveragePercent` so there is one truncation rule in the product rather than two that agree until
they do not.

### ~~The concentration chart's "Other" bucket was hardcoded ledger-backed~~ — FIXED

With more than ten priced positions the tail rolls into a single "Other" row, whose `basis` was
`'ledger' as const` — asserted rather than derived. Every other aggregation in the file derives it
from its members; `aggregateByClass` downgrades a whole class if any member is snapshot.

**Consequence:** snapshot-only tail holdings lost their hatch and drew as solid, ledger-backed
bars. The honesty suite could not catch it: `assertHonest`'s H5 counts `[data-hatch]` elements
against `[data-basis="snapshot"]` ones, so a row mislabelled upstream makes both counts zero and
the check passes on a picture that is wrong.

It had never once been exercised: no fixture in the corpus had more than ten priced positions, so
the bucket was never built. `src/screens/view-model.test.ts` now carries a twelve-position one.

**Standing lesson for all three:** a fixture corpus that only ever visits the comfortable middle of
a range leaves the honesty machinery untested exactly where it matters — at completeness, at the
tail, and in the currency this product exists to consolidate.

## Test coverage

### Tax rule tables were nearly unguarded

Mutation testing on 2026-08-12 found that changing all nine tax rates failed only one test, and
changing holding-period thresholds was largely undetected. These values are transcribed from
legislation, change annually, and a wrong one produces a plausible number rather than a crash.

Addressed by `src/valuation/tax-rules.table.test.ts`, which pins every rate, threshold, effective
date and grandfathering flag. Verified by re-running the mutations: each is now caught.

**Standing lesson:** golden arithmetic examples do not cover lookup tables. Any table transcribed
from an external source needs exhaustive assertion, not sampled assertion.
