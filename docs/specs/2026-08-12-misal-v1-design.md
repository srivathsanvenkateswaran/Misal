# Misal v1 — Design Spec

**Status:** draft, pending review
**Date:** 2026-08-12

## What Misal is

An open-source, local-first desktop application that consolidates investments scattered across
Indian brokers, US employer-equity brokers, and crypto exchanges into a single honest view of net
worth. All data stays on the user's machine. There is no account, no cloud, and no server.

Named after the Maharashtrian dish: many components prepared separately and assembled into one
bowl, each keeping its own character.

## Why local-first rather than SaaS

Three independent reasons, any one of which would be sufficient:

1. **Custody risk.** A hosted version would hold both broker API keys and the complete net worth of
   every user — an uninsurable liability for an unfunded project.
2. **Regulatory.** India's Account Aggregator framework, the only sanctioned route to consolidated
   financial data, requires the operator to hold an RBI, SEBI, IRDAI or PFRDA licence. Realistic
   first-year cost is ₹5–25 lakh over 5–10 months. It is structurally closed to indie developers.
3. **Capability.** The planned MCP integration — pointing the user's own Claude Code or Codex
   subscription at their own data — is only possible when the data is local.

Open source follows from the same logic: users are being asked to trust the application with every
broker credential they own, and that trust is only reasonable if the code is inspectable.

## Surfaces

| Priority | Surface | Notes |
|---|---|---|
| 1 | Desktop — macOS, Windows, Linux | All three from day one |
| 2 | Android | Sideloaded APK from GitHub Releases. No Play Store, no iOS |
| 3 | Self-hosted web | Same frontend served as a plain SPA; user supplies their own host |

Distribution is GitHub-only. No custom domain.

## Scope of v1

**In:** core schema and encrypted storage, CAS statement ingestion, crypto exchange read-only API
keys, valuation engine, desktop UI.

**Out, deferred to later phases:** Indian broker API adapters, US broker adapters, Android client
and pairing protocol, self-hosted web build, MCP server.

The v1 cut is deliberate. Statement ingestion plus crypto keys are the only two paths that run
**unattended**. Every Indian broker API expires its access token daily by SEBI mandate with no
long-lived refresh token, so an API-first v1 would demand a daily interactive login across six
providers and be abandoned within weeks.

## Provider landscape

Established by research, and the reason ingestion is designed the way it is.

| Tier | Providers | Reality |
|---|---|---|
| Indian brokers | Zerodha, Groww, Upstox, Angel One, Dhan, Fyers | APIs exist, mostly free. Zerodha's Kite Connect Personal tier is free and includes holdings. **All expire tokens daily; none can run unattended.** |
| US-from-India | INDmoney, Vested | No public retail API. IBKR is the exception and has a good one. |
| US employer equity | E*TRADE, Fidelity, Schwab Equity Award Center, Morgan Stanley StockPlan Connect, Computershare, Carta | E*TRADE issues individual OAuth keys with daily expiry. **Fidelity has no public API at all.** Most are export-only. |
| Crypto | CoinDCX, Binance, CoinSwitch, WazirX | Read-only HMAC keys, no expiry. The only tier that works unattended. |

**Conclusion: statement and CSV ingestion is the backbone, not the fallback.** Live APIs are an
enhancement for the minority of providers that support unattended access.

## Data model

Six entities.

- **Provider** — static definition (`nsdl-cas`, `cams-cas`, `coindcx`). Registry data, not user data.
- **Account** — a user's account at a provider, carrying a capability flag of `ledger` or
  `snapshot`. This flag drives which metrics may be displayed for it.
- **Instrument** — the canonical security, with an alias table (see below).
- **Transaction** — account, instrument, type, quantity, price, fees, currency, timestamp,
  source document. Types: buy, sell, dividend, split, bonus, transfer-in, transfer-out, fee,
  interest, TDS.
- **Position** — account, instrument, quantity, as-of date, source document. Authoritative for
  snapshot accounts; derived for ledger accounts.
- **SourceDocument** — content-hashed record of the file or API response every fact came from.

### Provenance is first-class

Every figure in the UI traces back to a source document the user can open. This is what makes the
application debuggable when it disagrees with a broker statement, and it is the difference between
a tool that is trusted and one that is perpetually spot-checked.

### Instrument identity is the hardest problem

The same Infosys share arrives as `INFY` from Zerodha, `INE009A01021` in a CAS PDF, `INFY.NS` from
a price API, and `INFY` — a *different*, US-listed ADR — from E\*TRADE. Mutual funds use AMFI scheme
codes and folio numbers. Crypto has no standard identifier.

Resolution strategy: an Instrument table keyed on ISIN where available, with a many-to-many alias
table mapping every provider-specific identifier onto it. **Anything unresolved goes to a review
queue. Nothing is ever guessed.** Silent misidentification double-counts net worth, which is the
worst failure this application can have.

## Ingestion pipeline

One pipeline, six stages, identical for every source:

```
acquire → extract → normalize → resolve → reconcile → commit
```

