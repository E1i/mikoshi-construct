# 0059 — A merge past the review round limit needs an allow-merge decision

Status: accepted · 2026-10-14 · owner decisions on card #968 · amended 2026-10-15 by D-122 on card #971

## Context

D-104 caps the review → answer rounds on one pull request. A PR that reaches the cap gets no more review and no
more answers, and without a pass on its head the bus never makes it a merge candidate, so the owner had no way to
let the bus merge it. #968 gives the owner that way out through an owner decision. Any text that merely names a PR
and its sha does not count, because it can just as well be a hold, a question or a withdrawal.

## Decision

- An owner decision in force (`decisionsInForceAt`) lets the bus merge PR #N past the round limit only when its
  text begins with `allow-merge PR #N at <full 40-character head sha>`. Both stored forms are live: the
  `decision.recorded` event `pnpm decisions:add` writes holds the text without `[owner]`, and a row that
  `decisions.imported` folds from the owner's decisions file keeps it, so the phrase may follow an optional `[owner] `.
  Anything may follow the phrase, the ` · until <term>` tail included.
- A decision that names the PR and the sha anywhere else in its text does not authorise the merge, including one
  that negates or withdraws `allow-merge`.
- The decision covers that PR at that head only. When the head moves, it covers nothing.
- The round counter is not reset, and the review and answer queues stay closed for the PR. CI green, base `main`
  and the version pull request lock still hold.
- The decision is the owner's word on that head, so `mergePolicy` does not override it where the rule is the
  owner's own path: `owner_by_risk`, `owner_without_shard` and `r1` yield to it. `version_pr`,
  `security_invariants`, `reserved` and `decision_unread` still deny.
- A decided PR is a merge candidate while GitHub reports it `clean` or `blocked`, because the missing `review`
  context is itself what blocks it. After the version lock and before `PUT /merge`, the executor sets the `review`
  status `success` on the decided head, with the description `owner decision D-N, no review pass`, then reads the
  PR again and merges only when it is still at that head and `clean`. `merge.done` carries the rule
  `owner_after_round_limit`, and its detail names D-N.
- The owner writes the decision with `pnpm decisions:add`; the bus only reads it.

## Consequences

- The owner writes, for example: `pnpm decisions:add "[owner] allow-merge PR #N at <full head sha>"`.
- A decision written in another form leaves the PR where the round limit stopped it, which is the safe failure.

## Enforced by

- L3 tests: `scripts/tests/bus/round-limit-decision.test.ts` (no decision, another PR or sha, no marker, a negated
  or withdrawn marker, and a lapsed term each merge nothing; the status lands only on the decided head, before
  the merge, and after the version lock; a refused status merges nothing).
- L3 tests: `scripts/tests/bus/executor.test.ts` (a PR blocked only by the review context and an owner-path PR each
  merge under the decision; `security_invariants` still denies; without a decision neither merges).

## What would reverse it

An owner decision in this form that the bus merged against the owner's intent, or a recurring need to merge past
the limit that is better met by raising the limit itself.
