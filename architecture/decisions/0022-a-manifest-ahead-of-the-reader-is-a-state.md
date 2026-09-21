# 0022 — A manifest from a later build is a state this binary reports, not one it normalises

Status: accepted · 2026-09-21

## Context

[0009](0009-the-manifest-carries-its-own-schema-version.md) put an integer `manifestVersion` at the
top of `construct.json` so that a reader could decide what to do from the file alone, and settled the
backward direction: a manifest written by an older CLI is normalised on read, and its markers report
as `unknown` because it carries no provenance. It closed with "a future shape change gets a decidable
branch: read `manifestVersion`, or its absence, and normalise."

It said nothing about the other direction, and `upgradeManifest` behaved accordingly: it read any
`manifestVersion` whatever its value, normalised what it recognised, and wrote `MANIFEST_VERSION` into
the result. A manifest from a later build was therefore treated as a manifest from an earlier one —
its unfamiliar branches silently discarded rather than reported.

The symptom that surfaced this came from the far side of the same gap. A globally installed 0.1.1
reading a v4 manifest threw on `discovery[marker]`, because in its shape `discovery` was a flat map
and in v4 it is a record. Anyone with a stale global install met a stack trace where the tool already
had a vocabulary for saying what was wrong.

## Decision

**A `construct.json` whose `manifestVersion` exceeds what this binary understands is reported as a
state. It is not normalised, not partially read, and not rewritten.**

`upgradeManifest` throws a named `ManifestAheadOfReader` carrying both numbers — the version found and
the version understood — and the composition root turns it into one line naming both and saying that
a newer CLI is needed. Nothing is read and nothing is written.

The error carries the numbers rather than a formatted sentence, because `src/manifest.ts` does not
own user-facing text: every such string lives in `src/ui/lore.ts` with its plain counterpart, and the
reading is composed where the rest of the output is. The composing module sits at `src/failure.ts`
and not under `src/ui/`, because it has to know both the error and the vocabulary, and the dependency
policy in `eslint.config.mjs` forbids `src/ui` from importing the manifest — correctly, since the
vocabulary must not depend on the domain that raises the error.

**This cannot help anyone already running an older binary.** 0.1.1 is published and will keep
throwing on a v4 manifest; no change here reaches it. The decision is prospective: it makes the
*next* shape change a reportable state rather than a second stack trace, and that is the whole of what
it buys. Saying so plainly is the point — a fix that reads as though it repaired the observed crash
would be a claim about released artifacts that is not true of them.

## Boundary — which commands can reach this state

Only the commands that read the manifest. `doctor`, `sync` and `init` read it directly; `cost` reads
it only when neither the Claude Code nor the Cursor environment variables name the runtime, because
`resolveRuntime` answers from the environment first and never reaches the file otherwise.

`graph` does not read the manifest at all — the picture is drawn from `construct.model.json` — so it
cannot reach this state. It is wrapped in the same reporting path for failures of any other kind,
where it previously had none, and that is a separate small improvement rather than part of this one.

## Consequences

`readManifest` can now throw where before it returned a value or `null`. Every caller sits under a
composition root that reports rather than propagates, so no command exits on an unhandled error, and
the reporting lives in one place (`src/failure.ts`) rather than being repeated per command.

A manifest at or below `MANIFEST_VERSION` is unaffected, including the frozen 0.1.x fixture, whose
markers still read as `unknown` exactly as 0009 requires.

The check is on the declared integer alone. A file that declares a version this binary understands
but carries a shape it does not is not covered here and never was — that remains what
`upgradeManifest`'s field-by-field normalisation is for.

## Enforced by

`tests/manifest-ahead.test.ts` (L3): a manifest declaring `MANIFEST_VERSION + 1` makes
`upgradeManifest` throw with both numbers on the error and leaves the input untouched; `readManifest`,
`runDoctor`, `runSync` and `costReport` each propagate it to the composition root; the reported line
names both versions and carries no stack trace and no class name; any other failure is still reported
as its own message; the frozen 0.1.x fixture still normalises with its markers `unknown`.
