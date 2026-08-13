# Known issues

Defects and gaps identified during implementation but not yet fixed. Recorded here rather than
left in a branch description, so they survive the worktree they were found in.

Each entry states the consequence, because "known issue" without a consequence gets deprioritised
forever.

## Blocking before v1 ships

### ~~Startup blocks on the keychain with no way to say so~~ — FIXED

`db::open()` was called from Tauri's `setup`, which runs before any UI exists. It calls
`secrets::database_key()`, which on macOS can raise an authorization prompt — and on Linux blocks
until a keyring daemon answers.

Found by running the built app rather than by any test: every test injects a key directly and never
touches the keychain, so the entire real startup path was unexercised.

**Consequence:** the window appeared, empty, and the application did nothing. No database was
created, no error was shown, and the user was left looking at an unexplained system password box
with no indication of what was asking or why. Denying it produced no visible outcome either. On a
fresh machine this was the very first thing a new user experienced.

Aggravated in development because each rebuild produces a new unsigned binary, which macOS treats
as a different application, so approving one build does not carry to the next.

Fixed by taking the store out of `setup` entirely. `setup` now manages only in-memory state; the
window renders, and `src/screens/startup/StartupGate.tsx` calls the new `startup_open_store`
command from an effect. `AppState` is managed at that point rather than at launch, so no command
can be served against a store that is not open, and a static mutex serialises the call against
React's double-mount.

The command never returns `Err`. `db::StartupOutcome` is a tagged union — `ready`,
`keychain-denied`, `keychain-unavailable`, `wrong-key`, `malformed-key`, `failed` — because *which
situation the user is in* is a decision, and it has to be made in Rust where the platform error
still exists rather than reconstructed from a flattened string in TypeScript. `secrets::classify`
makes that decision, reading the macOS `OSStatus` back out of the boxed platform error (`keyring`
maps both `errSecUserCanceled` and `errSecAuthFailed` to an undifferentiated `PlatformFailure`) and
matching Secret Service's "prompt was dismissed" against its D-Bus connection failures.

Denial and absence are separate screens, because they are separate situations: a user who clicked
Deny has a working keychain and a decision to revisit, and a user with no keyring daemon has
nothing to approve and needs the passphrase fallback instead. The fallback is offered on those two
outcomes only — after a *refusal* a passphrase would key a second, divergent database rather than
open the existing one.

**Standing lesson:** this shipped because the seam that mattered had no seam. `database_key` talked
to `Entry` directly and `open` talked to `database_key` directly, so "the keychain says no" was
unreachable from a test on any machine whose keychain says yes. Both now take their key source as
a parameter (`database_key_with`, `open_startup_at`), and the refusal cases are ordinary unit
tests: a denial creates no database file, an unreachable daemon is not reported as a denial, and a
malformed stored key returns without `set` ever being called — the never-regenerate rule asserted
rather than described.

**What remains, and it is small:** the passphrase path is reachable and works, but nothing records
that a given database is passphrase-keyed. A machine that later gains a keyring daemon will
generate a fresh keychain entry, fail to open its own passphrase-keyed file, and land on the
`wrong-key` screen (which does offer the passphrase, so it is recoverable — but the useless
keychain entry is left behind). Deriving with Argon2id as the core-schema spec names is also still
outstanding: SQLCipher's own PBKDF2-HMAC-SHA512 does the derivation today, which is a real KDF but
not the one written down.

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

One residual, deliberate:

- **Two houses whose names the registry does not know, claiming one number, cannot be told apart
  by name.** Their schemes still separate correctly when the ISINs resolve, and fail visibly when
  they do not. There is no third option that is not a guess.

The hole this fix left open — a shared number whose roster names only *one* house — and the
failure mode it introduced for an unclaimed row are both closed by the entry below.

### ~~A folio number shared with a house the roster never named~~ — FIXED

Resolved by `planFolio` in `src/ingestion/pdf/nsdl-ecas.ts`, which decides who the claimants of a
folio number are before any row is attributed, and may name a claimant the roster did not.

The previous fix scoped the roster's claims on (house, number), which handles a number the roster
prints **twice**. A number the roster prints **once** — because the second row's DP Name cell is
blank or lands outside the column — has one claimant, nothing to overwrite, and therefore merged
exactly as before: both houses' schemes attached to the single claimant, and `resolveAmc` handed the
account to whichever ISIN issuer prefix printed first. Same doubled units, different door.

**The rule, which is the design decision this needed.** The single-claimant path is also where a
*misnamed* house is deliberately merged, so the two have to be told apart:

- *Misnamed* — one real folio printed under a name that disagrees with its ISINs. Merging is
  correct: the ISIN decides the identity, `W_AMC_NAME_CONFLICT` reports the name, and the folio
  stays one account across every statement. Splitting it would fork one folio into two accounts,
  which is the defect the AMC registry exists to prevent.
- *Missed* — two real folios sharing a number, of which the roster captured one. Merging destroys
  units.

They are distinguishable, and the discriminator is on the rows: **count the registry houses the
number's scheme rows name.** Every scheme in a folio belongs to one house, so a misnaming is a name
disagreeing with an ISIN and its rows still name exactly one house; two houses among the rows is one
ISIN disagreeing with another, which one folio cannot produce. One house (or none Misal can name)
keeps the merge; two or more splits the number into one account per issuing house, keyed
`mf-folio:<registry id>:<folio>` — the same identity the registrar's own CAS produces — and reports
it as `W_FOLIO_NUMBER_SHARED`. Only *registry* houses are counted: an unrecognised issuer prefix is
evidence of a gap in the registry, not of a different house, and splitting on it would fork folios
whose prefix is merely unlisted.

**The unclaimed row's failure mode was reconsidered and changed.** The previous fix turned a scheme
row with no roster claim from a silent drop into an error, which is right for one stray row and
wrong for a whole file: a real eCAS whose roster geometry this parser reads differently contributes
*no* claims, and every mutual fund row in it would fail at once. So the fallback is gated the way
`emitDematPositions` gates its own, on whether the template has been observed working at all:

- **The roster claimed nothing anywhere in the document.** It is unread rather than silent about one
  number, and the rows are the only statement of identity the file makes. Each number is identified
  by its schemes' ISIN issuers — the same key a parsed roster would have produced, since the ISIN
  wins over the printed name anyway — and `W_FOLIO_NOT_IN_ROSTER` says so once for the document.
- **The roster claimed other numbers but not this one.** The roster demonstrably parsed, so a number
  it never mentions is an anomaly, most likely a misread folio cell. Minting an account from a
  misread number is worse than dropping the row, because the units reappear correctly numbered in
  the next statement and are then counted twice. The row still fails, as before.

Accounts now record which of the two produced them: `raw.amcFrom` is `roster` or `isin`, so the
review queue never shows a deduction as something the document printed.

Fixtures: `nsdlEcasMissedClaimantPages` in `src/ingestion/testing/corpus.ts` is the shared-number
statement with the SBI roster row's DP Name cell removed, and `nsdlEcasUnreadRosterPages` removes
both houses' name cells so the roster claims nothing. Against the previous parser the first yields
one account holding 310.400 units that are not its own, and the second fails every mutual fund row;
`nsdl-ecas.test.ts` also runs the registrar's own CAS behind the missed-claimant eCAS and finds two
account ids for one holding where there must be one.

Two residuals, both deliberate:

- **A row whose ISIN names no registry house, under a number that has been split, fails.** It cannot
  be assigned to either of the houses the split found, and inventing a third folio from a prefix the
  registry does not know is the guess this whole area exists to refuse.
- **A roster that names one house Misal cannot name, over a number whose rows name two it can,
  leaves an empty provisional account.** The statement declared that folio, so it is emitted; which
  of the two it was meant to be is not recoverable, and dropping a declared account to tidy the
  report would hide a roster the parser did not understand.

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

That consequence turned out to be the next defect. See below.

### ~~Two ways a statement's transactions were lost permanently, both from inferring re-importability~~ — FIXED

Found by adversarial review of the ingestion write path and reproduced against the real schema.
`ingest.rs::withheld_for_document` was the **only** thing that let a file back past the
content-hash short-circuit, and it inferred "this document still has rows that never landed" from
`unresolved_instrument` state that does not record that. Two triggers, one root cause, and both end
with `runImport` returning `already-imported` for a file whose rows are not in the ledger while the
screen says "No changes were made and no import was recorded, because nothing happened."

- **A shared entry, released by one document on behalf of all.** Migration 0006 permits one open
  entry per `(account_id, raw_identifier)` and it carries a single `last_seen_document_id`;
  `release_landed_rows` stamps `resolved_at` as soon as *any* document lands rows for it. January's
  and February's eCAS naming the same unmapped ISIN are therefore one entry: map it, re-import
  February, February's rows land, the entry closes, and `withheld_for_document('d-jan')` is zero.
  January's transactions for that fund can never be written again. Worse than it first looks — with
  N statements the single `last_seen` pointer means only the first and the last are named on the
  entry at all, so the months in between were never re-importable even once. Downstream, a ledger
  account then emits `FOLD_SNAPSHOT_MISMATCH` forever, blaming a disagreement whose real cause is
  the lockout.

- **A plugin that throws mid-document burns the hash.** The runner catches the throw and commits
  what was read, and the `source_document` carrying the content hash is written with it. The folios
  the parser never reached raised no unresolved rows, so the inference reports zero forever. The
  counters concealed it: `E_PLUGIN_CRASH` was explicitly excluded from `rows_failed`, so the run
  recorded `rows_failed: 0`, `status: 'completed'` and `read == committed` — an audit record
  indistinguishable from a clean import of the whole file, for half a statement. This also
  contradicted the pipeline's own header rule, which says a document that failed to be read writes
  no `source_document` precisely so the hash is not burned. Both CAS parsers are hand-written layout
  parsers over formats this repo's own drift canary says change year to year.

**Consequence while it stood:** the only recovery from either was deleting every account the import
created — and for a shared CAS, deleting one folio does not even free the hash (see below). The
transactions exist nowhere but in the file, `import_issue.raw_payload` cannot reconstruct them, and
Misal never copies the file.

Fixed by not inferring. Migration 0007 adds `import_run.outstanding_reason`, which each run writes
about its own pass over its own bytes: `'withheld'` when rows were held back and are still open,
`'crashed'` when the plugin threw, NULL when the document owes nothing. `commit_batch` derives it
from the batch after the queue has been updated — so an entry this import closed does not count, and
an entry the user dismissed never did — and clears it on that document's earlier runs, because the
pass that just finished is the current statement of what the document owes. `runImport` ORs it into
the stand-aside beside `withheldFor`. Dismissing the last open entry clears the `'withheld'` flag,
so a file the user asked not to be chased about goes back to being idempotent; a dismissal says
nothing about a crash, so it does not clear that one.

