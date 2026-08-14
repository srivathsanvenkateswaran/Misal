# Trying Misal

Someone handed you this to try. Here is what it is, what to expect, and what would be genuinely
useful to tell them afterwards.

**Misal shows you everything you own in one place** — mutual funds, shares, US stock, gold, crypto —
by reading statements you already download. It runs entirely on your own machine. There is no
account, no sign-in, no server, and nothing is uploaded anywhere.

---

## Read this part before you start

This is **version 0.1.0, a pre-release**. It has been through five rounds of adversarial code review
and has well over 1,500 tests, and it has still never been run against a real statement by anyone
except its author. You are the first.

So:

- **Keep the statement files you import.** If a number looks wrong, having the original file is what
  makes it fixable.
- **Don't use it for your tax return.** Not this version.
- **Check anything you would act on** against your broker before acting on it.

What it should be reasonable at: what you own, where it is, how it is split across asset classes,
and quantities from a single import.

Misal is deliberately careful about the difference between what it knows and what it is guessing.
Where another app would show ₹0, Misal says "Not priced" or "No transaction history" — because a
zero reads as "nothing", and "nothing" is a different claim from "I don't know". If you see a lot of
those, that is the app being honest, not broken.

---

## 1. Install it

Download from **[Releases](https://github.com/srivathsanvenkateswaran/Misal/releases)**:

| Your machine | File |
|---|---|
| Mac (M1/M2/M3/M4) | `Misal_0.1.0_aarch64.dmg` |
| Mac (older, Intel) | `Misal_0.1.0_x64.dmg` |
| Windows | `Misal_0.1.0_x64-setup.exe` |
| Linux | `misal_0.1.0_amd64.AppImage` |

**Your computer will warn you that it can't verify the app.** That is expected and it is not a virus
warning — it means nobody paid for a code-signing certificate (Apple charges $99/year, Windows is
comparable, and this is a free personal project). Your OS cannot tell "unsigned" from "malicious",
so it says the scariest version.

- **Mac:** right-click the app → **Open** → **Open**. If macOS says "damaged", open Terminal and run
  `xattr -dr com.apple.quarantine /Applications/Misal.app`, then try again.
- **Windows:** SmartScreen → **More info** → **Run anyway**.
- **Linux:** `chmod +x misal_0.1.0_amd64.AppImage` then run it.

You should be suspicious of any download that tells you to click past a security warning. The reason
to trust this one is that the entire source is readable and you can build it yourself instead —
[INSTALL.md](INSTALL.md) has that route.

**On first launch your system will ask for your password once.** That is your OS keychain, not
Misal. Misal encrypts its database and keeps the key in your keychain rather than in a file. Choose
**Always Allow**.

---

## 2. Get some data in — the fifteen-minute version

You do not need all of these. **One is enough to see whether the app works.**

**The single best one: your mutual fund statement.** It covers every fund you hold across every AMC,
with full transaction history.

1. Go to [CAMS](https://www.camsonline.com/Investors/Statements/Consolidated-Account-Statement) or
   [KFintech](https://mfs.kfintech.com/investor/General/ConsolidatedAccountStatement)
2. Choose **Detailed** (not Summary), period **01-01-1990 to today**, and **all folios**
3. Set a password when asked — you will type it into Misal
4. It arrives by email. In Misal: **Import** → *CAMS / KFintech* → pick the file → enter that password

**Shares and ETFs:** NSDL or CDSL email you a statement monthly. The password is **your PAN in
capitals**. Import → *NSDL / CDSL*.

**Crypto:** Exchanges → Binance or CoinDCX → paste an API key. Read the warning on that screen
first — CoinDCX does not offer read-only keys, so please use a throwaway or skip crypto entirely for
a first test.

Then hit **Refresh** to fetch prices. Nothing is fetched without you asking.

---

## 3. What would be useful to report

Anything at all, but especially:

- **A number that is wrong.** The single most valuable thing. Every figure traces to the document it
  came from — the small marks in the left margin of each row name the source, which is what makes a
  wrong number diagnosable.
- **A number that is missing** where you expected one, or a "Not priced"/"No history" that seems
  unfair.
- **A statement that failed to import**, or imported fewer rows than it should have.
- **Anything confusing** — a label you had to re-read, a screen you did not know what to do with.
  That counts as a bug.
- **Anything that crashed**, obviously.

### Please don't send your actual statement

Not to anyone, including the author. It has your PAN, your folio numbers and your whole financial
position in it. If a file fails to import, say **which provider it came from** and **what went
wrong** — that is usually enough. If it truly needs the file, redact it first, and understand that
sending it is a decision only you can make.

The same goes for screenshots: crop or blur the amounts.

Report at **[github.com/srivathsanvenkateswaran/Misal/issues](https://github.com/srivathsanvenkateswaran/Misal/issues)**
or just tell whoever gave this to you.

---

## What Misal will not do

It does not recommend, advise, rank or suggest anything to buy or sell. It reports on data you
already own — that line is deliberate.

It never asks for your broker login, never reads your email, and only contacts a short fixed list of
price sources, which Settings shows you.

---

## Getting rid of it

Delete the app, then delete the data folder — [INSTALL.md](INSTALL.md#where-your-data-lives) lists
where it is for each system. On a Mac you can also remove the keychain entry: Keychain Access →
search `dev.misal.app` → delete.

Nothing of yours is anywhere else, because nothing of yours ever left your machine.

---

**More detail:** [How to use it](USING.md) · [Installing and building](INSTALL.md) ·
[Known issues](known-issues.md), which is kept honest rather than short.
