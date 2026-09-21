---
"mikoshi-construct": patch
---

Decision 0026: which packages exist is derived, what each package may import is recorded

A second `init` on the monorepo preset re-derived `allowedWorkspaceImports` from the packages the
first run created, recording `'packages/shared': ['@x/api']` where the first run recorded `[]`.
`eslint.config.mjs` is skipped on a re-run, so the file kept the strict policy and the record no
longer matched it; `sync` reads that path as `update`, and `sync --apply` closes the gap by writing
the looser policy into the file. Confirmed by running it.

The variable answers two questions at once. Which packages exist is a fact about the tree. What each
may import is a decision, and after the first run it is the owner's — re-deriving it is the construct
overwriting what it does not own, which is the shape 0013 and 0006 already settled for the record.

The record decides: the key set is derived every run, so a package the owner added is picked up; the
allowances of a key already recorded are never re-derived; a new key gets the default the preset
applies to a package of its kind, measured as `apps/*` may import every other workspace package and
anything else may import nothing. Widening and narrowing stop being separate cases because a recorded
value is not touched.

The decision is recorded; its implementation and test are not, and the record says so and carries L0
rather than a level it does not have.
