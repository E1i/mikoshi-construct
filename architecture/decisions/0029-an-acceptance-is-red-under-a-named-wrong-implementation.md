# 0029 — An acceptance criterion is shown red under a named plausible wrong implementation

Status: accepted · 2026-09-23

## Context

[0027](0027-an-acceptance-is-red-before-the-implementation-exists.md) requires an acceptance to be red
before the implementation exists. That shows the check runs; it does not show that it tells the correct
implementation apart from a plausible wrong one. A criterion that stays green under a wrong
implementation is green by construction and cannot be falsified.

The question was raised, and deliberately left open, by the observation *An acceptance played a second
role at 0027's first use, and the rule describes only the first* in [observations.md](../observations.md).
It named its own trigger: a second acceptance that turns out to be a guard against a wrong fix, in a
task unrelated to that one. The attach and detach pair met it several times over, and the occurrences
are in the observation *Pre-registered predictions across an attach and detach pair*.

This is a new number rather than a wider 0027, for the reason 0027 gives about the ladder: a rule whose
scope grows silently changes every citation already made of it.

## Decision

1. For every acceptance criterion that guards a property (not the mere presence of a file or string),
   the brief names one plausible wrong implementation — one a reasonable implementer would actually
   reach for, not one chosen because it is easy to catch.
2. Before the run, the brief records which assertion is expected to turn red.
3. After the implementation is green, exactly that wrong implementation is applied, the suite is run,
   the assertion that turned red is recorded, and the change is reverted byte for byte from a copy.
4. If nothing turns red, the pull request says the criterion does not tell that implementation apart.
   The criterion is not silently kept as a guard.

One named mutation per criterion; no mutation framework.

## Evidence

| Wrong implementation | Expected red | Observed |
|---|---|---|
| attach also writes over a tracked file outside its carrier set (`AGENTS.md`) | the acceptance that attach plans only create operations | red through the target-set assertion, and twice through `git status`; the "every operation is create" half stayed green, because the mutant labelled its own operation `create` |
| the collision check moved after the exclude block is written | exclude bytes unchanged | within the refusal acceptance, red only through the exclude bytes, since the tree listing cannot see `.git/`; outside it, the race test also turned red, on the shape of the failure rather than on the property, and was rewritten to assert the property |
| detach leaves empty directories | the round trip, through a listing that carries directory entries | red, and the counts in three other cases with it |
| detach removes `.construct/` recursively | the case with files attach did not write | red |
| the index reader assumes a 20-byte hash | the sha256 fixture | red (offset out of range) |

The first two rows ran on the attach pull request and are recorded in the session that ran them; that
pull request's description does not carry them. The last three are in the detach pull request's
description.

Three earlier occurrences preceded these. The check that no source file is ignored by both version
control and the linter was first built on the tracked-file list and stayed green when the real ignore
pattern was reintroduced — green by construction, caught by mutation, and the reason
[0014](0014-a-check-answers-only-about-what-it-was-shown.md) requires every new check to be proven by
mutation. The import-boundary guard that a file importing nothing internal carries no empty entry was
green before its change by design and named its wrong implementation, an entry added by ceremony; its
pull request does not record that the wrong implementation was applied and run. And
[0028](0028-a-model-ahead-of-the-reader-is-a-state.md)'s second axis was red only under a named wrong
fix, catching the version error in the reader and returning nothing — the first case where one was
named, applied and run, which is the observation this record answers.

## Consequences

- Criteria that read a value the implementation sets itself are exposed (see the `create` row). Such a
  criterion must read an outside witness: the filesystem, the git index, `git status`.
- The prediction of *which* assertion turns red is more precise than "red", and is recorded before the
  run.
- Cost: one extra run per named mutation.

This does not replace 0014, which proves that a new check can fail at all. This one asks a criterion to
fail against a specific wrong implementation that was plausible for the task in hand, and to say in
advance where.

## Enforced by

L1 review. Nothing mechanical records that a mutation was named, applied and reverted, so a criterion
that skipped the step and one that passed it look the same afterwards. It becomes checkable when a run
leaves the named mutation and its red result as evidence a second party can read, which is the same
carrier [0027](0027-an-acceptance-is-red-before-the-implementation-exists.md) says it lacks.

See also [0031](0031-the-cli-owns-the-mutation-the-runner-owns-execution.md), which sets the boundary for the command that would leave that evidence.
