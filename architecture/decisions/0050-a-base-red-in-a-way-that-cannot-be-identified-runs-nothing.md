# 0050 — A base red in a way that cannot be identified runs nothing

Status: proposed · 2026-10-05

## Context

Decision #184 said that a red base runs nothing: a rung on a red base cannot tell its own failure from one that was
already there. That holds only while the failures are not named. `scripts/construct/check-baseline.mjs` prints, per step
of the harness script, the exit code and the identities of its failures, and the sha256 of the sorted set.
This record narrows #184 to one rule: a base red in a way that cannot be identified runs nothing.

## Decision

1. **A base red in a way that cannot be identified runs nothing.** That is a verdict with no `steps`, a red step whose
   failures no parser read (`failures: null` or empty), or a diff beyond the sketch. Status `base red`.
2. **A base is identified by its steps, the failure identities of each step and the pinned sha256.** The build splits the
   script `harness.command` names at its top-level `&&` into `harness.steps` and carries the brief's
   `Base failures: sha256 <64 hex>` line into `harness.baseFailuresSha256`. A red base whose every red step has
   identities runs only when the pin equals the `setSha256` the harness reported; otherwise `base unverified`, the
   reason naming the pin and the sha256 seen. A green base needs no pin.
3. **A rung on an identified red base passes when it adds no failure.** Each step's failures after the change must be a
   sub-multiset of the base's; a step green on the base and red after fails whatever it parsed. The result carries
   `onRedBase`, `knownBaseFailures`, `newFailures: 0` and `fixedOnTheWay`. A failure the base had and the tree lost is
   allowed and listed. The next implementer prompt carries only the new identities, never the failure excerpt, and the
   implementer prompt names the base failures as known and out of scope.

## Consequences

- A test inside a file that fails as a whole is one identity, `<suite>`; a new failing test in that file is not seen
  after the change. This is the known blind spot.
- A pass on a red base is reported as `passed on a red base: N known, 0 new`, never as a green one.

## Reversed when

A pass on a red base is found to have hidden a failure the identities did not distinguish.

## Enforced by

- L3 tests: `tests/ladder-red-base.test.ts` and `tests/check-acceptance-build.test.ts`; `tests/ladder-run.test.ts`
  keeps the two positive controls.
