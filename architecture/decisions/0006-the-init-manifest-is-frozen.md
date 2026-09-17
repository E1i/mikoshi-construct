# 0006 — What init wrote in construct.json is frozen

Status: accepted · 2026-09-17

## Context

`construct.json` records what `init` wrote: the version that ran, the preset and AI target, the
resolved template variables, and a sha256 per file it materialized. This repository's own manifest
was written by construct 0.1.0; the templates have moved on since.

The tempting move is to regenerate the manifest at release, or whenever a template changes, so that
today's output matches the recorded hashes. That turns the file into a mirror of the current
templates and destroys the only thing it is good for: saying what the repository was actually built
from. Comparing today's output with a rebaselined manifest compares a version with itself.

The self-hosting test exists because of this. It replays materialization with the variables the
manifest records and compares the result to the files at the repository root, declaring every
difference in `architecture/self-hosting-drift.yaml`. It never compares against the recorded
hashes — those describe construct 0.1.0's output, not today's templates.

## Decision

The `init` branch of the manifest — `construct`, `createdAt`, `preset`, `ai`, `review`, `harness`,
`contracts`, `vars` and `files` — is written once, by the `init` run that created it, and is never
rewritten retroactively. A later `init` against the same repository writes its own manifest for its
own run; no command edits the record of a run that already happened. `files` is a record of what
that run declared writing, not an assertion about the working tree today.

The freeze covers that branch only. The `discovery` branch belongs to the discovery command: it
names where each marker lives today, and [0002](0002-provenance-in-the-manifest.md) adds
`discovery.baseSha`, `discovery.filledAt` and the per-marker provenance that discovery writes when
it runs. A record saying "`construct.json` is never written again" would be false the moment
provenance lands.

Rebaselining an existing repository onto newer templates is a separate operation, `construct sync`,
which gets its own decision record when it exists.

## Consequences

The manifest's history is the history of that file in git: one entry per run, readable as a
timeline. Drift between the recorded run and the current templates is visible in
`self-hosting-drift.yaml` with a reason per file, instead of being erased by a regeneration.

The cost is that `doctor`'s baseline check compares against hashes that age. That is the intended
reading — "the baseline this repository was built from has been edited or has moved on" — and not a
reason to refresh the file.

## Enforced by

`tests/reproducibility.test.ts` (L3): the self-hosting replay uses `vars`, `preset` and `ai` from
the manifest and the declared drift list, and reads `files` only for its keys — which paths that run
declared writing — never for its hashes. The freeze itself is L1 review until `construct sync`
exists.