Two supporting changes. `release_landed_rows` is now scoped to entries the landing document is
actually named on — a document that never withheld those rows has no standing to say they have
landed. And the crash is counted in `rows_failed`, which in this schema's vocabulary is what makes
the run a partial import (`completed` with a non-zero `rows_failed`, as `ingest.rs`'s header states)
rather than a clean one.

Migration 0007 backfills, because a defaulted NULL would leave every already-locked-out document
exactly as stuck as before: the newest run of each file-backed document is marked from the entries
it is still named on, or — the January case — from its own `W_UNRESOLVED_INSTRUMENT` issues when the
entry it was withholding has been closed without the user having dismissed it.

**Two things deliberately not done, both outside this change's files.** A crashed run is not stamped
with a literal `partial` status: `ImportRunRow.status` in `src/ingestion/store.ts` is
`'running' | 'completed' | 'failed'` and migration 0001's CHECK matches it, so a fourth state is a
port change and a table rebuild, not a one-line one. It is spelled the way this codebase already
spells a partial import instead. And `import_run.parser_version` — recorded per migration 0001 "so a
statement can be reprocessed when a parser bug is fixed" — is still read by nothing: a parser bug
that produces *wrong* rows rather than throwing still does not reopen the file.

### ~~The flag that stopped statements being lost was cleared by the queue it was written to escape~~ — FIXED

`import_run.outstanding_reason` exists precisely because the shared unresolved queue cannot answer
for a single document. Two holes in the code added around it handed the question straight back to
that queue, and both ended exactly where the fix above began: a statement whose rows are not in the
ledger, answered `already-imported` forever, transactions nowhere but in the PDF.

- **The dismissal sweep was unscoped.** `ingest.rs::ignore_unresolved` cleared the flag with
  `UPDATE import_run SET outstanding_reason = NULL WHERE outstanding_reason = 'withheld' AND NOT
  EXISTS (…)` and `[]` as its parameters — naming neither the dismissed entry nor its document. Every
  dismissal re-derived the flag for every run in the database, from the shared queue. Take January
  and February sharing one entry: the user maps the ISIN and re-imports February, February's rows
  land, `release_landed_rows` stamps `resolved_at`, and January's re-importability now rests entirely
  on its `'withheld'` flag. The user then dismisses **a completely unrelated entry, in a different
  account, for a different fund**. January's run has no open entry naming it, the `NOT EXISTS`
  passes, the flag goes NULL, and January is gone. The existing regression test could not see this
  because it never dismissed anything.

- **Restore was not the inverse of dismiss.** `accounts.rs::restore_entry` ran one statement —
  `UPDATE unresolved_instrument SET ignored_at = NULL` — and never touched `import_run`. Nothing
  else in the system writes `outstanding_reason` except `record_outstanding_rows`, at commit time,
  so there was no path from "Put back" back to that column at all. Three monthly eCAS naming one
  unmapped ISIN, the entry carrying `source_document_id = d-jan` and `last_seen_document_id = d-mar`:
  the dismissal cleared all three runs, and pressing "Put back" locked February out **on the spot**,
  with no re-import involved — while the settings screen told the user the entry "is open again — its
  value was withheld the whole time it was dismissed, and still is", asserting a restoration that had
  not happened.

The sweep is now scoped to the documents the dismissed entry actually names, binding the entry's id
and mirroring the scoping `release_landed_rows` already applies; the `NOT EXISTS` clause stays,
because a document named on several entries is not settled by dismissing one of them. `restore_entry`
re-stamps `'withheld'` on the newest run of each document the entry names, skipping runs already
carrying `'crashed'` — a crash outranks a withholding — and documents that never came from a file.
Re-stamping is conservative by construction: a flag set where nothing is owed costs one no-op
re-import, which recomputes and clears it, while a flag missing where rows are owed costs the
statement. The settings copy now says what actually happens to the statements as well as to the
value.

Migration 0008 repairs databases the sweep has already run against, by re-deriving the flag with
migration 0007's own backfill rule. Neither code fix can reach them: the flag is gone, nothing else
recomputes it, and the rows exist nowhere but in the files.

### ~~A dismissed queue entry stripped every later statement of its re-import flag~~ — FIXED

The third entrance to the lockout above, and the widest: it needs no second document sharing an
entry and no crashing plugin, only the button the import report puts in front of the user.

`record_outstanding_rows` derived the `'withheld'` half of `import_run.outstanding_reason` from
`withheld_for_document`, which filters `ignored_at IS NULL`. Migration 0006 permits one open entry
per `(account_id, raw_identifier)`, and `record_unresolved`'s guarded INSERT tests only
`resolved_at IS NULL` — so a dismissed entry silently absorbed each new statement's sighting,
advancing its `last_seen_document_id`, while raising nothing the count could see.

**Consequence:** import January's eCAS naming an unmapped ISIN, press "Dismiss for now", then import
February and March. All three runs commit with `outstanding_reason = NULL`, so `runImport` answers
`already-imported` for all three, forever, and February's rows can never be landed. Neither reversal
path repairs it: `map_unresolved` never touches `import_run`, and `restore_entry` re-stamps only the
two documents the entry names as source and last-seen. The rows exist nowhere else — no `txn` rows
were written, `import_issue.raw_payload` cannot reconstruct a CAS row, and Misal never copies the
file. Twelve monthly statements lose the ten in the middle. `ImportReview.tsx` meanwhile tells the
user to "Import this file again after mapping to release them", which `runImport` then refuses.

Fixed by separating the two questions instead of by teaching one of them about the other.
`withheld_for_document` is unchanged — it is the *queue's* figure, which the review queue and the
import report read, and dismissal genuinely does belong in it. `record_outstanding_rows` now counts
through `unlanded_for_document`, which is the same population minus the `ignored_at` clause: a
dismissal is an answer about being asked, and only `resolved_at` — "the rows are in the ledger" —
can retire a document's debt. The alternative fix, having `record_unresolved` stamp the new
document's debt as it advances `last_seen_document_id` onto a dismissed entry, would have put queue
bookkeeping in the business of writing `import_run`, which is precisely the entanglement that
produced the two defects above.

The dismissal path keeps working because it never depended on the commit-time count:
`ignore_unresolved` clears the flag itself, then and there, over the documents the dismissed entry
names. A dismissal is therefore a decision with a date and a scope rather than a filter every later
import silently inherits.

**Standing lesson, and it is about the fixture ordering rather than its shape.** Every dismissal
test in the suite — three in `ingest.rs`, four in `accounts.rs` — dismissed *after* every statement
had been imported, which is the safe direction and the one `ignore_unresolved`'s own comment reasons
about. Nothing anywhere imported a statement *while a dismissal stood*. The new test does, and finds
`outstanding_reason = NULL` on February's run against the old code.

Migration 0009 repairs databases the defect has already run in, because none of the above can reach
one. It is 0008's rule with a single clause changed: a dismissal that came *after* a run answers for
it, and a dismissal that came *before* it cannot have spoken about rows it had not yet seen.

### ~~Rows that landed without the user mapping anything never closed their queue entry~~ — FIXED

`release_landed_rows` required `mapped_at IS NOT NULL AND resolved_instrument_id IS NOT NULL`, both
written only by `map_unresolved`. An identifier can become resolvable without anybody clicking
anything about it, and then the rows land while the entry stays open.

The trigger is a scheme mismatch, and it needs no unusual data. A tradebook row whose ISIN cell was
blank — `csv-plugin.ts` drops a blank cell — is queued under `nse:SYM`, because the exchange symbol
is then the strongest identifier the row printed. The user maps a *different* entry, keyed
`isin:INE…`, raised by another statement; re-reading that statement lands its row and writes the
`nse:SYM` alias `aliasesProvenBy` derives from an ISIN and a symbol printed side by side.
Re-importing the tradebook now resolves off that alias and lands its rows — but its entry is matched
on the exact `raw_identifier`, so the mapping never claimed it and `mapped_at` is still NULL.

**Consequence:** `withheld_for_document` stays 1, the review queue goes on asking about an instrument
that resolves, `outstanding_reason` is re-stamped `'withheld'` on every further pass so the file is
never idempotent again, and the dashboard prints rupees as withheld from totals they are already
inside. That is double-counting in the one figure this codebase documents as existing to be believed
literally — the same class of error as the folio doubling, arriving through the queue instead of
through the identity key.

Deleting the `mapped_at` predicate alone changes nothing, because both `EXISTS` subqueries join on
`resolved_instrument_id`, which is mapping-only as well. So the release now asks the question the
pipeline itself asks: *what does this identifier name today?* `resolves_now` walks the same ladder
`resolveInstrument` walks — ISIN against `instrument.isin` and then the alias table, AMFI code,
exchange symbol, provider-scoped local code — reusing `alias_for_identifier` so the two cannot
drift. A mapping still wins where there is one: it is the user's own answer and may name an
instrument no alias reaches.

**The release moved earlier in `commit_batch`, and that order is now load-bearing.** One pass can
prove an alias and withhold a row under it: the row printing both identifiers resolves and teaches
`nse:SYM`, while the row whose ISIN cell was blank was read before that alias existed and is queued
under exactly that identifier. Releasing after the queue has been updated would find the first row's
transaction sitting under the instrument the entry now resolves to and close an entry whose own rows
are not in the ledger — deleting a disclosure about missing money, which is the failure this whole
area exists to prevent. Reading the queue as it stood before the pass asks the only answerable
question: did rows land for something this document was *already* withholding? Both directions are
tested.

**A second live instance of the same class, fixed in the same pass.** The exchange sync
(`sync.rs`) called `record_unresolved` from four places in `runner.ts` and `release_landed_rows` from
none, so a crypto asset the seed catalogue learned later went on being disclosed forever — and
unlike a statement there is no file to re-import, so nothing could ever end it. `commit_positions`
and `commit_transactions` now release, scoped to the account rather than to the document:
a sync page's content hash is its response body, so every sweep mints a fresh `source_document` and
the document that queued the coin is never the one that lands it. Widening the scope is sound there
for the reason `commit_positions` already states about the same rows — an exchange account is fed by
this sync and nothing else, and a sweep writes the whole asset set for one `as_of` or none of it.

**Two residuals, both outside this change.**

- **A shared entry still only names two documents**, its first sighting and its last, so with a year
  of monthly statements the months in between cannot close it even after their rows land. Their own
  `outstanding_reason` is cleared correctly once the entry is closed by a document it does name, so
  nothing is locked out; what remains is that the *order* of re-imports decides how long the entry
  keeps disclosing. Closing that needs a per-document record of what was withheld, which is a schema
  change rather than a predicate change.
- **Mapping an exchange asset still writes no alias.** `record_unresolved` in `sync.rs` writes a bare
  asset code with no scheme prefix, `alias_for_identifier` yields nothing for it, and so
  `resolveAsset` cannot see the user's answer on the next sweep — the entry is answered in the queue
  and the balance goes on failing to resolve. The release path handles it (a mapped entry closes when
  rows land under the instrument the user chose), but nothing makes those rows land. The fix is for
  `map_unresolved` to write a `provider-local` alias for a scheme-less identifier, which is a change
  to the mapping path and to what `MappingScope::Account` means.

### ~~Two positions in one import annihilated each other in silence~~ — FIXED

`planPositions` in `src/ingestion/pipeline.ts` decided insert/restate/duplicate purely from
`deps.store.findPosition`, which reads the database — and every write in the pipeline is buffered
until the batch ships, so the planner was blind to rows it had planned moments earlier. Two source
rows resolving to the same `(accountId, instrumentId, asOf)` were both planned as `insert`, and
`commit_batch`'s `ON CONFLICT … DO UPDATE SET quantity = excluded.quantity` kept whichever landed
last.

The asymmetry gave it away: `reconcile.ts` has kept a `seenInDocument` map for transactions since
`txn.occurrence` was added, and emits `W_DUPLICATE_IN_DOCUMENT` from it. Positions had no equivalent.

**Consequence while it stood:** a plugin emitting two positions for one ISIN at the same `asOf` —
100 units then 40 — yielded `counters: {read: 2, committed: 2, duplicate: 0, failed: 0}`, `issues:
[]`, and one stored row of 40. A hundred units gone, no warning, and `rows_committed` claiming both
had landed. `MemoryStore.upsertPosition` replaces in place exactly as SQLite does, so the store the
whole suite runs against could not catch it either.

`planPositions` now keeps its own seen-set keyed on `${accountId}|${instrumentId}|${asOf}`. A repeat
is not written — one date carries one holding, and unlike a transaction there is no occurrence
counter to admit it under — so the figure the file states first is the one that stands, and the
repeat raises `W_DUPLICATE_IN_DOCUMENT` naming both quantities. Which of the two is correct is not
knowable in the pipeline: two folios of one scheme under one account would have to be summed and a
double-read must not be, so it states what it saw and guesses nothing. The repeat counts as
`skipped` rather than `committed`, because it was read and deliberately not written.

### ~~Mapping one queue entry claimed every entry printing the same string~~ — FIXED

`ingest.rs::map_unresolved` scoped its alias write correctly and then ran
`UPDATE unresolved_instrument … WHERE raw_identifier = ?3 AND resolved_at IS NULL` — no account and
no provider — twenty lines after computing the discriminator it needed.

`rawIdentifierOf` falls through to `provider-local:<code>` and `name:<name>`, and neither is global.
Migration 0001 says why in as many words: the alias table's composite key exists to keep E*TRADE's
`INFY` away from Zerodha's `INFY`. The exchange sync is worse — `sync.rs::record_unresolved` writes
a bare asset code with no scheme prefix at all, so the mapping writes no alias and the unscoped
UPDATE was its entire effect.

**Consequence while it stood:** naming one broker's holding silently claimed another broker's,
unrecoverably. The collaterally claimed entry left the mapping UI, because
`unresolved_for_document` filters `mapped_at IS NULL`; `dismiss_entry` refused it for the same
reason; `record_unresolved` never clears `mapped_at`, so re-importing did not reopen it; and the
settings review queue printed "Named as \<the other broker's instrument\> on \<date\>" — a dated
claim the user never made, about a security they never chose.

The update now takes the reach the identifier has, decided by the same discriminator the alias write
uses: a global scheme (`isin`, `amfi`, `nse`, `bse`, `ticker`) answers in every account exactly as
before; `provider-local:` answers within that provider; and an identifier that yields no alias at
all — `name:`, and the exchange sync's bare codes — answers only in the account it was asked about.

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

### ~~Cross-account corporate-action check keys on ex-date alone~~ — FIXED

Fixed by matching on the action's identity rather than on its exact date. `derivePortfolioPositions`
in `src/valuation/positions.ts` now treats another account's action as already recorded when the
kind matches, the multiplier matches where both carry one, and the two dates are within
`ACTION_MATCH_WINDOW_DAYS` (seven) of each other.

The window exists because one market-wide split has one ex-date but not one printed date:
registrars, brokers and depositories variously print the ex-date, the record date, the credit date
or the date the entry was posted, and a day or two between two statements is ordinary. A week
absorbs that and is far narrower than the gap between two genuine actions on the same instrument.

The symmetry is what made the original so damaging: neither account could see the other's action, so
*both* were downgraded, and the more places a user holds the same stock the more certain it was to
fire. The failing case is now a regression test, asserting both accounts stay `measured`.

**Not weakened.** The multiplier must agree, so an account recording 5-for-1 against another's
2-for-1 is still a real disagreement and both are still downgraded; an account with no action row at
all still matches nothing and is still downgraded; and two genuine 5-for-1 splits eight months apart
are still two events, so the account missing one is still downgraded. All three are tested.

Dates in the warning are also deduplicated now: three other accounts recording one split is one
missing action, and printing the date three times read as three separate problems.

### ~~Missing arithmetic helpers live in the wrong layer~~ — FIXED

`powDec`, `roundDec` and `mulDivMinor` have moved from `src/valuation/arithmetic.ts` to
`src/domain/numeric.ts`, with their tests, and every importer now takes them from `@domain/numeric`.

Two behaviours changed with the move, both deliberate. They throw `NumericError` rather than
`ValuationAssertionError`, which is correct once they are no longer part of the valuation engine.
And `powDec` returns through `fromDecimal`, whose `toFixed()` already prints in normal notation, so
the hand-written exponential expansion these functions used is no longer on their path — the
existing assertion that `0.1 ** 45` comes back as a canonical decimal string rather than `1e-45`
moved across unchanged and still passes.

What stays in `src/valuation/arithmetic.ts` is what is genuinely the engine's: `scaleToInteger`,
`commonScale`, `decimalPlaces`, `truncDec`, `decFromCount`, `tenPow` and `tenPowNegative`.

### ~~`NotMeasuredReason` has no member for a blocked grandfathering FMV~~ — FIXED

`no_grandfathering_fmv` is now a member of `NotMeasuredReason`, reading "no 31 January 2018 market
value on record", and `reasonFor` in `src/valuation/tax.ts` maps `GRANDFATHER_FMV_UNAVAILABLE` onto
it instead of onto `unknown_tax_regime`.

The two send the user to different places, which is the whole point: `unknown_tax_regime` asks them
to classify a scheme, and for a blocked FMV the scheme is already classified — it is listed Indian
equity under section 112A, the rule is known, and one specific historical price is missing. Reporting
it as an unknown regime named a problem the user did not have and never asked for the single input
that would restore the figure.

**Crosses a directory boundary by one line.** `HEADLINE` in `src/ui/measured/Metric.tsx` is a
`Record<NotMeasuredReason, string>`, so adding a member to the union is a compile error until that
record gains the key. The addition there is the one required key and nothing else.

### ~~`BONUS_UNITS_MISMATCH` is unreachable~~ — FIXED by deletion

Deleted. The code is gone from the warning vocabulary in `src/valuation/types.ts`, and
`src/valuation/types.test.ts` asserts it stays gone.

It was deleted rather than made reachable because it cannot be made reachable from data that is
present. A `bonus` transaction row carries the units credited and nothing else — `TxnRow.quantity`
is documented as exactly that — and a cross-check needs a second, independently sourced figure to
compare it against. Deriving the expected units from the holding on the record date and a ratio is
only as good as the ratio, and the ratio is what is missing; deriving it from the holding alone
would be checking the number against itself.

**What storing the ratio would take**, if it is ever wanted:

1. A migration adding the declared ratio to the transaction row — the natural shape is two integer
   columns, `bonus_ratio_new` and `bonus_ratio_held` (a 1:2 issue is `1` and `2`), rather than one
   decimal, so that 1:3 does not become `0.333…` and lose exactness. Owned by whoever owns
   migrations; nothing in this subsystem can add it.
2. Ingestion filling them, which means finding the ratio in each source's narration text and
   parsing it — a text-extraction change with its own redacted-fixture corpus, per adapter. A row
   whose ratio could not be read must stay null rather than be guessed, so the check has to be
   per-row optional and cannot become a portfolio-wide guarantee.
3. `natural_key` deciding whether the ratio participates. It should not: the same allotment
   re-imported from a statement that omits the ratio must not become a second transaction.
4. Only then a check in the fold: expected units are the holding on the record date times
   `new / held`, and the record date is a fifth thing nothing currently stores — the transaction
   date is the credit date, which is not the same day.

Until all of that exists, an unreachable check is worse than none, because the interface shows the
absence of the warning as the check having passed.

`docs/specs/2026-08-12-valuation-engine.md` still describes the check, conditioned on the source
"letting us derive a ratio". No source does, and the spec is left as written because it is the
record of the branch that produced it; this entry is where the two diverge.

### ~~Twelve Data rate limiting is incomplete~~ — FIXED

The binding constraint turned out not to be request *rate* at all. Twelve Data charges **one credit
per symbol**, including symbols batched into a single `/quote` call, against eight credits a
minute — so a twenty-holding portfolio spent twenty credits in one request and was refused
outright. No amount of pausing between requests would have helped, because there was only ever one
request.

Fixed in two halves, and only the second is a refusal:

- **The minute window.** `MinuteWindow` in `src/valuation/price/twelvedata.ts` is a sliding
  sixty-second ledger of credits spent, and `fetchLatest` now splits a batch into chunks of at most
  `perMinute` symbols and paces them against it. Deliberately not a token bucket: the limit is "no
  more than eight in any sixty seconds", and a bucket that refilled smoothly would let a burst of
  four land twice inside one window. Waiting here is self-restraint rather than a retry — nothing
  has said no yet — and it is capped at `TWELVE_DATA_MAX_PACING_WAIT_MS`, past which the honest
  answer to a watching user is a refusal rather than a progress bar that appears to have hung.
- **The stand-down.** A 429, whether it arrives as an HTTP status or as `code: 429` inside a 200
  body, blocks every further request in the run locally, without a call, and the interval doubles
  with each refusal up to `TWELVE_DATA_MAX_STAND_DOWN_MS`. Nothing is retried inside it. This is
  the rule `yahoo.ts` already stated for its own 429, now held by both keyed and keyless
  providers.

`fetchHistory` and `fetchFx` draw on the same window and honour the same stand-down. One latent
bug was closed on the way past: `fetchHistory` called `JSON.parse` outside its own `try`, so an
HTML error page — exactly what a 429 or an edge block returns — escaped as an exception through a
method whose contract is to return a result.

**Residual, deliberate:** the window lives on the provider instance, which lives for one refresh.
Across refreshes the TTL gate is what stands between the user and the provider. A window that
survived a restart needs the same persistent store the daily credit budget is still waiting for,
and that store is the blocker for both.

### ~~An intraday quote was stored as the day's close~~ — FIXED

`meta.regularMarketPrice` during an open session is a live quote. It was written dated today into
`price`, whose one row per `(instrument, as_of)` **is** the close and is read as one by every
historical calculation downstream. A user who refreshed at 11:00 IST and never again left an 11:00
print on record as that day's closing price permanently — and nothing later could tell it from a
real close in order to replace it, because the row says only what it says.

**Not fixed by fabricating anything.** The reading is returned intact, flagged
`QuoteResult.intraday`, and simply not written; `RefreshReport.intradayHeld` carries the
instruments, and `refresh.ts` raises an `INTRADAY_QUOTE` note saying the last close is still shown
and today's will be stored after the bell. `chartPreviousClose` is a real close and rides along
beside the quote, but it is deliberately not promoted into `price`: the response says which
*value* the previous close is and never which *day* it belongs to, and a close filed under a
guessed date is the same defect one square along.

Detection was the part that needed research rather than judgement, and two obvious approaches are
wrong:

- **There is no `marketState` in the v8 chart meta.** It belongs to `/v7/finance/quote`, which the
  host allowlist deliberately does not admit. What the chart does carry, on every response checked
  including the FX pairs, is `currentTradingPeriod.regular` as a `{start, end}` pair of epoch
  seconds.
- **The comparison must be against the clock, not against `regularMarketTime`.** The tempting
  test — is the last print inside the session window — fails in the direction that matters: an NSE
  line whose final regular trade printed at 15:29:58 keeps that stamp all evening, so it would look
  intraday forever and its close would never be stored at all. `sessionIsOpen` therefore asks
  whether *now* is before the session's end, which is also correct whether Yahoo reports the
  session that just ended or the one about to start.

An absent `currentTradingPeriod` is read as settled rather than open. That is the recoverable
direction: a row written for today is replaced by the next refresh after the close, while a close
wrongly withheld can never be recovered from anywhere.

Twelve Data states the same fact outright as `is_market_open`, and is now read for it. AMFI and
CoinGecko declare `intraday: false` at the call site with the reason: a NAV is struck once after
the close, and crypto has no session to be inside — withholding those would leave two asset
classes permanently unpriced.

**Residual:** the flag is not persisted, because it cannot be. `price.source` has a CHECK
constraint in migration 0001 and there is no column for provisional rows, so "stored
distinguishably" was not available from this branch's directories; not storing it was. A database
that already holds intraday prints written before this fix is not repaired — nothing in the row
identifies it as one.

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

~~**Residual, deliberate:** the bound only becomes visible when the engine values a portfolio. An FX
rate whose age is between a failed refresh and the bound is still not reflected in `priceAge` or
`stalePriceCount`, which count price age alone.~~ — **FIXED**, see below.

### ~~FX age was invisible below the seven-day bound~~ — FIXED

The residual left by the entry above, and it was the quieter half of the same defect. Above
`MAX_FX_LATEST_AGE_DAYS` the holding leaves net worth and is warned about; *below* it the
conversion happens and nothing said how old the rate was. A week-old **price** was counted in
`stalePriceCount`, hatched, and named on the dashboard; a week-old **rate** moved every foreign
total by whatever the currency had done in that week, in silence.

- `fxRateAge` in `src/valuation/price/staleness.ts` returns the same shape as `priceAge` for the
  other factor every foreign holding is multiplied by, with its own calendar-day thresholds:
  stale after `FX_STALE_AFTER_DAYS` (3, a long weekend, the whole of the ordinary slack in a daily
  feed) and very stale after `FX_VERY_STALE_AFTER_DAYS` (5, by which point a run of refreshes has
  failed and the user should be told *before* the holding disappears rather than when it does).
- `src/screens/view-model.ts` asks it only about currencies actually held, and only through
  `FxTable.latest` — the same read `valueFromRows` converts through — so what is reported is the
  age of the number in the total rather than the age of the newest row in the table. A position's
  `staleDays` and `priceNote` now take the staler of price age and rate age, because the figure on
  screen is no fresher than its oldest input, and `dataQuality.stalePrices` counts stale rates
  beside stale prices, one per currency rather than one per holding.

**Scope, stated so it is not overstated:** `stalePriceCount` inside
`src/valuation/portfolio.ts` still counts price age alone. The addition is made where the
view-model assembles the indicator, because that file was outside this branch's directories. An
engine-level caller that reads `coverage.stalePriceCount` directly still sees the price-only
figure.

### ~~A sale's negative amount was used verbatim as gross consideration~~ — FIXED

The fold normalised the sign of a disposal's **quantity** and not the sign of the **amount on the
same row**. `magnitude` in `src/valuation/fold.ts` carries a comment saying exactly why the quantity
needs it — "ingestion adapters disagree about whether a sale is recorded as -10 or 10" — and the
money one line below it was read as printed.

A CAMS/KFintech CAS prints a redemption as units `(150.000)` and amount `(10,000.00)`.
`canonicalDecimal` makes both negative, `normalizeTransaction` passes the amount through with its
sign — `src/ingestion/pdf/cams-kfin-cas.test.ts` pins `amountMinor === '-1000000'` as *correct* —
and `src/data/portfolio.ts` maps it straight through. So a negative gross for a sale is a
legitimate state of the store produced by the primary parser, not a corruption.

**Consequence, measured:** 300 units bought for ₹18,000 and 150 redeemed for ₹10,000 produced
`grossConsiderationMinor: '-1000000'` against `costMinor: '900000'`, and therefore
`gain: { measured: true, value: '-1900000' }` — a realised long-term **loss of ₹19,000 where the
truth is a ₹1,000 gain**, flagged `measured` with full coverage. The same row reached
`buildCashflows`, where ₹10,000 leaving the investment was booked as ₹10,000 entering it, and XIRR
came back **−29.76% on a portfolio that was up**. Nothing in the honesty machinery could see any of
it: a signed number is not a missing one, so no metric was withheld and no reason was shown. Open
lots, quantities and net worth were never affected — only realised P&L and returns.

Fixed by applying `magnitude`'s reasoning to the money. `magnitudeMinor` in
`src/valuation/arithmetic.ts` is the single statement of the rule, and every amount now goes through
it: `grossOf`, `unitConsiderationOf`, `purchaseCost`, the transfer-expense apportionment and the
income accumulators in `fold.ts`, and every branch of `buildCashflows` in `xirr.ts` (which also
takes `absDec` of the quantity in the two branches that price a transfer). Direction comes from
`txn.type` throughout, which is where it belongs and where it already was for quantities.

**The actual defect was the missing fixture.** Every `sell` in the engine's tests was written with a
positive amount, so the engine had never been exercised against the sign convention its own primary
parser produces — which is why this survived a fold with property tests, a golden worked example and
1,245 passing tests. `casRedemption` in `src/valuation/__fixtures__/build.ts` now builds a sale the
way a CAS records one, negating both columns itself so a test cannot accidentally write the
convention it is meant to be testing against, and the reviewers' scenario is a test in
`fold.test.ts` and another in `xirr.test.ts`.

### ~~Realised gains were computed in the transaction's currency and summed as paise~~ — FIXED

`gainMinor = gross − transferExpenses − deemedCost` in `src/valuation/tax.ts`, where all three were
minor units of `consumption.currency` — copied from `txn.currency` by the fold. `tax.ts` imported no
FX service, `Disposal` and `RegimeSummary` carried no currency, `summariseRealised` accumulated with
`addMinor`, and the screens sum every regime and render the total as INR.

`us_equity` maps to `foreign_equity` automatically, so **no user classification was needed for this
to fire**: it fired for anyone holding a US share who sold any of it.

**Consequence, measured:** 20 AAPL bought at $100 and 10 sold at $200 gave `ltcgMinor === '100000'`
inside a snapshot whose net worth is INR paise, so the dashboard printed **₹1,000 where the truth is
about ₹87,000** — understated roughly eighty-sevenfold, and netted against genuine rupee gains in
the same sum. Fully `measured`, full coverage, no reason shown. The neighbouring paths convert
deliberately — `costInInr` uses each lot's acquisition-date rate, `xirr.ts` converts every cashflow
— so this was an omission rather than a convention.

Fixed by converting at the point of computation. `classifyDisposal` now takes an `FxService` (not
optional: a caller who forgets gets a compile error) and resolves the disposal-date rate *first*,
before the regime, the cost or anything else it might report, because without a rate no figure it
returns can be stated at all — not even the gross consideration a withheld disposal carries for
coverage. Gross, transfer expenses and cost are converted individually and the subtraction happens
in INR, so `gain === gross − expenses − deemed cost` holds exactly in the units reported. The
grandfathering comparison stays in the native currency, where the 31-January-2018 FMV lives; only
the resulting deemed cost is converted. `Disposal` states `currency: 'INR'` and the `fxRate` that
made it so, and `RealisedGains` states its own currency too.

**A missing rate withholds the disposal.** It returns `NO_FX_RATE` / `no_fx_rate` with every money
field at zero rather than emitting the raw-currency number as a consolation figure — an unconverted
`200000` would be read as ₹2,000 by everything downstream.

**What remains, stated so it is not mistaken for settled.** Both legs of a realised gain are now
converted at the *disposal-date* rate, so the realised figure carries no currency return between
acquisition and disposal — while unrealised P&L, through `costInInr`, deliberately does carry one by
converting cost at each lot's acquisition-date rate. The two are answering different questions (one
is a reporting bucket for a tax schedule, the other is economic P&L on an open holding) and the
single-rate form is the one an Indian return wants, but the asymmetry is real and undocumented
anywhere else. Related: `LotConsumption.currency` is the *disposal's* currency and is used to
interpret the lot's cost as well, so a lot acquired in one currency and sold on a row recorded in
another would be converted through the wrong one. No importer produces that today; making it
impossible means carrying the lot's own currency into `LotConsumption`.

