# 0058 — MORSE approves a brief of every risk

Status: accepted · 2026-10-09 · owner decision D-56

## Context

[0053](0053-morse-approves-a-brief-the-risk-matrix-does-not-reserve-for-the-owner.md) point 2 kept R1 briefs with
the owner: `ghosts:hash --by morse` refused an R1 card with "waits for the owner". Every other condition of 0053 —
no `unclear:` field, no fall, no revocation, a forecast within p75 — and the hard preflight bind a brief whatever its
risk, so the R1 refusal was the only check that judged nothing the others did not.

## Decision

This replaces point 2 of 0053 and nothing else. Points 1 and 3–7 stand: the hash, the conditions, the journal first,
the launcher's morse line, the revoke, the falls.

- `pnpm ghosts:hash <brief> --by morse --card <N>` approves a brief of every risk, R1 included, under the conditions of
  0053 point 3, and only when the build and the hard preflight are green.
- The risk is still computed from the card's touches (`src/card/risk.ts`, the matrix of #585) and the approval event keeps
  its `risk` field, so an R1 approval by MORSE is visible in the journal.
- The owner's revoke is unchanged. A card with `decision: owner` is still merged by the owner
  ([owner-merges.md](../owner-merges.md)).
- This is a standing delegation; it does not lapse with a run.

## Consequences

- An R1 brief no longer waits at `hash` for the owner; it waits only when a condition refuses it.
- Review and the merge rules still decide who merges an R1 change.

## Enforced by

- L3 tests: `scripts/tests/ghosts/morse.test.ts` (an R1 brief with a green preflight is approved, with a red one refused
  and nothing written, and the other conditions still bind R1).
- L1 review for what the risk matrix classes as R1.

## What would reverse it

A MORSE-approved R1 brief whose run the owner would have refused at the hash, or a fall rate on MORSE-approved R1 cards
above the rate on owner-approved ones.
