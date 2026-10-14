# 0059 — A merge past the review round limit needs an allow-merge decision

Status: accepted · 2026-10-14 · owner decisions on card #968

## Context

D-104 caps the review → answer rounds on one pull request. A PR that reaches the cap gets no more review and no
more answers, and without a pass on its head the bus never makes it a merge candidate, so the owner had no way to
let the bus merge it. #968 gives the owner that way out through an owner decision. Any text that merely names a PR
and its sha does not count, because it can just as well be a hold, a question or a withdrawal.

## Decision

- An owner decision in force (`decisionsInForceAt`) lets the bus merge PR #N past the round limit only when its
  text begins with `allow-merge PR #N at <full 40-character head sha>`, right after the optional `[owner]` writer
  prefix that `pnpm decisions:add` stores. Anything may follow the phrase, an `until` term included.
- A decision that names the PR and the sha anywhere else in its text does not authorise the merge, including one
  that negates or withdraws `allow-merge`.
- The decision covers that PR at that head only. When the head moves, it covers nothing.
- The round counter is not reset, and the review and answer queues stay closed for the PR. Every other merge
  requirement holds: CI green, mergeable clean, base `main`, `mergePolicy`, and the version pull request lock.
- Before `PUT /merge` the executor sets the `review` status `success` on the decided head, with the description
  `owner decision D-N, no review pass`, because branch protection requires that context. `merge.done` carries the
  rule `owner_after_round_limit`, and its detail names D-N.
- The owner writes the decision with `pnpm decisions:add`; the bus only reads it.

## Consequences

- The owner writes, for example: `pnpm decisions:add "[owner] allow-merge PR #825 at <full head sha>"`.
- A decision written in another form leaves the PR where the round limit stopped it, which is the safe failure.

## Enforced by

- L3 tests: `scripts/tests/bus/round-limit-decision.test.ts` (no decision, another PR or sha, no marker, a negated
  or withdrawn marker, and a lapsed term each merge nothing; the status lands only on the decided head, before
  the merge, and after the version lock; a refused status merges nothing).

## What would reverse it

An owner decision in this form that the bus merged against the owner's intent, or a recurring need to merge past
the limit that is better met by raising the limit itself.