`dividendIncomeMinor`, `interestIncomeMinor` and `tdsCreditMinor` accumulated identically and were
latent only because nothing displays them yet; they had the same treatment. `IncomeTotals` in
`fold.ts` now carries the income rows themselves (`events`, with each row's date, currency and
stored rate) because a total has already thrown away what a conversion needs, and its scalar fields
are documented as transaction-currency and not to be summed across pairs. `valuePortfolio` converts
each row at its own date — preferring the rate on the row, as `xirr.ts` and `costInInr` do — and the
three figures are now `Measured<Minor>`, so one unconvertible row withholds the total instead of
contributing to it. Withholding the whole figure rather than the unconvertible part is deliberate: a
partial sum labelled "dividend income" reads as the total.

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

A second review of the same files found three more of exactly that shape — the monthly chart's
unrewound FX, its partially priced columns, and the withheld-value disclosure's ₹0 — fixed on
`fix/chart-and-withheld` and recorded at the end of this section. The shape is now a pattern rather
than a coincidence: **the state that exposes each of these is the state where a source says
nothing**, and a fixture corpus assembled from working data never reaches it.

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
~~`refresh.ts` fetches only `'latest'` and `FxTable.on` backfills three days, so a vest older than
the stored rates still returns `MISSING_FX`.~~ Historical FX fetching now exists; see below.

