# 0051 — A ledger row carries the sketch its run started from

Status: proposed · 2026-10-05

## Context

The implement step costs about three times as much from a sketch as from a clean tree, so a forecast that mixes
the two is wrong for both. [0043](0043-the-ladder-starts-from-the-sketch.md) made the sketch part of the brief and the
build's handle names it, but step 4 of the implement skill copied only the two hashes into the ledger row, so the
flag was lost where the run was recorded. The Ghost journal holds it, but only for Ghost runs, and a user's repository
has no journal.

## Decision

1. **A ledger row may carry `sketch`** (ledger-row 1.2): the 40-hex `sha` of the `sketch` in the handle the build
   printed, or `null` when the handle's `sketch` is `null`, a run from a clean tree. It is optional, and a row without it
   says nothing about it; `undefined` is never read as `null`.
2. **Step 4 copies it** from the handle like the two hashes, whatever the status, and never computes it again.
3. **The forecast reads the field first and the Ghost journal second.** `ghosts:expect-sample --sketch` takes a row's
   sketch from its field, else from the journal's `task` line; a row neither names is counted on neither side and named
   in the notes. When the two disagree the field wins; the disagreement is not checked, because both copy one sketch.
4. **The head line of `expect:` stays a whole-run forecast.** Only the step `implement` is split, as it already was.
   `construct cost --expect` takes no `--sketch`; that flag is a card of its own.

## Consequences

Rows written as 1.1 are read as they are and never rewritten ([0021](0021-a-record-of-the-past-is-not-edited.md)).
The ledger stays L0 ([0003](0003-run-ledger-stops-at-l0.md)). The contour `$id` moves, which `semantic-diff` classes as
breaking, so the changeset is `minor` below 1.0.0.

## Reversed when

A reader of the ledger other than the forecast needs the branch and not only the sha, or the journal and the field are
found to disagree on a run that matters.

## Enforced by

- L3 tests: `tests/contract/contours-ledger.test.ts`, `tests/ledger-sketch-field.test.ts`,
  `scripts/tests/ghosts/expect-sample-ledger-sketch.test.ts`.
- L1 review: the step 4 prose, which is L0 text like the rest of step 4.
