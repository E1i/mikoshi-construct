# 0010 — Sync classifies what the construct owns, and favours keep

Status: accepted · 2026-09-17

## Context

`init` against a repository that already has files skips every file that exists. `strategyFor` in
`src/materialize/strategies.ts` is the whole rule: `package.json` merges, `.gitignore`, `CLAUDE.md`
and `AGENTS.md` replace only their construct block, and everything else is created when absent and
skipped when present. A repository materialized by an older version therefore never receives a
changed template — a template fix ships to new repositories only.

[0006](0006-the-init-manifest-is-frozen.md) named the operation that closes this gap,
`construct sync`, and left it its own record. This is that record. It defines the contract — what
the construct owns inside a file, how a path is classified, where sync records what it did — before
the engine, the command and the writer exist, because each of them inherits these definitions and an
ambiguity left here would be decided by whoever implements them rather than by the owner.

The pressure is toward comparing whole files. For two of the three strategies the output depends on
the file's current content: an append-block target keeps the owner's prose around the block, and a
merged `package.json` is the owner's manifest with the construct's keys in it. A whole-file
comparison would put every live repository permanently in conflict.

## Decision

**Classification compares only what the construct owns, selected by the target's strategy.**
`create` owns the whole file. `append-block` owns the content between the construct block markers,
with the bodies of the discovery markers excluded. `merge-json` owns each key today's template
produces, and nothing else the file carries.

The discovery bodies are excluded because the template produces a placeholder and not a body: a body
is not something the construct owns. This has nothing to do with who authored it, and is not
implemented by consulting provenance — the exclusion reads the marker delimiters the template put in
the document. An implementation that excluded a body only when the owner had authored it would send
every untouched placeholder to conflict on the first sync.

`merge-json` is compared per key because a three-way comparison is not reconstructible: the manifest
records a sha of the already-merged result and never records which keys came from the construct, so
no manifest written before sync existed can say what the construct's contribution was. A key the
file lacks is `add`, a key whose value equals the template's is `keep`, and a key whose value differs
is `conflict`, because the record cannot tell an owner's edit from a template change. This is a limit
to state, not to work around; `merge-json` is reported in this version and never written.

**Seven classes, exhaustive and mutually exclusive** over the cross product of recorded, present and
produced: `add` (not recorded, not present, produced), `keep` / `update` / `conflict` (recorded,
present and produced, resolved below), `conflict` when a produced path is occupied by a file no
manifest recorded — an owner's file sits where the construct would write, `removed` when a recorded
path is missing from the tree, because the owner deleted it deliberately, `orphaned` when the
construct wrote a path it no longer produces, so the path passes to the owner, and `foreign` when a
present path was never ours. A path that is neither recorded, present nor produced is not a path
sync considers.

**The ordered comparison inside the recorded-present-produced cell runs in three steps, and the
order is the contract, not an implementation detail.** First, the current owned view equals what the
templates produce — `keep`, whatever hand made it so. Otherwise the current owned view equals what
was recorded — `update`. Otherwise — `conflict`. Step one before step two is the whole point: an
owner who applied by hand exactly what the template now brings must read as `keep`, never
`conflict`, because there is nothing left to resolve. A binary split on whether the current view
still matches the record gets this case wrong while looking correct.

**Sync never deletes a file, never recreates one classified `removed`, and never adopts a file it
did not write.** Deletion is the owner's; a path the owner removed stays removed however loudly the
templates produce it; a `foreign` file is reported and left alone.

**`construct.json` gains a `sync` branch**: when it ran, the version that had materialized the
repository, the version that ran, and the shas sync wrote. It is additive — 0006 froze the branch
`init` wrote and that branch stays untouched — so `manifestVersion` rises to 3 and `upgradeManifest`
normalises both earlier shapes. The recorded sha for a path is read from the `sync` branch when
present and from the `init` branch otherwise, so a second sync classifies against what the first one
actually wrote.

## Consequences

The two branches record different things, and the reader accepts both. `init` recorded the sha of
the whole file it wrote; sync records the sha of the owned view. A file matches its record when
either hashes to it — otherwise the first sync of an append-block target whose record came from
`init` would read `conflict` for every repository whose owner has written a line of their own around
the block.

Editing `construct.json` by hand erases evidence of intent irrecoverably, and the owner of this
repository met this in practice. A file deleted from the tree and also struck from the manifest by
hand reads afterwards as one the construct never wrote, so sync will offer it as `add` — formally
correct and against the owner's intent, which no longer exists anywhere. The system recovers in one
cycle, because applying it records it and deleting it again yields `removed` thereafter, but the
rule holds: a record edited by hand is evidence destroyed. The manifest is written by the commands
that own their branch, never by an editor.

Reporting `merge-json` and writing nothing for it means a template's new script or dependency
reaches an existing repository only when its owner copies the key across. That is the honest reading
of what the record can prove, and the cost of the freeze that keeps the rest of the manifest
trustworthy.

## Enforced by

`tests/sync-classification.test.ts` (L3): a table-driven row per cell of the cross product, the
three-step order, and the named case that separates step one from step two — an owner who applied by
hand exactly what the template now brings reads `keep`. `tests/sync-ownership.test.ts` (L3): the
owned view per strategy, both an untouched placeholder and a filled discovery body reading `keep`,
and the exclusion never consulting authorship. `tests/manifest.test.ts` (L3): the additive `sync`
branch, the raised `manifestVersion`, and the recorded sha read from `sync` when present and from
`init` otherwise. `isWritable` in `src/sync/classify.ts` (L3) makes the `merge-json` ban structural rather than
written down: writability is derived from the strategy as well as the class, so a `package.json`
whose owned keys make the path `update` is still not writable, and a writer that consults only the
class cannot get it wrong. That sync never deletes, never recreates a `removed` path and never
adopts a `foreign` one is L1 review until the writer exists, which is the change that will enforce it.
