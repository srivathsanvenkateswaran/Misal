# Misal — working conventions

## Git identity

Personal account only: `Srivathsan Venkateswaran <srivathsanvenkateswaran@gmail.com>`.
The personal SSH key is scoped to this repo via `core.sshCommand`. Never use the work account
(`devathsan`) or the `gh` CLI for this project.

## Commit messages

Conventional Commits: `type(scope): subject`, imperative mood, lowercase subject, no trailing
period. Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `build`.

**No AI attribution, ever.** No `Co-Authored-By: Claude`, no "Generated with Claude Code", no model
names. Commit messages end at the last line of content.

## Branching

One branch per feature, carrying **both** its spec and its implementation.

```
feat/<subsystem>-<short-description>
fix/<short-description>
docs/<short-description>     # only for genuinely standalone docs
```

**Never create spec-only branches.** A feature's spec and the code implementing it belong on the
same branch and merge together. Splitting them doubles the merge commits and separates a decision
from its consequence in the history.

Specs live in `docs/specs/YYYY-MM-DD-<topic>.md` and are committed on the feature branch that
implements them.

## Workflow

1. Write the spec on the feature branch.
2. For anything with a UI, produce reviewable HTML mockups and get explicit approval **before**
   writing implementation code. This is not optional.
3. Implement, with tests.
4. Open a PR.

Parallelise aggressively: independent tasks should be fanned out to concurrent agents rather than
run in sequence. Only serialise genuinely interdependent work.

## Worktrees

Encouraged for parallel work. Clean them up when finished — but first salvage any worktree-only
notes or documents into the merged history or the main working directory. Nothing of value is
allowed to disappear with a deleted worktree.

## Data handling

- Never commit real financial statements, exports, or database files.
- The parser test corpus in `tests/fixtures/` is redacted or synthetic only.
- Secrets belong in the OS keychain, never in the database, never in an export, never in the repo.

## Product line not to cross

Misal reports on data the user already owns. It does not recommend, advise, or offer model
portfolios — that would put it near SEBI Investment Adviser territory. Analysis features must stay
framed as analysis of the user's own holdings.
