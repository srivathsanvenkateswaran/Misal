# Using Misal

Misal answers one question: **what do I actually own, across everything?**

It does that by reading statements and exchange data you already have access to, and it is careful
about the difference between what it knows and what it is guessing. That second part shapes most of
what you will see.

---

## The one idea worth understanding first

Some of your accounts can tell Misal their full history. Others can only tell it what you hold
today.

- A **CAMS or KFintech mutual fund statement** requested "Detailed" from inception carries every
  purchase and redemption you ever made. Misal can compute cost basis, realised gains and returns
  from it.
- An **NSDL or CDSL statement**, or a **crypto exchange balance**, is a photograph of today. Misal
  knows *what* you hold, not *what you paid*.

Misal calls the first kind **ledger-backed** and the second **holdings only**, and it never mixes
them up. A figure that needs history is shown only for the accounts that have it, always beside a
number saying how much of your portfolio that figure actually covers.

**When Misal cannot compute something, it says so instead of showing a zero.** A blank or a dash
would read as "nothing", and "nothing" is a different claim from "I don't know". You will see
"Not priced" or "No transaction history" where another app would quietly show ₹0.

---

## Getting your data in

### Mutual funds — the best single source

One statement covers every fund you hold across every AMC.

1. Go to [CAMS CAS](https://www.camsonline.com/Investors/Statements/Consolidated-Account-Statement)
   or [KFintech](https://mfs.kfintech.com/investor/General/ConsolidatedAccountStatement).
2. Choose **Detailed** — not Summary. Summary has no transactions, and Misal can only treat it as
   holdings-only.
3. Set the period from **01-01-1990** to today. This is what makes it a complete history.
4. Choose **all folios**, including zero-balance ones, so funds you have exited are included.
5. You will be asked to set a password. Remember it — you will type it into Misal.

The statement arrives by email as a password-protected PDF. In Misal: **Import** → choose
*CAMS / KFintech* → pick the file → enter the password you chose.

### Shares and ETFs — the depository statement

NSDL or CDSL emails a Consolidated Account Statement monthly, covering every demat account under
your PAN. Its password is **your PAN in capitals**.

Import it the same way, choosing *NSDL / CDSL*. It gives Misal your holdings; it does not give a
full transaction history, so those accounts show as holdings-only.

### Broker CSV exports

Most brokers export a tradebook as CSV. Zerodha's Console export is supported directly. Import →
*CSV export*.

### Crypto exchanges

**Exchanges** → choose Binance or CoinDCX → paste an API key and secret.

> **Read the warning on that screen before you paste a CoinDCX key.** CoinDCX does not offer
> read-only API keys. Any key you create there can also trade and withdraw, and there is no way for
> Misal — or you — to check what a given key is allowed to do. Misal never constructs a trade or
> withdrawal request and enforces that in two independent layers, but you are trusting that code.
> Binance is different: it *does* offer read-only keys, and Misal refuses a key that can withdraw
> before storing it.

Your keys go into your OS keychain, never into the database and never into an export.

The first sync is slow — Binance has no way to ask "what have I traded", so Misal has to check a
large list of trading pairs. It reports progress. Later syncs take seconds.

### US brokerages — E\*TRADE, Fidelity, Schwab

These have no usable API for individuals. Export a CSV from their site and import it, or enter
holdings manually. RSUs and ESPP shares typically come through here.

---

## Prices

Nothing is fetched automatically. **Refresh** shows what is stale and what has no price source at
all, then fetches when you ask.

- **Mutual fund NAVs** come from AMFI — official, free, no key needed.
- **Shares and crypto** come from public endpoints.
- **Anything no provider covers** can be given a price by hand in Settings. This is not a
  workaround; for some instruments it is the only honest option, and a manual price always wins
  over a fetched one.

Misal contacts a short, fixed list of hosts and nothing else. Settings shows you that list.

---

## The screens

**Dashboard** — net worth, and the calibration bar across the top showing how much of it the deeper
figures can actually speak for. If part of your portfolio is holdings-only, that bar is where you
see it, hatched.

**Holdings** — everything you own, groupable by asset class, account or instrument. Rows from
holdings-only accounts show a stated reason in the cost and gain columns rather than a zero.

**Accounts** — what is connected and what each can tell Misal.

**Instruments** — one holding across every account, its lots, and its transactions.

**Import** — statements in, plus the review queue.

**Refresh** — prices and exchange rates.

**Settings** — preferences, provider keys, manual prices, export, account deletion, and a plain
statement of what leaves your machine.

---

## The review queue

Sometimes a statement names something Misal cannot identify — an unusual fund, a new listing, a
crypto pair it has no mapping for.

**It never guesses.** The import completes, and the unidentified holding goes to a queue with its
value held *out* of your net worth and stated separately. So your total is understated by a known,
displayed amount rather than being wrong by an unknown one.

You can **map** it to the right instrument, or **dismiss** it. A dismissed entry keeps being
counted as withheld, because dismissing means "stop asking me", not "this is worth nothing".

---

## Exporting

Settings → Export writes CSV or JSON of your holdings and transactions. Money exports both as exact
integer paise and as a decimal, so a spreadsheet cannot round it on the way in. No key or secret
ever appears in an export.

---

## What Misal will not do

It does not recommend, advise, rank, or suggest. It reports on data you already own. That line is
deliberate — the moment a tool suggests buying or selling in India it is near SEBI Investment
Adviser territory, and this is a personal project, not a registered adviser.

It also does not fetch anything from your broker on your behalf, does not read your email, and does
not ask for your broker login. Everything comes from a file you exported or a read-only key you
created.

---

## If something looks wrong

Every figure traces to the document it came from — the small marks in the left margin of each row
name the source. If a number disagrees with your broker, that mark tells you which statement Misal
read it from.

Known problems are tracked in [known-issues.md](known-issues.md), which is kept honest rather than
short.
