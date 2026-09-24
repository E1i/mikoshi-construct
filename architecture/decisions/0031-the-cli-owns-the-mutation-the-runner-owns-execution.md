# 0031 — The CLI owns a mutation from edit to verdict; running the repository's tests stays with the runner

Status: accepted · 2026-09-24

## Context

[0029](0029-an-acceptance-is-red-under-a-named-wrong-implementation.md) asks for one named wrong
implementation per acceptance criterion: applied, run, the red assertion recorded, the change reverted
byte for byte from a copy. It is enforced by review alone, because nothing leaves the mutation and its
result as evidence a second party can read. A `construct mutate` command would leave that evidence.

A mutation has to be run against the repository's own test suite. The CLI may not run it: the security
invariant that the CLI starts exactly one child process, `pnpm --version`, and executes no code it did
not ship ([security-invariants.md](../security-invariants.md)), and
[0007](0007-doctor-executes-nothing.md) for `doctor`. Widening that invariant with a second exemption was
considered and not taken.

The obvious restatement, "the CLI does not run code", is already the invariant and decides nothing new.
It does not say which parts of a mutation run the CLI should own, so it would leave every later case —
a `mutate run`, a watch mode, a retry — to be argued again.

## Decision

The boundary is **who defines the side effect**.

- The CLI owns every step whose effect it defines itself and can name byte for byte: the **mutation**
  (one `find` → `replace` in one file, refused unless `find` occurs exactly once), its **provenance**
  (a record of which mutation, which file, the file's sha256 before and after, and when it was
  applied), its **restoration** (from the copy it took, confirmed by a byte comparison), and the
  **judgment** (the outcome, read from a test report as data).
- Running the repository's tests stays outside the CLI and is done by the runner — the agent, or a
  person. What those tests do is defined by the repository's code, not by the CLI, so the CLI does not
  own it and does not start it.

The two halves meet only through files: the CLI writes the mutated source and its record; the runner
writes a test report; the CLI reads the report through an adapter for its format. A report is evidence
only when it is newer than the mutation it is judged against, and the mutated file is restored only
when it still has the content the CLI wrote. A file that changed after the mutation was applied is
someone else's edit, and it is left as it is.

The security invariant is unchanged and gains no exemption.

## Consequences

- A mutation takes three steps, apply → the runner runs the suite → judge, not one.
- The verdict is only as good as the report the runner hands over. The CLI can check that the report is
  well formed and newer than the mutation; it cannot check that the report came from running this
  suite on this tree. That is the price of not executing, and the output says what the verdict rests on.
- Because the CLI does not see the run, it checks what it can see: that the file is still what it
  wrote, before restoring it, and that the restoration matches the copy afterwards. A failure of either
  is a failure of the tool, reported apart from the mutation's outcome.
- The provenance record is local working state in `.construct/`. It is not part of the public contract
  of [0030](0030-public-contract.md); what is public is the command and its `--json` output.
- Any later proposal to run the suite from the CLI is a change to the security invariant, argued there,
  not a convenience added to `mutate`.

**What would reverse this.** If judged runs regularly end with no usable report — stale, missing or
from the wrong tree — so that the three-step form costs more evidence than the invariant protects,
the question reopens as a change to the security invariant.

## Enforced by

The execution half: the existing `spawnPolicy` block in `eslint.config.mjs` and its samples in
`tests/dependency-policy.test.ts`, unchanged. The ownership half: L1 review until the tests of the
`mutate` command land with it.