Only `extract` is provider-specific. That is the plugin boundary, deliberately kept as small as
possible: a contributor adding Upstox writes one function turning their CSV into raw records, and
inherits identity resolution, deduplication and reconciliation for free.

### Idempotency

Users will re-import overlapping statements constantly. Source documents are content-hashed.
Transactions deduplicate on a natural key of account + instrument + date + quantity + amount +
type. **Importing the same statement twice is a no-op.**

## Valuation engine

- Positions fold from the ledger where one exists; taken directly from snapshots where it does not.
- Corporate actions (splits, bonuses) adjust quantities. Omitting this silently corrupts historical
  cost basis.
- Cost basis is FIFO, matching Indian tax treatment, with pre-31-Jan-2018 equity grandfathering.
- XIRR over dated cashflows, computed only for ledger-backed accounts.
- INR is the base currency; native currency is retained per instrument and the FX rate is visible.

### Honest metrics

Metrics requiring transaction history — XIRR, realised P&L, cost basis — are shown **only** for
ledger-backed accounts, and always alongside a coverage indicator stating what fraction of
portfolio value they actually cover. No number is ever estimated and presented as exact.

## Price sources

Behind a pluggable `PriceProvider` interface so providers can be swapped without touching the
engine.

- **AMFI daily NAV file** — mutual funds. Official, free, no key. MF tracking works before the user
  enters any key at all.
- **Twelve Data (BYOK)** — Indian equities (NSE/BSE), US equities and crypto from a single
  free-tier key. Note that NSE licenses real-time data only through authorised vendors, so
  free-tier Indian equity prices are delayed or end-of-day. This is acceptable — a net-worth
  tracker does not need tick data — but it means **"day change" is computed against the last
  available close, and the UI must say so rather than implying live pricing.**
- Prices cached locally with a TTL, so the application works offline against last-known values
  rather than showing blanks. Stale prices are marked in the UI.

Twelve Data does not cover Indian mutual fund NAVs; that is why AMFI is a separate, permanent
source rather than a stopgap.

## Storage and secrets

- SQLite, encrypted at rest.
- The database key and every broker API secret live in the OS keychain: Keychain on macOS,
  Credential Manager on Windows, Secret Service on Linux.
- **No secret ever touches the SQLite file or any export.** This is also what makes the future
  Android sync safe — the phone receives positions, never keys.

## Error handling

Ingestion is where this will hurt, so the rules are strict:

- One bad row never fails an import.
- Per-record errors collect into an import report the user can read and act on.
- Partial imports commit, with failures surfaced and individually re-runnable.
- Unresolved instruments queue for review rather than being dropped or guessed. Imports always
  complete; the queue never blocks.

Silent data loss in a net-worth tool is worse than a visible question.

## Testing

- **Golden-file tests are the backbone.** Real-but-redacted CAS PDFs and exchange CSVs in, expected
  JSON out. This corpus is what lets a stranger contribute a new broker format without breaking
  anyone's numbers, and it is the project's most valuable asset after the schema.
- Property tests for the valuation engine: FIFO invariants, XIRR sanity bounds, position-fold
  correctness.
- No real user statements in the repository. The corpus is redacted and synthetic.

## Stack

**Tauri v2**, with a deliberately thin Rust core.

- Rust: storage, encryption, keychain access, HTTP.
- TypeScript: parsing, valuation, and the entire UI.

Rationale: Tauri v2 is the only option that serves all three surfaces from one frontend codebase —
desktop, Android, and a plain SPA build for self-hosting. Installers are ~10–20MB against Electron's
150MB+, which matters when GitHub Releases is the sole distribution channel. Keeping the heavy logic
in TypeScript keeps the contribution barrier low for the parts contributors will actually want to
touch: adding a new broker's statement format.

## Subsystem decomposition

Each gets its own spec, plan and branch.

| | Subsystem | Depends on | Phase |
|---|---|---|---|
| A | Core — schema, encrypted store, key vault, account model | — | v1 |
| B | Statement ingestion — CAS parser, CSV mapping framework | A | v1 |
| C | Live adapters — plugin contract, crypto exchanges | A | v1 (crypto only) |
| D | Valuation engine — prices, NAV, FX, allocation, P&L, XIRR | A | v1 |
| E | Desktop UI | A, D | v1 |
| F | Pairing protocol + Android client | A, E | v2 |
| G | Self-hostable web build | E | v2 |
| H | MCP server / AI layer | A, D | v3 |

B, C and D are largely independent once A fixes the schema, so they parallelise cleanly.

## Regulatory posture

A read-only tracker that makes no recommendations is not a regulated activity. The moment the
application suggests buying or selling, or offers model portfolios, it approaches SEBI Investment
Adviser or Research Analyst territory. The future AI layer must therefore be framed strictly as
analysis of the user's own data — performance, allocation, XIRR, tax lots — and never as advice.
This line is cheap to hold now and expensive to walk back.

## Open questions

None blocking. Deferred decisions are recorded in the subsystem specs as they are written.
