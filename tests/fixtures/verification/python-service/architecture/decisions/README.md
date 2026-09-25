# Decisions

One file per decision that shapes what this project is allowed to claim. A decision lands here when
reversing it would cost more than making it did, or when a later reader would otherwise re-open it
from scratch. Read this directory before re-opening a question it already answers, and add a record
rather than restating a decision in a plan or a commit message.

Each record carries four sections: the context it was taken in, the decision itself, the
consequences it accepts, and how it is enforced.

Enforcement is named on a scale, so the strength of a decision is visible rather than implied:

| Level | Enforced by |
|---|---|
| L0 | text only — nothing checks it |
| L1 | review — a human is the check |
| L2 | a local hook — bypassable with `--no-verify` |
| L3 | CI — it runs on every push |
| L4 | CI that blocks the merge |

Every level above L0 presumes a mechanism that **can report a failure**. L3 and L4 differ over
whether a failure blocks a merge; L0 and L3 differ over whether a failure can be raised at all. A
check that is green whether or not the invariant holds reports nothing and is L0, however much
machinery stands behind it.

A decision enforced only by review says so; that is the honest answer, not a gap to hide.

Records are named `NNNN-a-short-title.md` and numbered in the order they were taken.

| # | Decision | Enforced at |
|---|---|---|