### ~~No historical FX, so old foreign transactions could never be valued~~ — FIXED

`refresh.ts` asked for `'latest'` and nothing else, and `FxTable.on` reaches back three days, so
the oldest rate in the table was whenever the user first opened the application. A 2019 RSU vest
therefore returned `MISSING_FX` forever — and because XIRR is solved over a whole scope at once,
that one undatable row withheld the figure for every rupee holding beside it, permanently, with no
action available to the user.

`backfillFxHistory` in `src/data/refresh.ts` now runs alongside the ordinary refresh, through
`PriceProvider.fetchFxHistory` — implemented against Yahoo's `USDINR=X` chart endpoint with
`period1`/`period2`, which is the same host and the same `/v8/finance/` prefix the allowlist in
`src-tauri/src/http.rs` already admits, and against Twelve Data's `time_series` for a keyed user.

What the response actually looks like, checked rather than assumed:

- Daily FX bars are stamped at **midnight UTC** under a `Europe/London` currency pseudo-exchange,
  so dating them by the meta's own timezone lands on the right calendar day in both GMT and BST.
- **There is no bar for a weekend or a holiday.** 1–8 January 2019 comes back as six rows, not
  eight. A gap in the series is a gap in the market, and it is left as one.
- The closes carry Yahoo's float32 rounding exactly as the equity candles do — a rate that was
  69.71 arrives as `69.70999908447266`. It is stored as sent, for the reason `parseChartHistory`
  already gives: rounding it back would usually recover the published figure and would
  occasionally invent one.

Three rules, the same three the price path holds itself to:

- **Only dates that are needed.** Derived from the transactions themselves — foreign currency,
  no per-row `fx_rate`, local date, exactly as `buildCashflows` derives them — minus everything the
  stored table can already answer. A portfolio with no foreign history makes no request at all.
  Needed dates are clustered into spans so one request covers many, and the span opens
  `MAX_FX_BACKFILL_DAYS` early so a vest that fell on a weekend can still be answered by the last
  rate published before it.
- **Only rates that were fetched.** One row is written per date asked about: the last rate
  published on or before it, which is precisely the row `FxTable.on` will pick when the date is
  read back. The rest of the span came back in the same response and is not stored — that is what
  keeps "fetch what is needed" from becoming "fetch a decade". A date with no usable rate gets no
  row, never the next rate along.
- **A refusal is reported, not retried.** The first rate-limited or offline span ends the pass, and
  `MAX_FX_HISTORY_REQUESTS` caps how much of a backlog one refresh will work through; what is left
  is named in an `FX_HISTORY_INCOMPLETE` note and picked up next time, so a large backfill finishes
  over a few runs instead of stalling one.

### ~~A crypto quote currency was cast to `CurrencyCode` and starved the FX backfill~~ — FIXED

`neededFxDates` in `src/data/refresh.ts` opened with `const currency = txn.currency as CurrencyCode`
over every transaction in the table. Exchange fills are not fiat: migration 0002 reserves the `X:`
namespace for a non-fiat quote currency, so a Binance `BTCUSDT` fill is stored as `X:USDT`. The cast
asserted otherwise, the row passed both guards, `FxTable.on` had no such bucket to answer it from,
and every fill date accumulated under an `X:USDT` key. `fxSymbolFor` renders that as `X:USDTINR=X`,
which Yahoo's symbol pattern rejects locally — so no request ever left the machine — but the slot
was counted *before* the call, so each cluster still spent one of the eight per-refresh backfill
slots. Nothing was stored, so the identical dates were re-derived on every subsequent refresh.

**Consequence:** twelve crypto fills across 2021–2023 plus one USD transaction produced eight
`NO_PRICE_SOURCE` notes for `X:USDT/INR` and an `FX_HISTORY_INCOMPLETE` note listing the real
`USD/INR` range that was never reached. Because `list_transactions` orders by `occurred_at`, a user
whose earliest transaction is a crypto fill starved the genuine USD backfill *indefinitely* — which
recreates, in full, the failure the entry above was written to fix. The advice attached to the note
("add an exchange or ticker alias") is unactionable for a pair that cannot exist.

Fixed by skipping `isNonFiatCurrency(txn.currency)` — the helper already in `src/data/portfolio.ts`,
until now imported by nothing — and by narrowing what remains through `currencyCode` instead of
asserting it. `portfolio.ts` holds the same boundary with `requireCurrency`, which throws; a refresh
cannot throw over one row without taking every unrelated price down with it, so it skips instead.
Either way the boundary is *crossed*, which is the thing a cast never does. The same cast at the
price-seeding site got the same treatment: a stored price in a currency nothing can convert must not
be allowed to report an instrument as freshly priced and suppress the fetch of one that can be.

`requests += 1` now runs *after* the call and not at all for `NOT_SUPPORTED`, which is decided
locally. A budget on requests must be spendable only by requests. With the cast gone no fiat pair
can reach that branch, so this half is defensive and has no test of its own; reverting only the cast
leaves the crypto notes but no longer starves the USD range, and reverting both reproduces the
original starvation exactly.

**Standing lesson:** `as` at a data boundary is not a type annotation, it is a claim about the
database. The identical claim on the identical column threw a `MappingError` twenty files away, and
this path chose to believe it instead.

### ~~The coverage meter stated a percentage for a figure that was never computed~~ — FIXED

