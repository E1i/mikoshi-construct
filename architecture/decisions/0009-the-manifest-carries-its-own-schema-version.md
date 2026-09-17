# 0009 — The manifest carries its own schema version, and a manifest without provenance is unknown

Status: accepted · 2026-09-17

## Context

[0002](0002-provenance-in-the-manifest.md) put discovery provenance in `construct.json` rather than
in the prose of the markers. Landing it changes the shape of the file: `discovery` stops being a flat
map from marker name to file and becomes a record with `baseSha`, `filledAt` and a `markers` map, each
entry naming the marker's file, who authored it and the sha256 of the body discovery wrote.

Every manifest written by 0.1.x has the old shape, and `readManifest` was a bare `JSON.parse` cast.
Without a normalising read, `path.join(root, manifest.discovery[marker])` receives an object and
`doctor` throws on every repository initialised before this change — including this one.

Two questions had to be settled before that read could be written. Which version does the reader
branch on, and what does it conclude about markers that carry no provenance at all.

## Decision

**The manifest declares an integer `manifestVersion` at the top level, distinct from `construct`.**
`construct` is the CLI version that ran — a product version, bumped for reasons that have nothing to
do with this file's shape, and sometimes not bumped when the shape does change. Branching a migration
on it means asking "which releases of the CLI wrote which shape", a question whose answer lives in a
changelog and degrades over time. `manifestVersion` is the shape's own number: it changes when, and
only when, the shape changes, and a reader can decide what to do from the file alone. Conflating the
two is what makes a later migration undecidable.

**A pure `upgradeManifest` normalises on read, and nothing writes the result back.** `readManifest`
returns the normalised value; `doctor` writes nothing, and this change ships no migration command. A
repository's manifest stays the record of the run that wrote it, which is [0006](0006-the-init-manifest-is-frozen.md)'s
freeze — 0006 froze the `init` branch and left the `discovery` branch to the discovery command, and
this is that branch.

**A marker upgraded from a legacy manifest is `unknown`, never `construct`.** The legacy shape
records no author and no sha, so there is no evidence either way. Reading it as `construct` would
tell the owner of a repository where discovery genuinely ran, and who has since rewritten every
marker in their own words, that the tool is still talking to itself — the feature producing exactly
the lie it exists to prevent. Where an owner has recorded that a variance is accepted, that record is
what makes intent known; absent such a record, intent is unknown rather than assumed.

Authorship is derived on read, never stored: a marker whose current body still hashes to the recorded
sha reads as `construct`, one that no longer does reads as `owner`, and anything with no recorded
provenance reads as `unknown`. The hand edit is the only evidence needed, so there is nothing to run
and nothing to write back.

## Consequences

`doctor` keeps working on every repository built by 0.1.x, and reports their markers honestly as
unknown rather than accusing them. A future shape change gets a decidable branch: read
`manifestVersion`, or its absence, and normalise.

The cost is that a repository initialised before this change never gains provenance until discovery
runs again there. That is the intended reading — the tool cannot prove what it wrote before it kept a
record — and not a reason to backfill one.

Provenance is reported, not enforced. It is not a sixth `doctor` check, it has no level, and it
changes no exit code.

## Enforced by

`tests/manifest.test.ts` (L3): a frozen 0.1.x `construct.json` under `tests/fixtures/manifest/` is the
regression that `upgradeManifest` keeps reading it, that `doctor` runs against it, and that its
markers come back `unknown`. `tests/doctor-provenance.test.ts` (L3) covers the derivation.
