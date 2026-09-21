# 0028 — A model from a later build is a state this binary names

Status: accepted · 2026-09-22

## Context

`construct.model.json` declares a `modelVersion`. Until now a model declaring a version this binary
does not understand produced a generic schema failure: `parseModel` rejected any value other than
`MODEL_VERSION` through the same path as a missing field or a malformed array, and `readModel`
recognised only `DanglingFactReference` and rethrew everything else unchanged. There is no
`upgradeModel`.

This is the argument of [0022](0022-a-manifest-ahead-of-the-reader-is-a-state.md) applied to the
model rather than the manifest, and it is not restated here.

**Only half of 0022 ports, and the missing half needs no equivalent.** That record also stopped
`upgradeManifest` rewriting a higher version down to one it understood. The model has no such path to
close: `writeModel` parses the source it is about to write and fails before the write, so a model of
any other version cannot be written at all. This is said here so that nobody adds a guard for a path
that does not exist and then maintains it.

## The carrier that already exists, and the one thing about it that did not fit

The state was built once, for the manifest, and the path is three places:

| | |
|---|---|
| raised | `upgradeManifest`, the single `throw` on a declared version above the one understood |
| crosses the root | `readManifest` is called by `doctor`, `sync`, `init` and `cost`; none of them catches it, so it reaches `cli.ts`, which wraps every command in `reported` |
| reported | `flatlineFor` matches the class and renders it from the vocabulary |

Every part of that fits the model unchanged: `readModel` is called by `doctor`, `graph`, `sync` and
`init`, none of them catches, and they all reach the same root. **What did not fit was one thing, and
it was not structural: the error class and its line named `construct.json` and `manifestVersion` in
their own text.** Thrown from the model reader it would have reported a true state against the wrong
record.

So the carrier was generalised rather than duplicated. It takes the record and the field as values,
and both readers raise it. Nothing was added beside it, and the alternative — a second class, a
second branch and a second line saying the same thing about a different file — would have been two
mechanisms of one shape, which is the thing this record exists to avoid.

## Decision

**A version above what this binary understands is raised as `RecordAheadOfReader`, carrying the
record, the field and both versions, and reported at the composition root.** The manifest and the
model raise the same error from their own readers. Its rendered text for a manifest is unchanged, and
the type alone no longer says which record is ahead — the record is a value on the error, and the
tests assert it.

That distinction by type was given up once, and what is bought for it repeats: any record this tool
later grows that carries a version of its own gets the named state with no new class, no branch in
`flatlineFor` and no line in the vocabulary.

**The check runs before the closed-property check, not after.** A model from a later build will
usually carry fields this binary has never seen, and the generic complaint about an unknown property
would otherwise be raised first — reporting the symptom of a newer format as a malformed document.
The more specific cause is named first.

**A version *below* `MODEL_VERSION` keeps today's generic failure.** Nothing here migrates an older
model; see the scope note below.

## The trap this closes, which is the reason it is worth doing

`readModel` returns `null` when the file is absent, and `null` already carries a specific reading:
the placement `no-model`, and a line saying that `construct init` writes one. If a model from a later
build collapsed into that reading, `doctor` would tell someone holding a **newer** model to run
`init` — proposing to overwrite the file it had just failed to read.

That is `unknown` reported as absence — [rule 2](../epistemic-rules.md) — on a state that does not
exist in the wild yet, which is the cheapest moment to close it. The acceptance therefore asserts not
only that the state is named but that the `no-model` reading is **not** selected and `init` is not
offered as the way out.

## Out of scope, stated rather than left open

**No migration of older models.** A model declaring a version below this one still fails as it did.
Migration is a separate decision and is only needed when `MODEL_VERSION` actually moves.

**No new fact kind, and no `MODEL_VERSION` bump.** This record changes how an unreadable version is
reported; it does not change what a model may contain. The version is still 1.

## Enforced by

`tests/model-ahead.test.ts` (L3), against a fixture declaring `modelVersion` 2 and carrying a
property this binary does not know, on the two axes the state has to be distinguishable on:

- **distinguishable from a corrupt or invalid model** — the version-ahead fixture raises
  `RecordAheadOfReader` and an invalid one does not, so a parse failure and an unknown version do not
  share a basket; the error carries `found` and `understood` as values rather than as a message
  somebody would have to parse, and it carries `record` and `field`, which is what keeps the shared
  carrier from making a model-ahead state indistinguishable from a manifest-ahead one
- **distinguishable from no model at all** — `runDoctor` propagates the state, and the rendered line
  contains neither the `no-model` enforcement reading nor the line offering `init`

The first axis was red before the change: the version mismatch was reported as a generic schema
failure and the class did not exist. **The second was not red before the change, and saying so
matters more than the tidy version.** Today `readModel` throws on a version mismatch, so nothing
collapses into `no-model` and the assertion passed for that reason rather than by holding anything.
It is red under the implementation it exists to forbid — catching the new error in `readModel` and
returning `null` — which was run, and takes all four cases with it. The test guards a wrong fix, not
a past defect, and that is what it is for.