`ReadoutCell.tsx` rendered the meter on `state === 'ready' && props.meter !== undefined`, never
consulting `props.value.measured`. `Dashboard.tsx` always passes `meter={{ pct: readout.xirrMeterPct }}`,
and that percentage comes from pair *eligibility* (`valuation/portfolio.ts`), never from whether the
solve ran. `xirrForScope` refuses a partial XIRR by design, so a single unpriced ledger holding
withholds the whole figure while the percentage stands undisturbed.

**Consequence:** the cell read "Not priced / no price available", then "Excludes ₹5,53,950 of net
worth", then a bar labelled "Coverage 56.6 percent of portfolio value" — a completeness figure for
an answer that does not exist. In the variant where the unpriced pair contributes to neither the
numerator nor the denominator the bar reads exactly **100.0%**, the one value this product documents
as meaning "complete". The same held on `NOT_CONVERGED`, on `NO_SIGN_CHANGE` and on the `unstable`
branch — which every user meets in their first 90 days.

**Why the honesty suite could not see it:** `assertHonest` only ever asked whether a *figure* states
its coverage. H2 skips elements carrying `data-not-measured`, and the meter was a bare
`[data-coverage-meter]` div with no metric attributes at all, so the walk went straight past it.

Fixed on both sides. `ReadoutCell` draws the bar only when the figure exists — a coverage is a
coverage *of* something, and the coverage *line* below it still states what was excluded, which is
the half H2 actually requires. `CoverageMeter` now carries `data-metric`, `data-scope` and the
metric's own coverage attributes, so the bar is part of its cell rather than loose geometry.

And the invariant was strengthened rather than the one site patched: `honestyViolations` now asks
the question in reverse — does a drawn coverage have a measured metric to travel with? The rule is
attached to `[data-coverage-meter]`, so any component that draws a meter inherits it, and a meter
inside a metric cell that does not name its metric is itself a violation, because a bar nobody can
bind cannot be shown to be honest. The scope it is judged within is the cell or row, not the panel,
so a design specimen in the gallery is not blamed for a withheld metric elsewhere on the page.

**Standing lesson:** the eligibility percentage and the figure are computed by different code with
different rules, and nothing made them agree. Every honesty invariant so far has been about a figure
stating its coverage; this was the first about a coverage stating its figure, and the suite had no
opinion about that direction at all.

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

### ~~The twelve-month chart rewound everything except the exchange rate~~ — FIXED

`rowsAsAt` in `src/screens/view-model.ts` filtered `transactions`, `positions` and `prices` to
`<= monthEnd` and spread `...rows` for the rest, so `fxRates` still held every rate up to today.
`FxTable.latest` returns the newest row it holds, and its staleness guard is deliberately one-sided
— a rate dated *after* the valuation date is not stale, because a provider quoting ahead of IST
puts one there routinely — so a negative age always passed. With `USD/INR 88.00 @ 2026-08-12` and
`83.00 @ 2025-08-29` both stored, `latest('USD', 'INR', '2025-08-31')` returned **88.00**: the
correct historical rate was in the table and discarded.

The docstring asserted the opposite — "nothing is carried backwards, because there is no code path
here that could carry anything" — and the sentence was true only of the three lists it named.

**Consequence:** every past month's foreign holdings converted at *today's* rate while the same
column's prices were that month's closes. The currency leg of a year of history was flat by
construction, and no column carried a mark saying so. Crypto was inside this too, since those pairs
carry `X:USDT`.

Fixed by filtering `fxRates` alongside the rest. The existing seven-day `MAX_FX_LATEST_AGE_DAYS`
bound then applies to each month as it does live: a month whose newest stored rate is older than
that drops its foreign holdings out of the column rather than dating them from the future, which is
the product's stated preference everywhere else.

### ~~A month priced in part was drawn as a month measured whole~~ — FIXED

`buildMonths` gapped a month only when the *entire* month was unvaluable. `aggregateByClass` does
`if (!pair.marketValue.measured) continue`, so a month that folded holdings but could price only
some of them produced a column summed over a subset of the portfolio — and `StackMonth` had no
field for the omission, so `NetWorthStackChart` had nothing to mark and its accessible table
printed a plain `formatMoney`.

There is no historical price backfill in this product: price rows begin the day an instrument is
first refreshed, while the fold produces holdings for every month the transactions cover. The
months before that quietly omit whole asset classes.

**Consequence:** reproduced against the shipped fixture with the E\*TRADE account promoted to a
ledger — eleven ordinary-looking columns omitting the whole of US equity (₹7,77,565 drawn for July
2026 over a portfolio that also held 34 CAT that month), then a **177% step** when pricing began
that is an artefact of the price table rather than a movement in net worth. The panel foot said
"A month with nothing stored is drawn as a gap — never a value carried backwards", which told the
reader the opposite of what those columns meant.

Fixed by carrying `bundle.snapshot.value.coverage.breakdown.unpricedCount` — already computed at
that call site and never read — onto `StackMonth`. A column carrying it gets an open dashed cap
(`.gap-mark` ink, deliberately *not* the 45° hatch, which means "no transaction history" and
nothing else product-wide), its total is stated as a floor — "At least ₹44,21,000 — incomplete",
"≥ ₹48.32L" — rather than as a total, and the chart annotates what the mark means in the plot and
in its own accessible name. `src/ui/charts/NetWorthStackChart.partial.test.tsx` is the fixture that
was missing.

### ~~The withheld-value disclosure folded an unknown amount in as ₹0~~ — FIXED

`withheldFrom` bucketed `currency === null` as INR and mapped `observedValueMinor === null` to
`ZERO_MINOR`. The `foreignNote` escape hatch fired only for non-null non-INR rows, so nothing said
the amount was unknown.

This is the *default* for exchange sync — `record_unresolved` inserts neither
`observed_value_minor` nor `currency`, so every unresolved coin is NULL/NULL — and the document
path reaches it via a tradebook with no valuation column.

**Consequence:** two such entries rendered "Unresolved instruments: 2" directly above "₹0 withheld
from every total": a zero standing in for an amount nobody knows, in the one indicator whose whole
purpose is to name what is missing. The mixed case was sharper — three entries of which one carried
a value printed an exact-looking "₹1,18,640 withheld" that silently omitted the other two.

Three other places already got this right and disagreed with the dashboard about the same rows:
`valuation/portfolio.ts` filters nulls out of `withheldMinor`, `src/screens/settings/review.ts`
counts them as `unstated` and prints "amount unknown — the source stated no value", and
`UnresolvedQueue.tsx` likewise. `review.ts`'s own header states the rule: "a zero reads as 'worth
nothing' for a holding whose value is merely unknown, which is the exact lie the queue exists to
prevent."

Fixed by porting `summariseWithheld`/`withheldCaveat` into the view-model — ported rather than
imported because that module counts `ReviewQueueEntry` and this one counts `UnresolvedRow`. Rows
with no stated value are counted separately and appended as "plus N whose amount the source did not
state"; when *nothing* is quantifiable the note is "Amount withheld is unknown, not zero — the
source stated no value" and no figure is printed at all. `DataQualityView.withheldMinor` is now
documented as the total of the rows that stated a value, which is not the same quantity as the
amount withheld.

The fixture at `src/screens/view-model.test.ts` only ever exercised a row that *did* carry a value
and a currency — the one shape the code handled — which is why the default case survived. It now
carries the NULL/NULL, mixed and foreign cases.

### ~~A native-currency amount was printed, and exported, as rupees~~ — FIXED

`moneyFigure(minor, format, currency = 'INR')` defaults its currency, and two call sites in
`view-model.ts` handed it non-INR values with the argument omitted: `lot.costMinor`, whose currency
is `OpenLot.currency`, and `txn.amountMinor`, whose currency is `TxnRow.currency`. Both were built
with `symbol: false`, and `Instruments.tsx` printed them under static headers reading `Cost ₹`,
`Price ₹` and `Amount ₹`.

Passing the currency alone would not have fixed it. With `symbol: false`, `Figure.currency` only
selects digit grouping — the visible claim was in the three headers.

**Consequence, milder form and reachable today:** a Binance or CoinDCX fill in a USDT-quoted market
puts its quote price in that Price column, so BTC at 43,000 USDT read "₹43,000" — three lines below
the price-history panel printing "USD per unit" in its own meta. (It reaches the screen because
`buildAccounts` drops a snapshot account's transactions before mapping them, so no `MappingError`
is raised, while `buildInstrumentViews` reads `rows.transactions` directly.)

**Consequence, severe form:** the first USD ledger row. The "Invested — FIFO cost" tile is
`pair.costMinor`, already through `costInInr`; the lot table beneath it is native. The two disagreed
by ~87× with no mark of any kind — ₹9,75,998 above a lot table reading "3,720".

**Consequence in the export, worse still, because the unit was in the column name:**
`amount_inr_minor` / `amount_inr`, a header note asserting "`<name>_inr_minor` is the stored integer
in paise", and no currency column anywhere in the transactions table — so the error was not
recoverable from the file by whoever received it. `src/screens/settings/review.ts` already had the
rule in its header: "a total is per currency, never mixed."

Fixed by passing each amount's own currency, dropping `symbol: false` so the figure carries its own
symbol, and dropping `₹` from the three headers. The transaction price cell appends its currency via
`formatQty`'s `unit`. An amount whose stored code this build has no formatting rule for — the `X:`
namespace, which has no minor unit and no rupee rate — is withheld rather than printed. The export
columns are now `currency`, `amount_minor`, `amount`, and the header note states which tables are
converted and which are not. `formatFigure` also refuses `symbol: false` for a non-INR figure, so a
future call site that forgets still cannot print a dollar amount bare.

The corpus had no fixture that could catch it: the only USD account was snapshot-only with no
transactions and therefore no lots and no amounts. `usdLedgerRows()` in
`src/screens/testing/fixtures.ts` is that fixture.

~~**Left open:** `PositionView.avgCost` is `pair.costMinor / quantity` — rupees per unit — and sits
in the same table as `lastPrice`, which is the stored close in the instrument's own currency. Both
are `qtyFigure`s with no unit, under headers "Avg cost" and "Last price". They are not the same unit
for a foreign holding, and nothing on that row says so.~~ — **now fixed**, with the export column
that carried the same quotient; see "An average cost in rupees, in a row declaring dollars" below.

### ~~"100.0% LEDGER-BACKED" over an account whose holdings were all unpriced~~ — FIXED

`portfolio.ts` adds an unpriced position to neither `measuredMinor` nor `valuedMinor` — there is no
value to add — and `coverage.ts` derives `unmeasuredMinor` by subtraction, so it comes out at
exactly 0. `coverage.ts`'s own header states the rule this breaks: unpriced positions "cap priced
coverage below 100%". Nothing implemented it.

**Consequence:** with the gold account dropped and the E\*TRADE snapshot holding unpriced, the
calibration bar printed "100.0% LEDGER-BACKED", its aria-label said the same, and because
`!isZeroMinor(props.snapshotOnly)` was false the "NO HISTORY — XIRR, COST BASIS & REALISED P&L
EXCLUDE ₹…" bracket was not drawn at all. `Accounts.tsx` then printed "Every account supplies
transaction history, so nothing on this screen is withheld" directly beneath a row badged "Holdings
only · 1 not priced".

The direction is what makes it serious: **the honesty indicator improves as the data quality
degrades.** A USD rate ageing past its bound drops a holding out of both sides of the fraction and
flips the bar to 100.0% — the one value this product documents as meaning complete.

Fixed in three places. `coverageReport` now derives `historyCoveragePct` through `pricedCoveragePct`,
which reuses the module's existing `99.99` clamp rather than inventing a second convention.
`CalibrationBar` takes an `unpriced` count: non-zero and its label reads "% OF PRICED VALUE
LEDGER-BACKED", its accessible name says the percentage cannot be read as completeness, the readout
appends "N not priced", the legend carries the sentence, and `data-coverage-complete` /
`data-unpriced-count` make it machine-readable. `Accounts.tsx`'s foot is now decided by
`capability === 'snapshot'` — an account question — rather than by a rupee quantity, and when the
amount cannot be stated it says that instead of saying nothing is missing. `coverageOpportunity`
no longer promises "raise coverage to 100.0%" while something is unpriced.

