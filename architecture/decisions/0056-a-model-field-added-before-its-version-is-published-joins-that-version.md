# 0056 — A model field added before its version is published joins that version

Status: accepted · 2026-10-08 · owner decision D-45 (#702)

## Context

`construct.model.json` carries `modelVersion`, and `MODEL_VERSION` in `src/model/schema.ts` is what
lets an older build refuse a record a later build wrote. #702 added `relations` and a `reason` to the
model while version 5 had entered `main` with #534 but had not been published: release 0.42 shipped
version 4. Bumping to 6 would have turned tests red for nothing but the number, and given two
versions to a shape no released build had ever written. The owner decided it as D-45 in the owner's
decision file; the decision lived only there, and this record states it in the repository.

## Decision

1. **A field added to `construct.model.json` before the version that carries it is published goes
   into that version, with no bump of `MODEL_VERSION`.** "Published" means a release on the registry
   whose build writes that version; a version that is only on `main` is still open.
2. **Once a version is published, any change to the shape takes the next version.** A published build
   already reads the open version as ahead of it and refuses it, so filling an unpublished version
   breaks no reader that exists; changing a published one would.
3. Applied first by #702: `MODEL_VERSION` stayed 5 and `relations` and `reason` joined version 5.

## Consequences

One released build never sees two shapes under one version number, and the version history counts
releases of the shape, not commits to it. Whoever changes the shape has to know whether the current
`MODEL_VERSION` has been published, which no code tells them.

Reversed if a build that is not a release — a pre-release, a build from `main` that a user installs —
starts writing records others read; then an unpublished version is no longer private and every shape
change bumps.

## Enforced by

Review (L1). No check compares `MODEL_VERSION` with the version the last published release writes.
