# 0012 — Sync writes exactly what it compared, and only where ownership is provable

Status: accepted · 2026-09-17

## Context

[0010](0010-sync-classifies-what-the-construct-owns.md) defined what the construct owns inside a file
and how a path is classified. It left the writer to a later change and named the rules the writer
would have to obey — never delete, never recreate a `removed` path, never adopt a `foreign` one,
never write a `merge-json` target — as review-level claims, because there was nothing to enforce them
against. This is the change that makes them structural.

The first real `--apply` runs on this repository, where `AGENTS.md` and `CLAUDE.md` classify as
`update` and carry discovery written into their markers. What stands between that work and a rewrite
is the carry-over of the marker bodies and the fact that only the construct block is touched, so the
question is not whether the file was written but whether every byte the construct does not own came
through unchanged.

The obvious implementation — hand the produced content to `appendBlock`, the function `init` already
uses — was measured on this repository and is wrong. `appendBlock` demotes the produced `H1` to `H2`
when the existing file already has one, and appends the whole block when the file has none. Both are
`init`'s first-contact behaviour, correct there and wrong here: after the demotion the owned view of
what was written no longer equals the owned view of what was compared, so the very next sync reads
`update` again, forever, and an idempotent writer becomes an oscillating one.

## Decision

**Sync writes exactly what it compared.** For every written path, the owned view of what lands in the
tree equals the owned view of the produced content that made the classification. For a `create`
target that is the whole file, written as produced. For an `append-block` target it is the text
between the markers, so the write is a substitution: the produced text between the markers replaces
the text between the markers the present file already carries, every byte outside them survives, and
a filled `construct:discover` body is carried over by the same `preserveDiscovery` `init` uses. An
`append-block` target that is absent is written whole. There is no fallback branch that writes the
produced file over a file with content outside the block, and the write never routes through
`appendBlock`.

**The writer decides with `isWritable`, never with the class alone.** `isWritable` derives writability
from the strategy as well as the class, so `add` and `update` are written for `create` and
`append-block` and a `merge-json` target is refused whatever its class — including a `package.json`
whose owned keys read as `update`. A writer that consulted `classification.class` could get this
wrong; one that cannot see the class without the strategy cannot.

**Nothing else is written, and no flag says otherwise.** `keep`, `conflict`, `removed`, `orphaned`
and `foreign` are never written, no file is deleted, no `removed` path is recreated and no file the
construct never wrote is adopted. `--apply` is the only flag added, and it only chooses between
reporting and writing; there is no `--force`, no override and none is to be added.

**Only the `sync` branch of `construct.json` is written, and it accumulates.** Each written path is
recorded with the sha of its owned view, beside when the run happened, the version that materialized
the repository and the version that wrote. A later run keeps what an earlier one recorded. The branch
`init` wrote stays frozen, as [0006](0006-the-init-manifest-is-frozen.md) requires. The manifest is
written once, after the files, so a failed write leaves no record claiming a file exists; when
nothing was written, `construct.json` is not touched at all.

**`src/sync` stays pure.** `planWrites` computes the content and the sha to record; the composition
root writes through the existing `applyPlan`, which creates and overwrites and has no delete. There is
no second file-writing primitive, and the ban on deletion is a property of the only writer there is.

## Consequences

**Idempotence is the proof the writer is honest**, and it is the property to test first: an `--apply`
followed by a plain `sync` reports nothing in `add` or `update`, because the second run compares
against what the first one recorded. This is also what makes the demotion above a correctness bug
rather than a cosmetic one.

**A known gap is deferred, not fixed here.** The replay renders the created-file variant of a block
target — `AGENTS.md.eta`, `CLAUDE.md.eta` — even where `init` wrote the guest variant
`.existing.eta`. Applying on this repository therefore replaces `CLAUDE.md`'s thin construct pointer
with the full new-repository block. It cannot be fixed in the writer, because the comparison and the
write must use the same produced content; fixing it means changing what is compared, which is a
change of its own with its own record. Until then, a repository that received the guest variant gets
the full block on its first `--apply`, inside the delimiters and nowhere else. The gap cost one
template change on the way in: the created-file `CLAUDE.md` carried an `H1`, which inside an existing
document duplicated that document's own title and failed markdown lint. The heading was dropped from
the template rather than edited out of the written file — `@AGENTS.md` imports the document that
carries the project's title, so the created file loses nothing — and the writer was run again.

**`doctor` still lists a file sync rewrote as modified.** The baseline is what `init` recorded and
0006 froze it; a rewritten block no longer hashes to it. Correcting the baseline would erase the
evidence of what `init` did, so sync records what it wrote in its own branch and the two readings
coexist.

**The self-hosting drift list is a ratchet, and this change turns it.** Once the writer runs here,
`tsconfig.base.json` stops differing from the replay and its entry must go — a declared difference
that no longer differs fails the reproducibility test exactly as an undeclared one does.

## Enforced by

`tests/sync-apply.test.ts` (L3): every discovery marker body compared byte for byte across an apply
by iterating `DISCOVERY_MARKERS`; the bytes outside the construct block compared for both block
targets; a table over the seven classes crossed with the three strategies pinning that the planned
writes are exactly what `isWritable` allows; a `package.json` whose owned keys make it `update` left
unchanged, unwritten and unrecorded; every `keep`, `conflict`, `removed` and `orphaned` path compared
path by path before and after; the tree afterwards proven to be the tree before plus exactly the
`add` paths written; the `sync` branch recorded and every other manifest field asserted field by
field; and an apply followed by a sync reporting `add` 0 and `update` 0, with a second apply writing
no file and leaving `construct.json` byte-identical. `tests/strategies.test.ts` (L3): the
substitution keeps every byte outside the markers and, unlike `appendBlock`, leaves a block that
reads back as the produced one. `tests/manifest.test.ts` (L3): the `sync` branch accumulates and
touches no other field. `tests/reproducibility.test.ts` (L3): the drift list fails in both directions,
so an entry that stopped differing after the apply cannot be left behind.