`unpricedSnapshotRows()` is the fixture; it is the reviewers' reproduction, and it is *worse* data
than the shipped one, which is exactly why it read better.

That fix put a different unsupported claim in the same branch. See the entry directly below, which
is the **second** repair of this one sentence.

### ~~The Accounts foot blamed pricing for a zero it had no evidence about~~ — FIXED (second repair)

`capabilityFoot` in `src/screens/Accounts.tsx` read `coverageOpportunity === null` as proof that the
snapshot accounts' holdings could not be priced, and printed "None of those holdings could be
priced". `view-model.ts` nulls that field on `isZeroMinor(snapshotOnly) || isZeroMinor(netWorth)`,
and pricing is only one of the ways that is true. Two others reach the same branch:

- **A snapshot account with no position rows at all.** `upsert_exchange_account`
  (`src-tauri/src/sync.rs`) inserts with a hardcoded `capability = 'snapshot'` when the credential is
  committed — *before* any balances sync has run — and `queries.rs::list_accounts` lists every
  non-archived account. So an exchange whose first sync has not started, or threw, or found nothing,
  is on this screen holding nothing. This is the state of **every** newly connected exchange, for as
  long as it takes the first sync to land.
- **An account whose rows all price to zero**, e.g. a fully sold holding whose position row is
  retained.

**Consequence:** the screen named the user's account and stated a cause the same view-model
contradicts in the same render — `unpricedCount` is 0, and the Dashboard calibration bar in the same
session shows no unpriced note. For the freshly connected exchange the sentence is doubly wrong: it
reports a pricing failure to a user whose account has simply not synced yet, which is a reason to go
looking for a missing price feed instead of pressing sync.

**This is the second false statement out of this one branch**, and that history is the reason for
the shape of the fix. The first repair replaced "nothing on this screen is withheld" — a denial of an
account listed three rows above it — with a claim about pricing that the branch does not license.
Writing a third sentence was not the fix; splitting the branch on evidence the screen actually holds
was. `AccountView` carries `unpriced` and `holdings` per account, so:

- some snapshot account with `unpriced > 0` names the count, and only the count — "1 of its holdings
  has no stored price" rather than "none of them could be priced", because a mixed account is
  possible and the total is what the row above prints;
- every snapshot account with `holdings === 0` says there are no holdings recorded yet, and stops
  there. It deliberately does *not* explain that a connected account has none until its first sync
  lands: that is true of the case this was found in and not knowably true of the account in front of
  the user, and this branch has been repaired twice already for exactly that kind of inference;
- otherwise the foot **names no cause at all**. It says only that the figure cannot be stated, which
  is the one thing `coverageOpportunity === null` does prove.

Two fixtures, because the corpus could not produce either state: `connectedNoHoldingsRows()` is a
snapshot account row with zero positions — every account in `ACCOUNTS` had positions or transactions,
and `allLedgerRows()` empties `positions` only for accounts that are `ledger` anyway — and
`zeroQuantitySnapshotRows()` carries `ZERO_QUANTITY_POSITION`, the first zero-quantity row in the
corpus.

**Standing lesson, named by the reviewers and worth repeating:** the corpus has been catching up in
*shape* faster than the suite has caught up in what it *asks* of each shape. `unpricedSnapshotRows()`
was added by the first repair and drew exactly one assertion — on the sentence that turned out to be
false in two other states reaching the same branch. That single assertion then defended the defect.
Each of the three states now asserts on `holdings`, `unpriced`, `unpricedCount` and
`coverageOpportunity` as well as on the sentence, so a fixture cannot again teach a test to expect
one string and check nothing else.

### ~~Months with holdings but no stored prices were labelled "no history"~~ — FIXED

`buildMonths` gapped on `isZeroMinor(netWorthMinor)` and pushed `{segments: null, unpricedCount: 0}`,
discarding the real `unpricedCount` available at that call site and used on the branch directly
above it.

This is the **default state of any install younger than twelve months of refreshes**: nothing calls
`fetchHistory`, so after one refresh every stored price row is dated today and every earlier column
prices nothing it holds.

**Consequence:** reproduced as eleven columns with `gap=true unpriced=0`, annotated "HISTORY BEGINS
AUG 2026", over a portfolio with 28 transactions starting 2024-09-07. No rupee figure was wrong; the
*reason* was, and the reason is what a reader acts on. Four surfaces told the user their imported
history did not exist.

Fixed by carrying the real count into that branch and giving the month `segments: []` rather than
`null` when it held something — a priced value of zero, which is a measurement, so the chart's
existing floor treatment applies (open cap, "at least ₹0", and the instrument count that says why).
`null` is kept for its original and only meaning, a month with nothing in it at all, and
`historyBegins` then points at the first month that actually held something. `!bundle.snapshot.ok`
has no breakdown to read and so states no count at all: `unpricedCount` is optional precisely so a
caller with nothing to say can leave it out, and a zero there would be a claim that branch cannot
support. `freshInstallRows()` is the fixture.

### ~~Sub-paisa prices rendered as 0.00~~ — FIXED

`priceDecimals` returned 4 for a mutual fund and 2 for everything else, from the asset class alone.

**Consequence:** SHIB is in the shipped seed catalogue and trades near $0.00001, so its "Last price"
and "Avg cost" cells printed `0.00` beside a correct, non-zero Value — while `NavHistoryChart`
directly above them drew the real digits, because it derives its precision from the data. Cosmetic,
but a visible contradiction between two components reading the same rows.

Fixed by deriving the precision from the value the same way the chart does: the convention is kept
untouched for any price it can show, and a value that would round to a row of zeros gets the digits
its stored string actually carries, capped at 8 — the chart's own cap, so the two cannot disagree
about how many digits a price has. A genuine zero still prints `0.00`, because zero is a measurement
here rather than a rounding artefact. `subPaisaRows()` is the fixture.

### ~~The return percentage divided one set of holdings' P&L by another set's cost~~ — FIXED

`buildReadout` in `src/screens/view-model.ts` summed cost with `sumMeasuredCost` — every pair whose
`costMinor` is measured — and P&L with `sumMeasuredPnl`, which `portfolio.ts` additionally gates on
`marketValue.measured && cost.measured && age !== null`. Then it divided the second by the first.

`costInInr` converts each lot at its **acquisition-date** rate and never asks for a price, so any
holding that drops out of net worth keeps its cost and loses its P&L. Two states reach it, and they
fail independently:

- **An instrument with no stored price row.** No foreign currency involved at all. This is any
  install holding something no provider covers, and *every* install before its first price refresh.
  Reproduced with `unpricedLedgerRows()`: cost ₹6,92,506, P&L +₹43,824, printed **+6.33%** against
  the +16.22% those holdings actually returned.
- **A foreign holding with acquisition-date rates and no current one.** Reproduced with
  `historicFxOnlyRows()`: cost ₹16,68,504, P&L +₹1,01,364, printed **+6.08%** against +14.64% —
  understated 2.4×.

**Consequence while it stood:** the headline return of a portfolio was understated by a factor of
two or more, and nothing on the screen could contradict it. `cost_basis` coverage weights each pair
by market value, which is zero for exactly the pairs that cause the divergence, so the coverage
badge beside the P&L cell and the badge beside the Invested tile were **identical**. The Dashboard
labelled the sub-row "on measured cost" — literally true, and a larger set of measured costs than
its own numerator's. And `coverageOpportunity` printed, in this same scenario, "1 holding has no
stored price and is in no figure on this screen" — the valuation spec's stated invariant that an
unpriced position "contributes nothing to any rupee figure and cannot". The screen asserted an
invariant it was breaking two tiles up.

Fixed by forming the denominator over the numerator's own population: `sumPnlCost` sums
`pair.unrealised.value.costMinor`, which is carried on the pair that produced the P&L, so the two
cannot drift. The Invested tile now names the cost it holds that no P&L figure counts, and the
sub-row is labelled "on cost of valued holdings" rather than after the tile above it.

**What made it invisible to the corpus:** `unpricedSnapshotRows()` was the only unpriced fixture,
and it is snapshot-capability only — a snapshot pair has no measured cost either, so it drops out of
both sums and the two populations coincide exactly. The shape that matters is a **ledger** pair with
measured cost and no market value, and no fixture had one. `measuredUnpricedInput()` in
`src/valuation/__fixtures__/build.ts` is now the engine-level builder for it, and
`portfolio.test.ts` pins why no coverage figure can report the divergence: both metrics read
100.00% of the same total while their rupee costs are ₹1,05,000 and ₹1,00,000.

### ~~The Holdings foot stated rupees from one population and percent from another~~ — FIXED

`Holdings.tsx` took the foot's rupee numerator from `data.ledgerBackedMinor` — which is
`coverage.measuredMinor`, the ledger/snapshot **capability** split — and its percentage from
`costMetric.pct`, whose rule is `measurement === 'measured' && costMinor.measured`. A ledger pair
whose cost cannot be converted is in the first and not the second.

**Consequence:** with today's dollar rate stored and the acquisition dates' absent — the state of
every install between its first price refresh and the end of `backfillFxHistory` — the foot read
"cover **₹19,13,066** of ₹21,53,064 (**36.8%**)". That ratio is 88.85%. The cost column's real
coverage was ₹7,93,871, so the sentence overstated it by ₹11.19 lakh while quoting the correct
percentage beside the wrong rupees.

The same conflation mislabelled the Dashboard's cost note, and there the rupee figure was right and
the **attribution** was wrong: "excludes ₹13,59,194 of snapshot holdings", of a portfolio whose
snapshot-only value is ₹2,39,999. It sent the user to import a statement they already have, when
the missing input was a 2024 exchange rate.

Fixed by giving `CoverageMetricView` its own `coveredMinor`, so a caller writing "covers X of Y
(Z%)" takes all three from one object, and by splitting the note's excluded value on the account
that actually owes it: snapshot value is excluded for want of a transaction history, ledger value
for want of a conversion, and they are now two separate sentences because they have two separate
remedies.

**The fixture gap behind both entries.** `USD_INR` ships all four dates together, which no install
ever holds: `refreshFx` stores only `'latest'`, `backfillFxHistory` is paced, capped by
`MAX_FX_HISTORY_REQUESTS`, skipped entirely when the provider has no `fetchFxHistory`, and halts on
RATE_LIMITED — and `MAX_FX_BACKFILL_DAYS = 3` against `MAX_FX_LATEST_AGE_DAYS = 7` means the two
legs age out **independently by design**. `latestFxOnlyRows()` and `historicFxOnlyRows()` split
them, and each leg breaks a different figure.

**Residual, deliberate:** `ExcludedPair.reason` still comes from `pair.reason ?? priceReason(...)`,
so the pair excluded from `cost_basis` for a missing acquisition-date rate is labelled "no price"
inside the metric — the same misattribution one layer down. Nothing renders `excludedPairs` today,
which is why it was left: fixing it means giving each metric's exclusion its own not-measured
reason (the cost's for `cost_basis`, the P&L's for `unrealised_pnl`) in `buildMetrics`, and it
should be done before anything puts those reasons on a screen.
### ~~Unpriced holdings were summed as ₹0 and republished as measured~~ — FIXED

`buildPosition` writes `valueMinor = ZERO_MINOR` when `pair.marketValue` is not measured. That is
correct in itself — the sibling `value` field takes `notMeasured`, so nothing renders the zero — but
both aggregates over those positions summed it and wrapped the result in `fullCoverage`:
`buildInstrumentViews` for `totalValue`, and the account loop in `build` for `AccountView.value`, on
the line directly after computing `unpriced`. The count was there; the arithmetic ignored it.

**Consequence, on the shipped fixture:** the Instruments detail printed "Units held 34.0000" beside
"Current value ₹0 · 0.00% of net worth" under a stamp reading "Quantity multiplied by the latest
stored price", while the position row in the same panel said "Not converted — no exchange rate for
this date". The Accounts row badged "1 not priced" one column from a measured ₹0; the Dashboard's
per-account table and both Instruments screens carried no qualifier at all. `lastPriceNote` on the
same tile said "No price has been fetched for this instrument" above a printed 376.20 — the engine
dates only a price it could use, so a holding that priced but would not convert has a stored close
and no `priceAge`.

