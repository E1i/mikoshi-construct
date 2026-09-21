---
"mikoshi-construct": minor
---

The workspace policy is recorded, not derived again on every run

Decision 0026, implemented. `allowedWorkspaceImports` answered two questions at once: which packages
exist, which is a fact about the tree, and what each may import, which is a decision. A second `init`
re-derived both, so a leaf recorded as importing nothing came back allowed to import the app, and
`sync --apply` then wrote that looser policy into `eslint.config.mjs` — a dependency policy loosening
on a repository nobody edited.

Which packages exist is still derived on every run, so a package added since the last one becomes a
new key. What each may import is now kept once recorded. A new key is given the preset's default for
a package of its kind: a package under `apps/` may import every other workspace package, anything
else may import nothing. The run names the keys it added, what each may import, and that
`eslint.config.mjs` is not rewritten there so a later `sync --apply` would write the new policy into
it — the consequence, not only the delta.

**Adopting a monorepo whose packages already import each other will now fail lint until you widen the
policy deliberately.** The default for a first `init` on a monorepo that already carries packages
used to be permissive — every package allowed to import every other — because the packages were
detected rather than created. It is now the same narrow default as everywhere else: `packages/*`
starts at importing nothing. Widening it is a one-line edit to `eslint.config.mjs`, and from then on
the record keeps what you chose. The old default blessed whatever the repository already did without
anyone deciding to, and under this release that unchosen policy would have been recorded and kept.

`construct.json` carries the policy as structure under `policy` and declares `manifestVersion` 5. The
rendered form is derived from the structure and is never read back to recover it, so a formatting
function is not the authority on what was decided. The rendered entries are sorted by package
directory, so the policy no longer depends on the order the packages were enumerated in.
