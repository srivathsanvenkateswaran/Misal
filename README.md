# Misal

One view of everything you own.

Misal is a local-first desktop application that consolidates investments scattered across Indian
brokers, US employer-equity brokers, and crypto exchanges. Your data stays on your machine. There
is no account, no cloud, and no server.

Named after the dish: many components prepared separately, assembled into one bowl, each keeping
its own character.

> **Status: in design.** No usable build yet. The architecture is specified in
> [`docs/specs/`](docs/specs/); UI direction is being reviewed. Watch the repo if you want to know
> when there is something to install.

## The problem

If you have been earning for a few years in India, your portfolio is probably scattered across
five or six apps: equity in one broker, mutual funds in another, US stocks in a third, RSUs from
your employer sitting in a US brokerage you log into twice a year, and crypto across two or three
exchanges. No single screen tells you what you are actually worth, or how any of it is performing.

Existing tools each solve one slice. None of them span Indian brokers, US employer equity, and
Indian crypto exchanges together — and the ones that come closest want your broker credentials on
their servers.

## Approach

**Local-first, bring your own keys.** Misal reads your data using credentials you control and
stores everything in an encrypted database on your own machine. API secrets live in your operating
system's keychain and never touch the database file or any export.

**Statements first, APIs second.** Every Indian broker API expires its access token daily by
regulatory mandate, so an API-only tool would demand a daily login ritual across six providers.
Misal is built around consolidated statements — a single CAS file covers every demat holding and
mutual fund folio under your PAN — with live API connections where they can actually run
unattended.

**Honest numbers.** Some accounts give full transaction history; others give only a snapshot of
what you hold today. Metrics that need history, such as XIRR and realised gains, are shown only
where they are real, alongside an indicator of how much of your portfolio they actually cover.
Nothing is estimated and presented as exact.

**Provenance for every figure.** Each number traces back to the document it came from, so when
Misal disagrees with your broker you can find out why.

## Planned surfaces

| Surface | Status |
|---|---|
| Desktop — macOS, Windows, Linux | In design |
| Android — sideloaded APK from Releases | Planned |
| Self-hosted web build | Planned |

There is no iOS build and no Play Store listing. Distribution is through GitHub Releases only.

## Contributing

Not yet open for contributions — the schema is still moving. Once it settles, the most useful
contribution will be **statement parsers**: adding support for a broker or exchange means writing
one function that turns their export into raw records, and the shared pipeline handles identity
resolution, deduplication and reconciliation.

Never commit real statements or exported data. The parser test corpus is redacted or synthetic.

## Non-goals

Misal does not give financial advice, recommend investments, or offer model portfolios. It reports
on data you already own.
