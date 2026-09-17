# 0013 — A second init adds to the record and crosses out nothing

Status: accepted · 2026-09-17

## Context

`construct.json`'s `files` branch is the protocol of what the construct has ever written into this
repository, not a snapshot of the last run. [0006](0006-the-init-manifest-is-frozen.md) froze that
branch against retroactive rewriting, and left one sentence saying a later `init` "writes its own
manifest for its own run". Read literally, that is what the code did: a second `init` replaced
`files` with only the paths that run wrote, and every path the first run wrote and this one skipped
as "exists, review manually" silently left the record.

Measured on a scratch tree: a manifest carrying 43 paths, re-inited, then read by `construct sync` —
4 `keep` and 39 `conflict`. Nothing in the tree had changed. The construct had simply stopped knowing
that it wrote its own baseline, and `sync` correctly refused to touch files it could no longer prove
it owned.

## Decision

**A second `init` merges into the record it finds.** `buildManifest` takes `previous: Manifest | null`
as a required input — required, not defaulted, so the decision is visible at the call site — and when
it is not null:

- `files` and `variants` carry every entry the previous manifest recorded, then the entries this run
  wrote. A path this run wrote carries its new sha; a path it skipped keeps the sha recorded before,
  byte for byte.
- `construct` and `createdAt` come from the previous manifest. The version that materialized the
  repository does not move (0006); the version of a later run belongs to the `sync` branch.
- `discovery` and `sync` are carried over unchanged. A second `init` fills no marker and writes no
  sync record, so it must erase neither.
- `manifestVersion`, `preset`, `ai`, `review`, `harness`, `contracts` and `vars` come from this run,
  because a second `init` is how someone adds a Cursor target or turns review on.

**The carry-over is audible.** `runInit` reads the manifest already in the repository before writing
and, when there was one, prints a single line naming how many records it carried over and how many it
added. The user already sees "exists, review manually" per skipped path; without that line there is
no way to see that the record of ownership depended on those skips.

## Consequences

Re-running `init` is no longer a way to lose ownership. The classification map `sync` produces after
one `init` is the same map it produces after two, entry for entry, which is the property the tests
assert.

The freeze is unchanged in substance — no run rewrites what an earlier run recorded — and this record
states the consequence it always implied: an additive record cannot cross out another run's lines,
including its own from last time. The one sentence in 0006 that read otherwise is superseded here.

**Changing the preset on a second `init` leaves paths in `files` that the new preset does not
produce, and that is the right answer rather than a defect.** `init --preset node-backend` followed
by `init --preset monorepo` keeps every path the backend run wrote; `sync` reads them as `orphaned`,
which 0010 defines as *the record carries it and today's templates no longer produce it*. The
construct did write those files, it no longer produces them, and they have passed to the owner. The
temptation, on seeing a dozen `orphaned` lines after a preset change, will be to "clean up" the
record by crossing them out — that is exactly the defect this record closes, reintroduced under a
tidier name. An `orphaned` path is a fact about history, and history is what the record is for.

**`vars` comes from this run, which is the one place the merge still replaces a decision, so it is
said out loud.** Re-running with a different `--name` changes `projectName` while the recorded hashes
were taken with the old value. Nothing breaks, because `sync` compares against the record and not
against a re-render, but a decision replaced in silence would contradict the paragraph above it. The
second line of the report names every variable whose value changed, with both values, and says that
the recorded hashes were taken with the old one. `constructVersion` is excluded by name in the code,
because it restates which binary ran rather than anything anyone decided, and the run already prints
it.

## Enforced by

`tests/init-record.test.ts` (L3): two `runInit` runs over the same directory, asserting that every
path the first run recorded is still present, that a path the second run wrote carries the sha of the
bytes now on disk, that a path it skipped carries the exact sha string the first run recorded, that
`variants` merges the same way and that `construct`, `createdAt`, `discovery` and `sync` are the first
run's values unchanged; the classification map `src/sync/replay.ts` produces captured after one run
and after two and compared entry for entry; and the carry-over line asserted present with both counts
after a second run and absent after the first, with a fourth case asserting that a run under a
different `--name` names `projectName` with both values and that a run changing nothing says nothing.
