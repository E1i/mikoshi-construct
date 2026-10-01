# 0041 — The ladder reads the args by path and hash

Status: proposed · 2026-10-01

## Context

The `/implement` ladder took its whole args object inline as the Workflow `args`: every witness
command, its base64, its sha256 and the brief's Design. For the four briefs of 2026-09-30 that input
was 44 to 97 KB, of which the base64 alone was 13 to 40 KB, and the session had to type it unchanged.
Two Ghosts stopped before the ladder on that one fact, and three briefs went to hand ladders. Nothing
after the owner's approval could say which text a run had executed: the approved hash stopped at the
launcher, and the chain from it to the result was broken.

A Workflow script has no filesystem, no `import()` and no `Date`, and receives `args` verbatim, so the
script cannot read or hash a file itself. An agent can.

## Decision

1. **The build writes the file and prints a handle.** `check-acceptance.mjs build --brief <agreed>
   --out <argsPath>` writes the whole args object to `argsPath` as one line of JSON, with
   `witnessDigests` as `{ criterion, sha256 }` and no base64, and adds `agreedSha256`, the sha256 of the
   canonical `/implement` text by the rule `pnpm ghosts:hash` uses. On stdout it prints the handle:
   `argsPath`, `argsSha256` (the sha256 of the bytes written), every field of the file except
   `witnesses` and `design`, and `hasDesign`. Without `--out` the build prints the file's JSON as before.
2. **The handle is the Workflow input.** The ladder reads `argsPath`, `argsSha256`, `agreedSha256` and
   `hasDesign`, and no longer reads `witnesses`; an input with no `argsPath`, or an `argsSha256` that is
   not 64 hex characters, is blocked before any agent. The implementer and architect prompts name the
   file and its hash as where `witnesses[]` and `design` are read; no prompt carries a command.
3. **The harness extracts each witness by hash.** The verify prompt gives three fixed lines per
   witness, the first `node scripts/construct/check-acceptance.mjs witness --args <argsPath> --sha256
   <argsSha256> --n N`, which prints the command byte for byte and refuses, with exit 2 and both hashes
   named, a file whose sha256 differs. A refused extraction is reported with `afterExitCode` 2 and an
   empty `ranSha256`.
   Amended (#405): the witness is selected by `--witness-sha256 <sha256>` from the handle's `witnessDigests`, not by `--n N`, and a hash the file does not hold is refused with exit 2 and no output.
4. **`argsSha256` is reported on every call and compared first.** The verdict schema requires
   `argsSha256`, the hex `shasum -a 256 <argsPath>` prints in the working tree. A preflight verdict
   with another hash ends the run `args unverified` with one rung-0 `args mismatch` attempt and no
   rung; a verify verdict with another hash ends it `args unverified` at that rung, before anything
   else of the verdict is read. A `done` result carries `argsSha256` and `agreedSha256`.

## Consequences

- The chain runs from the approved hash, through the agreed file and `agreedSha256`, to `argsSha256`
  as the harness reads it from disk on every call, and into the `done` result. The ledger row and the
  journal still carry neither hash; they are the next link and are not built here.
- The Workflow input drops to 7 to 11 KB for the same four briefs, and nothing the session types is a
  command, a base64 blob or the design.
- The session still transcribes the handle: the criteria, the per-witness digests, the invariants, the
  immutable paths and the harness command. The check mode compares the file with the agreed text after
  the run, so a dropped criterion is caught there; a dropped immutable path in the handle is not.
- The harness agent is trusted to report the hex `shasum` printed rather than the one it was given,
  the same trust as `ranSha256`; a mis-copied hash fails closed at the extraction, which refuses it.
  That an implementer actually read the design from the file is not observable.
- On a hand ladder `agreedSha256` is comparable with the brief's approved hash, and comparing them is
  the session's step.

## Enforced by

- L3 tests: the build, the handle, `agreedSha256` against `pnpm ghosts:hash` and the `witness --args`
  mode (`tests/check-acceptance-handle.test.ts`); the preflight and verify mismatch, the blocked old
  input and the prompts (`tests/ladder-args-file.test.ts`); the carried scripts and instruction files
  identical to their templates (`tests/attach-carriers.test.ts`).
- L0: that the session passes the handle as the build printed it.
