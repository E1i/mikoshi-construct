---
"mikoshi-construct": patch
---

Two source files imported across the dependency policy with no boundary to hold them to it

`AGENTS.md` says dependencies inside `src/` point one way and that `eslint.config.mjs` enforces it.
`ALLOWED_INTERNAL_IMPORTS` keyed a directory or file per module, and two files that import other
modules had no key at all, so nothing was enforced for them: `src/failure.ts`, which reaches the
vocabulary in `src/ui`, and `src/cli.ts`, which composes everything.

The acceptance is the general property rather than the two files: **every source file that names an
internal import is covered by a boundary.** It was run red first and named both — the second was not
known before it ran. A file that names no internal import is asked for nothing, so `src/record-ahead.ts`
and `src/version.ts` carry no entry and are not made to carry an empty one; that case ships as a test
beside the criterion.

The entries say what each file imports today, not what it might: `src/failure.ts` may reach `ui` and
nothing that holds a record, and `src/cli.ts` may reach the commands, the presets, the vocabulary, the
version and `detect`, but not the manifest, the model, the materializer or `sync` behind them. Both
cases are in `tests/dependency-policy.test.ts`.

No behaviour changes: nothing in `src/` moved, and the new rules are satisfied by the tree as it stands.