**Scope, which is far wider than that fixture suggests:** with `prices: []` — every install between
its first import and its first refresh — *every* instrument tile and *every* account row printed a
measured ₹0.

**Why the honesty suite could not see it:** H3 inspects `[data-not-measured]` nodes, and marking the
sum measured is exactly what removes the node. It was considered and deliberately not fixed there:
in the DOM a measured ₹0 over an unpriced holding and a measured ₹0 over a sold-out one are
identical, down to `data-coverage-pct="0.0"` (`fullCoverage(0)` short-circuits). What separates them
is which positions went into the sum, so the check has to live where the sum is taken — it is a
corpus-wide invariant in `view-model.test.ts`: for every account and every instrument, in every
fixture, the total is measured exactly when all of its own positions are priced.

Fixed by withholding the aggregate — `notMeasured(<the member's own reason>, pricedMinor)` — when
any holding under it is unpriced. There is no partial branch, and that is the interesting part:
`Coverage` is a pair of rupee amounts and an unpriced holding contributes a rupee amount to neither
side of it, so `partialCoverage(priced, priced)` reads 100.0%, and 100% is the one value this
product documents as meaning complete (`pricedCoveragePct`). A partly priced total therefore cannot
be qualified the way a partly known cost basis can. The priced subtotal stays on `valueMinor` for
the weights, the sort and the export — the export was already right, guarding on `row.position.priced`
at `export.ts`, which is what proved this was the screens' convention and not the data's. A genuinely
zero total — units sold, price known — stays measured, because zero is a measurement there.

The reason is taken from the first unpriced member rather than fixed at `no_price`, so the tile says
"Not converted — no exchange rate for this date" wherever the row beneath it does. `lastPriceNote`
now distinguishes "no price stored" from "priced, but not convertible to rupees".

Three fixtures, because the corpus could reach only the harmless end of this:
`partlyPricedAccountRows()` (one priced holding and one unpriced under one account — the sum that
looks entirely plausible, and the shape nothing produced), `noPricesRows()` (a fresh install) and
`zeroQuantityRows()` (the genuine zero the fix must not swallow). `unpricedSnapshotRows()` and
`usdLedgerRows()` already existed and were already used; what was missing were assertions over the
columns and the totals they had been producing all along.

**Left open, and it is the same shape one level up:** `readout.netWorth` is
`measured(moneyFigure(netWorth), fullCoverage(netWorth))` over a `netWorthMinor` that omits every
unpriced holding. It is qualified today by the calibration bar's unpriced count rather than by the
figure itself, and `portfolio.ts` states the countervailing rule — "one unmeasurable holding must
never blank the net-worth figure". Deciding between those two is a design question, not a bug fix,
and it was out of this branch's scope.

### ~~An average cost in rupees, in a row declaring dollars~~ — FIXED

