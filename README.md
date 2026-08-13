# Misal

**One view of everything you own.**

Misal is a local-first desktop application that consolidates investments scattered across Indian
brokers, mutual funds, US employer-equity accounts and crypto exchanges into a single honest view of
net worth.

Your data stays on your machine. There is no account, no cloud, and no server.

Named after the dish: many components prepared separately, assembled into one bowl, each keeping its
own character.

**[Install](docs/INSTALL.md)** · **[How to use it](docs/USING.md)** · **[Known issues](docs/known-issues.md)**

---

## Status — read this before trusting a number

Misal is **early**. It is built and tested, but it has not been used in anger by anyone.

| | |
|---|---|
| **Trustworthy** | Net worth, holdings, quantities, allocation, what you own and where |
| **Recently fixed, not yet field-tested** | Realised gains, XIRR, the 12-month history chart |
| **Do not use for** | Filing a tax return, without checking the figures against your own statements |

Two independent adversarial reviews have run over this codebase. Between them they found **20
confirmed defects**, including three that produced confidently wrong money figures — a mutual fund
redemption that inverted realised profit into a loss, foreign disposals understated roughly 87-fold,
and a history chart converting past months at today's exchange rate. All are fixed, each with a test
that fails without the fix. A third review is running.

Every one of those bugs existed in a codebase with a passing suite of over a thousand tests. That is
the honest reason for the table above: the tests were dense over the shapes they happened to
contain, and every defect lived in a shape no fixture covered.

So: use it to see what you own. Check anything you would act on.

---

## Why it works the way it does

**Local-first, not a service.** Three reasons, any one sufficient. Custodying other people's broker
keys and net worth is an uninsurable liability for an unfunded project. India's Account Aggregator
framework — the only sanctioned route to consolidated financial data — requires an RBI, SEBI, IRDAI
or PFRDA licence, realistically ₹5–25 lakh over 5–10 months, which is structurally closed to indie
developers. And a local database is the only way you can later point your own tooling at your own
data.

**Statements first, APIs second.** Every Indian broker API expires its access token daily by
regulatory mandate, so an API-only tool would demand a login ritual across six providers every
morning and be abandoned in a fortnight. Misal is built around consolidated statements — one CAS
file covers every demat holding and mutual fund folio under your PAN — with live connections only
where they can genuinely run unattended.

**Honest numbers.** Some accounts give full transaction history; others only a snapshot of what you
hold today. Figures that need history are shown only where they are real, always with a coverage
figure. Nothing is estimated and presented as exact. When Misal cannot compute something it says so
rather than showing a zero, because a zero reads as "nothing" and that is a different claim from
"I don't know".

**Provenance for every figure.** Each number traces to the document it came from, so when Misal
disagrees with your broker you can find out why.

---

## Surfaces

| Surface | Status |
|---|---|
| Desktop — macOS, Windows, Linux | Built |
| Android — sideloaded APK | Planned |
| Self-hosted web build | Planned |

No iOS build and no Play Store listing. Distribution is GitHub only.

---

## Contributing

The most useful contribution is a **statement parser**. Adding support for a broker or exchange
means writing one function that turns their export into raw records; the shared pipeline handles
identity resolution, deduplication and reconciliation.

Two rules that are not style preferences:

- **No floating point anywhere near money or quantities.** Money is integer minor units, quantities
  are decimal strings, both as branded types. A lint rule fails the build on `parseFloat`,
  `Number()`, unary `+`, `Math.*` and `toFixed` outside two audited files.
- **Never commit a real statement or export.** The parser test corpus is synthetic or redacted, and
  CI rejects any committed PDF or database file.

Run `pnpm test`, `pnpm lint`, `pnpm typecheck`, and `cargo test --lib` in `src-tauri/` before
opening a PR.

## Non-goals

Misal does not give financial advice, recommend investments, or offer model portfolios. It reports
on data you already own.

## Licence

[AGPL-3.0](LICENSE). You can read, run, modify and share it. If you run a modified version as a
service, you have to publish your changes — which is the point: the reason to trust a tool holding
every credential you own is that you can read what it does.
