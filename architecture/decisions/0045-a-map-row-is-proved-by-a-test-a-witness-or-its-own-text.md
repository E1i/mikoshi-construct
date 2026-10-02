# 0045 — A map row is proved by a test, a witness of the brief, or its own text

Status: accepted · 2026-10-02

## Context

[0039](0039-done-is-every-requirement-mapped-and-nothing-stubbed-or-unwired.md), Decision 1, has the done
check decide that "each cited test is a live test that reaches the cited code". The only proof a row of the
requirement map could carry was an `it` or `test` that reaches the cited file. Many requirements of a ladder
brief are not held that way. Some are held by prose: a decision record, a table row, a paragraph of an agent
file. Others are held by a shell witness the brief itself runs. The review of PR #437 (N1) found that an
honest map of #62's own run FAILed with `no test cited` for A7–A10, A12, D11 and D14. A map could then
pass only by citing a test near the thing, which D11's paragraph forbids.

## Decision

Done check v0.2 refines 0039's Decision 1. A row of the map is proved by one of three things.

1. **A test**, as before: a live `it` or `test` in a test file that reaches the cited code.
2. **A witness of the brief**, `{ "witness": "Wn" }` in the row's `tests`. It counts when n is between 1 and
   the number of `witnesses` in the args file, and the sha256 of that witness's command equals the
   `witnessDigests` entry for its criterion, the digest check-acceptance writes. Otherwise the row FAILs
   with `Wn is not a witness of the brief` or `Wn does not match its digest`. The reach check does not
   apply to a witness.
3. **Its own citation, for a row that cites only non-code.** Such a row needs no test when every code
   citation resolves and none is a source file (parseable and not a test path, the predicate D9 uses).
   A PASS lists these rows under `text only:` and puts their count on its first line,
   `PASS · text only N`, so a requirement closed by prose is seen before anything else. A row that
   mixes code and non-code still needs a test or a witness.

0039 is not rewritten. Its other decisions stand: only PASS or FAIL, a FAIL makes the verdict candidate
FAIL, `checked by name only` on a PASS, and the check lives in the review.

## Consequences

- A requirement held by a record or by a shell witness can be mapped honestly, so D11's paragraph in
  `.claude/agents/review.md` makes the done check a step of every review of a ladder run.
- A witness is credited for being the brief's own command, unchanged since the brief was built. The check
  does not run it; the ladder and the review already did.
- A text-only row proves that the cited line exists, not that the prose says what the requirement asks.
  That reading stays with the reviewer, and the count on the first line is what makes it visible.

## Enforced by

- L3 tests of the checker (`scripts/tests/done/check.test.ts`, under `pnpm run quality`): a witness entry
  that counts only with the right digest and index, and a text-only row that a PASS counts and lists while
  a mixed row FAILs.
- L1 review for reading what a text-only row cites.

## What would reverse it

A PASS whose `text only` rows close a requirement that a later reader finds was held by code no test
reaches. Then text alone would need a test or a witness again, or a reviewer's sign-off of its own.