`PositionView.avgCost` is `divDec(minorToDec(pair.costMinor.value, 'INR'), pair.quantity)`, and
`pair.costMinor` has already been through `costInInr` — so the quotient is **rupees per unit**
whatever the instrument is quoted in. It was rendered as a bare `qtyFigure` under headers reading
"Avg cost", next to a "Last price" that is the stored close in the instrument's own currency, and
exported as a bare `avg_cost` column next to `last_price` (native) and `instrument_currency` (which
names the row's unit).

**Consequence in the export, which is the worse surface because the unit is asserted in the row's
own metadata and travels to whoever receives the file:** the Caterpillar row read
`instrument_currency=USD, quantity=34, last_price=376.2000, avg_cost=28705.82…, unrealised_pct=14.67`.
Read under its own declared unit, that file says $28,705.82 average cost against a $376.20 last
price — a 98.7% loss — two columns from an unrealised percentage of +14.67. The true dollar figure
is $336.47; the mismatch is the exchange rate, about 85×. On screen it is the residual left open by
the native-currency fix above.

**The decision, since either answer is defensible:** the average stays *converted*, and states its
unit. The cost basis it divides is the one the engine computes, the one `cost_inr`, `unrealised_inr`
and the "Invested — FIFO cost ₹" tile all show, and the one Indian tax is assessed in; a native
average would be a second cost basis disagreeing with every rupee figure beside it, and the engine
does not compute one per position.

Fixed by putting the unit on the figure — `qtyFigure(perUnit, { precision, unit: 'INR' })`, so the
cell reads `28,705.82 INR` — rather than in the header, because on the Holdings screen that header
also carries the portfolio's total cost and cannot name one unit for both. The export column is
`avg_cost_inr`: `_inr` is this module's word for "Misal converted this", which is what happened to
it, and `MONEY_NOTE` now names `last_price` as the one figure in the holdings table that is *not*
converted. The export whitelist test locks the new name.

The fixture was not missing: `usdLedgerRows()` has been in `export.test.ts` since the currency fix,
and the Caterpillar row was in every `flatten()` result it built. Nothing asserted on that column.

### Export is documented as shipped and has no button

`runExport` and `EXPORT_CHOICES` are complete and tested, and nothing on any screen calls them —
only `export.test.ts` does — while `docs/USING.md` documents "Settings → Export writes CSV or JSON
of your holdings and transactions". So the feature exists, is reachable from no screen, and is
promised to the user in the manual.

Not a missing state: a missing button. Wiring it needs a panel on the Settings screen, a
`SettingsRuntime` method to reach `loadPortfolioRows` + `buildPortfolioView` the way
`accountsWithValue` already does, and — per this repo's own workflow — a reviewable mockup first,
since it is new UI. That is a small feature rather than a fix, so it is recorded here rather than
smuggled into a defect branch.

## Exchange adapters

### ~~Rotating an API key doubled the holdings it was rotated for~~ — FIXED

`ExchangesScreen.onSubmit` called `runtime.newAccountId()` — a fresh `crypto.randomUUID()` — on
every connect submit, and nothing consulted the accounts already connected.
`exchange_commit_credential` then inserted an `account` row whose `ON CONFLICT (id)` could not fire
on an id minted a millisecond earlier, and wrote neither `identity_key` nor `external_ref`, so
exchange accounts carried no identity at all. `idx_account_identity` is partial
(`WHERE identity_key IS NOT NULL`), so any number of anonymous duplicates was legal.

The trigger is something the app itself instructs. The sync report tells a user whose key has
gained withdrawal permission to make a new key and connect it, and the Connect panel was the only
place a key could be pasted — there is no reconnect path anywhere on the screen.

**Consequence, both reproduced:** `disconnect.rs` deletes only the keychain entry, so the old
account's last balance snapshot stayed the newest row for its `(account_id, instrument_id)` pairs.
`derivePortfolioPositions` keys on that pair, counted both, and **1 BTC was reported as 2 BTC** with
nothing on any screen saying so. Separately, `accountId` is part of `NaturalKeyParts`, so the whole
fill history re-landed under the new id and the transactions duplicated independently of the
balances.

Fixed in two layers, because a screen-level guard on a data-level problem is only as good as the
next screen.

*The screen.* `onSubmit` reuses the account id of the connection already held for that provider, and
the panel presents itself as **"Replace the key for &lt;account&gt;"** with a button reading "Check
this key and replace" — a user who reads "connect" and gets a replacement has been misled by a word,
and the two differ in what happens to everything already synced. The disconnect confirmation and the
quarantine notice now point at that panel instead of saying "connect that one".

*The core.* `commit_credential` writes `account.identity_key` and resolves the account from it
rather than from the id the caller proposed, returning the id it actually filed under —
`resolve_account` in `src-tauri/src/sync.rs`. A row already carrying the identity *is* the account;
an unclaimed identity is written onto the proposed row; a row whose identity says it is a different
account at the same exchange is refused rather than repointed.

**That refusal covers only the rows whose identity is already specific**, and the sentence that
used to stand here without that qualification was false for two states the core actually meets: a
row whose `identity_key` is NULL, and a row keyed on the exchange alone. Neither knows which
exchange-side account it is, so there is nothing for an incoming uid to be compared *with* — the
comparison cannot be written, and pretending otherwise was the defect below. Those two states now
get a refusal that says it cannot tell, rather than a silent fold. A key whose own identity is
generic — the exchange named no account, or the probe could not reach it — is still filed onto the
row it was aimed at, which is the one remaining way two accounts can meet on one row; see below.

**What identifies an exchange account.** For Binance, the exchange's own `uid`, read from
`GET /api/v3/account` — already on both copies of the allowlist, and documented there since it was
written as being read "for `permissions` and `uid`" and never for scope, since its
`canTrade`/`canWithdraw` describe the account rather than the key. The probe signs with the staging
handle, before the secret is written, because the identity is what decides which row exists. Any
failure answers `null` rather than costing the user a connect, and the core will not overwrite a
uid it already knows with the weaker fallback.

**For CoinDCX there is nothing stable to key on, and this is stated rather than worked around.** Its
whole allowlisted surface is `markets_details`, `users/balances` and `orders/trade_history`; none of
them names a user or an account, and the exchange has no scope endpoint at all — `describeScope`
answers without making a request. The only per-account identifier CoinDCX ever hands over is the API
key itself, which is precisely what a rotation changes. So a CoinDCX account is keyed on the
exchange (`exchange:coindcx`), which the unique index turns into **one CoinDCX account per
database**. Nothing is lost that exists today — the screen offers no way to create a second one —
but it is a real limitation, not an oversight.

**What the guard does not cover, and it matters:**

- **Databases that already hold duplicates are not repaired.** Adding a migration was out of scope
  for this branch, and the identity is written only when a key is next connected: the account the
  screen picks gets the identity, and the stale twin keeps its anonymous row and its stale snapshot
  and goes on double-counting. It has to be deleted from the accounts screen by hand.
- **Two accounts at the same exchange are unreachable through the UI**, for Binance as much as for
  CoinDCX. The core refuses the second key rather than merging it — by comparison where both
  identities are specific, and by disclosure where the row's is not — but there is no screen that
  can create the second account, so the refusal is a dead end with an explanation.
- **A Binance connect makes two extra requests** (`/api/v3/time` and `/api/v3/account`, weight 21 of
  6,000 a minute) and falls back silently when they fail, so an account can end up keyed on
  `exchange:binance` and be upgraded to its uid only on a later connect.

**Fix direction for the remainder:** a migration that keys existing exchange accounts on
`(provider_id)` where only one exists and quarantines the rest for the user to merge, and a
"connect another account at this exchange" path on the screen once there is a way to tell the user
which account they are looking at.

### ~~A second account's key was folded onto a row that had never named itself~~ — FIXED

Found reviewing the fix above, in the fix above. `resolve_account`'s "different account at that
exchange" refusal was only the `Some(_)` fallthrough. The two arms before it — a row whose
`identity_key` is NULL, and a row whose identity is generic (`exchange:binance`) — wrote the
incoming identity onto the proposed row with **no comparison at all**, and the credential followed
it there.

Both preconditions are live rather than hypothetical. Every exchange account in a database written
before the fix above carries `identity_key` NULL, because the old INSERT had no such column. And
`binanceAccountRef` (`src/data/sync.ts`) swallows every error — `catch { return null }` — so a first
connect made while Binance was rate limiting, or while the machine was offline, keys the row
`exchange:binance` and syncs happily under it.

`ExchangesScreen.tsx` always proposes the existing row (`existing?.accountId ?? runtime.newAccountId()`)
and the Connect panel is the only place a key can be pasted, so there is no second-account path in
the UI for a user to take by mistake — the fold arrives through the ordinary rotation form.

**Consequence:** account B's secret overwrote A's keychain entry (`secret/<account_id>` is
deterministic and `store_secret` overwrites in place, via `ON CONFLICT (account_id)` on the row),
B's first snapshot superseded A's for every instrument they share — `latestSnapshots` in
`src/valuation/positions.ts` keys on `(account_id, instrument_id)` — and A's holdings left net worth
with the screen printing "the balances and trades already synced are untouched" over the top.

**This was a missing disclosure, not a missing comparison.** In those two states the code has no
information that could separate "the same account, whose probe finally worked" from "a different
account's key", and no comparison can be invented for it. So `name_unclaimed_row` refuses instead,
and only where there is something to lose: a row holding a `credential_ref`, a `position` or a `txn`
is a connected account, and a uid-named key aimed at it is refused with a message saying why it
cannot tell. A row holding none of those three has nothing to reattribute, so the legitimate
upgrade — first connect rate-limited, second connect names the account — still goes through, and a
test asserts that precondition rather than assuming it.

The doc claim above was corrected in the same change: an unqualified promise the code does not
honour is part of the defect, not a separate one.

**What this still does not cover:**

- **A row that knows its uid, meeting a key that does not.** A generic identity offered for a row
  keyed on `uid:42` is ignored rather than written — which is right, it must not blunt what the row
  knows — and the key is then filed onto that row. If it belongs to a *different* Binance account
  whose probe happened to fail, the fold happens anyway. Refusing it would break every rotation made
  while Binance is rate limiting, which is the case the fallback exists for, so the trade is made
  deliberately in favour of the common path.
- **A refused rotation has no cheap way forward.** A user with a pre-identity database, rotating the
  key on an account that really is the same one, is now refused and told to delete the account in
  Settings and connect the key as a new one — which re-syncs from scratch. That is a real cost, paid
  to avoid a silent merge.

**Fix direction:** ask the exchange who the *stored* key belongs to before replacing it. A uid probe
signed with the account's existing credential would turn both of the states above into a real
comparison — same uid, upgrade; different uid, refuse — and would leave the disclosure for the case
where neither key can be probed at all.

### ~~A failed commit during a key rotation deleted the credential it was replacing~~ — FIXED

`commit_credential` wrote the keychain entry inside the database transaction's window and
compensated a failed `tx.commit()` with `delete_secret(&keychain_key)`. That is correct for a first
connect — the rows rolled back, so an entry left behind would be a live API key nothing refers to —
and wrong for a rotation, which has been the ordinary path since the Connect panel became the
replace panel.

On a rotation the `credential_ref` row and the `account` row predate the transaction and survive its
rollback. Deleting the entry therefore left the account reading as connected — `exchange_has_credential`
counts `credential_ref` rows and nothing else — while the keychain held nothing, and every sync
afterwards failed at `credential_for` with "the keychain entry for account … is missing". The screen
printed "Nothing was stored: the key was discarded without being written", which was the opposite of
what had happened.

**On a rotation the compensation was strictly worse than no compensation.** With no compensation at
all the failed commit would have left `credential_ref` pointing at a slot holding the valid new key
— a working account.

Fixed by making the compensation know which of the two it is in. `commit_credential` now asks,
inside the transaction and before its own insert, whether a `credential_ref` row was already there;
on a rotation it reads the previous secret first and puts it back if the commit fails, on a first
connect it deletes as before, and where the row existed but the keychain held nothing — the state
the old compensation created — the new key is left in place, because that repairs the account rather
than recreating the failure. Each outcome says which one happened; "nothing was stored" is now
claimed only where it is true. `ExchangesScreen` no longer appends that sentence to a failed
*replacement*, where it cannot know it.

**The absence that let this through:** the Rust suite had no fault injection anywhere, and no test
in `sync.rs` had ever seen `tx.commit()` fail — a commit failure cannot be arranged by feeding a
fixture bad data. `commit_credential_with` now takes the keychain (`CredentialStore`, an in-memory
fake in tests, for the same reason `accounts::SecretStore` is injected) and the commit itself, so
the window between the keychain write and the commit is executed rather than reasoned about.

### ~~Deposits and withdrawals were never fetched~~ — FIXED

`fetchTransfers` was declared on the adapter contract and implemented by neither exchange, so the
discovered-asset set grew only from balances and fills. Two consequences, both silent: a coin
deposited from a wallet and never traded on the exchange was invisible — no balance explanation, and
worse, it never entered the set that drives Binance's symbol sweep, so Misal never even asked
whether it had been traded — and a withdrawal left the fold permanently above the reported balance
with the difference attributed to "activity Misal cannot see".

Fixed for Binance by `src/adapters/binance/history.ts`, walking `capital/deposit/hisrec` and
`capital/withdraw/history` in ≤90-day windows with `offset` paging inside each. Transfers run before
the symbol sweep, which is the whole point of the ordering.

**A transfer is modelled so it cannot be mistaken for an acquisition.** `RawTransfer` has no `price`
and no `side` field to put one in, and `normalizeTransfer` takes no price argument: a deposit becomes
a `transfer_in` with a null price and a null amount, which the fold already opens as a lot whose cost
is explicitly unknown and whose holding withholds cost basis, unrealised P&L and XIRR while still
counting the units. The withdrawal fee is a separate `fee` row, because Binance charges it on top of
the amount withdrawn and folding it into the quantity would misstate both.

### CoinDCX transfer endpoints could not be established

CoinDCX's published API covers markets, balances, order placement and trade history. No deposit or
withdrawal history endpoint is documented, and none of the plausible paths has a shape anyone has
written down. Establishing them needs recorded traffic from a live account, which no test in this
repository is permitted to produce.

`fetchTransfers` is therefore **absent** from the CoinDCX adapter rather than implemented against a
guessed shape — on an exchange whose only key class can also move funds, an invented request is
precisely what the allowlist exists to make impossible. The runner treats an absent stream as "never
asked", which is a different thing from "asked, and there were none", and the conformance suite
requires an adapter that omits the method to state the gap in `coverageGaps`.

**Consequence:** CoinDCX cost basis remains incomplete for anything deposited or withdrawn, and the
fold-versus-balance gap for those assets has no explanation attached to it beyond the coverage note.

**Fix direction:** capture the web app's own network traffic against a throwaway account, or use the
CoinDCX CSV export, which does contain transfers.

### ~~Binance Convert trades were invisible~~ — FIXED

Convert fills appear in `myTrades` never — not late, not partially, never — and Binance exposes them
only through `GET /sapi/v1/convert/tradeFlow`. Many retail users acquire their first crypto through
the Convert widget, so their cost basis was silently incomplete and the report merely said so.

Now fetched. The endpoint is on the Rust-side allowlist in `src-tauri/src/sync.rs`; the frontend's
copy is deliberately ignored in favour of it. Admitting it needed `tradeflow` as a read terminal in
both path classifiers, which is the same mechanism that lets `capital/withdraw/history` through while
`capital/withdraw/apply` stays refused — `convert/getQuote`, `convert/acceptQuote` and
`convert/limit/placeOrder` are all still classified as mutating and are asserted to be, on both sides
of the boundary and in `tests/fixtures/adapters/mutating-paths.json`.

A conversion is a *priced* acquisition, unlike a transfer: the units given up are the consideration,
so it becomes a `buy` of the asset received at the ratio the exchange reports. It does not go through
the market catalogue, because Convert will swap a pair that has no order book at all.

### Backfilling the weighted endpoints takes several syncs

Binance meters SAPI twice and the two budgets share nothing: deposit history is IP weight 1,
withdrawal history is **UID weight 18,000** and Convert history **UID weight 3,000**, against 180,000
UID a minute of which the limiter targets half. `RateLimiter` now carries a second bucket for it,
and a request heavier than a whole minute's target is refused up front rather than sleeping forever —
a sync that never finishes and never errors is indistinguishable from a slow one.

The per-sync backfill budget in `BACKFILL_WINDOWS` is chosen so a whole sync fits inside one minute
of the account budget (2 withdrawal windows + 8 Convert windows + 12 free deposit windows = 60,000),
and therefore never stalls waiting for it to refill.

**Consequence:** a decade of Convert history arrives over roughly two dozen syncs rather than one.
Each sync says how far back it has read, as a `backfill_incomplete` warning naming the date, so a
cost basis built from four months of history is not presented as one built from all of it — but a
user who wants everything now has no way to ask for it.

**Fix direction:** an explicit "fetch all history" action that accepts the stall and shows it as
progress, rather than raising the per-sync budget for everyone.

### ~~The sync report still calls Convert a blind spot~~ — FIXED

The disclosure now states that Convert trades are read, that the endpoint answers thirty days at
a time, and that history earlier than the reported date is genuinely absent rather than
approximate. The two tests pinning the old copy were updated with the reason.

Original description below.

### The sync report still calls Convert a blind spot (historical)

`src/screens/exchanges/disclosure.ts` hardcodes `CONVERT_BLIND_SPOT`, whose headline is "Anything you
bought with Binance Convert is missing from this history" and whose body says the cost basis "is not
approximate, it is absent". That was true when it was written and is no longer: Convert acquisitions
now reach the ledger.

Not fixed here because `src/screens/` is owned by another branch. The adapter's own coverage note has
been reworded to stay true — it says Convert fills are absent from *trade history*, which they are,
and that Misal reads them from Convert history instead.

**Consequence:** the sync report over-discloses. It tells the user their Convert purchases are
missing when they are present, which is the safe direction to be wrong in but is still wrong, and it
undermines the disclosures that are still accurate.

**Fix direction:** rewrite `CONVERT_BLIND_SPOT` to cover what is actually still missing — history
below the backfill floor — on a branch that owns the screens.

### ~~`SyncPhase` has no member for transfers or conversions~~ — FIXED

Added both. The label map in `SyncReport.tsx` is an exhaustive `Record<SyncPhase, string>`, so a
future phase cannot be added without being named for the user.

Original description below.

### `SyncPhase` has no member for transfers or conversions (historical)

The transfer and Convert walks report progress under `'fills'`. `SyncReport.tsx` keeps an exhaustive
`Record<SyncPhase, string>` of phase headings and an ordered list for its "step 3 of 6" counter, so
adding a member to the union is a change to a file this branch does not own — and an adapter emitting
a phase the table has no row for renders a blank heading and an `undefined` inside an aria-label.

**Consequence:** the heading says "Walking the trade history" while the detail line says "deposits
2019-01-01 to 2019-04-01". Imprecise rather than untrue, but it understates how much of a first sync
is not trade history at all.

**Fix direction:** add `'transfers'` and `'conversions'` to `SyncPhase` together with their rows in
`PHASE_LABEL` and `PHASE_ORDER`, on a branch that owns both sides.

### A transfer pending for more than a week is still lost

Found while writing this, and partly fixed. A deposit that is still confirming when its window is
read is deliberately not committed — units that have not arrived are not inventory — but its
timestamp stays inside that window forever. The forward pass used to resume strictly above the
covered high, so once the deposit settled nothing ever looked at it again: silently dropped, and
visible afterwards only as a coverage gap with no explanation.

The forward pass now restarts seven days below the covered high (`REVISIT_MS`), which costs one
request per stream per sync and nothing else, because every row in the overlap deduplicates on its
natural key. Seven days covers chain confirmations and Binance's routine manual-review holds.

**Consequence, still open:** a withdrawal held for compliance review for longer than a week, or a
deposit on a chain that stalls for longer, settles outside the overlap and is never committed. The
balance still shows it, so it surfaces as a coverage gap rather than as a wrong number — but the
transaction behind it is gone until the account is re-synced from scratch.

**Fix direction:** carry the unsettled rows in the cursor and re-poll them by id, rather than
re-polling a time window and hoping they fall inside it.

### Suspected: `assignOccurrences` cannot disambiguate across pages

Occurrence numbering is computed per committed page, and the unique index is on
`(natural_key, occurrence)`. Two genuinely distinct transactions with identical keys in *different*
pages would both be numbered `0`, and the second would be discarded as a duplicate.

The fills path is structurally immune because a page's rows carry unique trade ids, and the transfer
and Convert paths inherit the same protection from Binance's row ids and order ids. It is recorded
because the reasoning that makes it safe is a property of the *data*, not of the code, and nothing
asserts it — a stream whose external ids were not unique would lose rows with no error anywhere.

## Test coverage

### Tax rule tables were nearly unguarded

Mutation testing on 2026-08-12 found that changing all nine tax rates failed only one test, and
changing holding-period thresholds was largely undetected. These values are transcribed from
legislation, change annually, and a wrong one produces a plausible number rather than a crash.

Addressed by `src/valuation/tax-rules.table.test.ts`, which pins every rate, threshold, effective
date and grandfathering flag. Verified by re-running the mutations: each is now caught.

**Standing lesson:** golden arithmetic examples do not cover lookup tables. Any table transcribed
from an external source needs exhaustive assertion, not sampled assertion.
