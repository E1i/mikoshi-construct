# 0032 — A record carries the block it wrote and the values it wrote with, so drift of the record is told from drift of the block

Status: accepted · 2026-09-24

## Context

`construct.json` records, per file the construct wrote, the sha256 of what was written and the template
variant. `sync` reconstructs the variant by rendering today's templates and comparing; a file written
by an older version cannot match that render, so its variant is null and the file reads `unknown`.

The observation *In the "d4" case the record drifted, not the block*
([observations.md](../observations.md)) measured a case this leaves invisible. `AGENTS.md` carried
"working on d4" inside the construct's own block while `construct.json` recorded
`projectName: mikoshi-construct`. The recorded sha was exactly the 0.1.0 render with `projectName: d4`,
so the record faithfully witnessed the write; a later commit edited `vars.projectName` in the record by
hand and did not re-render. The block never drifted from what was written. The **record** drifted from
the block, because the values the hashes were taken with changed after the write. `sync` reported
`unknown` and named nothing.

Three different events look identical from a single recorded sha against today's render: the owner
edited the block, the owner edited the record's `vars`, or the template moved on between versions. A
mechanism that cannot tell them apart cannot say which, so it says `unknown`.

## Decision

The record carries two more facts per relevant file, so each of the three events has its own witness.

1. **The sha256 of the block's owned view as written** — the construct's block with discovery bodies
   excluded, the same view `sync` already compares. Drift inside the block is then the current
   owned-view sha differing from this recorded one, decided without rendering any template and so
   without depending on which version wrote it.
2. **A snapshot of the `vars` the recorded hashes were taken with.** A record whose current editable
   `vars` differ from this snapshot is a record edited after its write.

With these, `sync` distinguishes, asking in this order:

- **the block was edited** — the owned-view sha differs from the recorded owned-view sha, whatever the
  `vars` say;
- **the record's `vars` were edited** — the block still matches its recorded owned-view sha, and the
  current `vars` differ from the recorded snapshot;
- **the template moved on** — the block matches its recorded sha, the `vars` match the snapshot, and
  today's render from them differs from the block.

These are new recorded fields, so the manifest's schema version becomes **6**, and
`formats.manifestVersion` in the [0030](0030-public-contract.md) public contract changes with it. That
is an additive contract change and ships as a `minor`.

A record cut before version 6 carries neither field. It cannot be repaired by writing the fields now —
that would assert values were measured at a write that did not measure them, the mistake the *d4*
observation is about. Such a record keeps the reading it had before version 6: an append-block target
whose variant is recorded, or established without it, reads `keep` or `update` as it did; a target
whose variant nothing settles reads `unknown`, and `sync` adds that the record predates the fields that
would answer, rather than guessing. Only running the construct again cuts a version 6 record.

## Consequences

- `sync` gains three named states for the construct's own block of a version 6 record. A pre-6 record
  reads as before; where it reads `unknown`, that now carries "this record predates the fields that
  would answer".
- The owned-view sha is derived from the block the run wrote, and the `vars` snapshot from the `vars`
  the run rendered with. Both are measurements of the write, recorded at the write, never back-filled.
- Editing the record's `vars` by hand stops being invisible: it becomes the named state *the record's
  vars were edited*, which is what should have been reported for *d4*.
- The manifest reader already refuses a record whose `manifestVersion` is ahead of it
  ([0022](0022-a-manifest-ahead-of-the-reader-is-a-state.md)); version 6 is read by a binary that
  knows it and reported as a version gap by one that does not.

## Enforced by

L3 tests: a fixture whose block is hand-edited reads *block edited*; a fixture whose recorded `vars`
are hand-edited reads *record vars edited*; a block edited by hand under hand-edited `vars` reads
*block edited*; a pre-6 record whose variant nothing settles reads `unknown` and says it predates the
fields. The contract change is enforced by `contract:bump` over `formats.manifestVersion`.
