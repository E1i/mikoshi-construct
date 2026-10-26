---
'mikoshi-construct': minor
---

factory: the prompt a shift session and the answerer receive for a repository now names only what the package ships or what that repository's `construct.json` declares, instead of mikoshi-construct's own `scripts/ci/prepush.ts`, `scripts/window/handoff-check.ts`, `architecture/code-matrix.md` and `pnpm handoff:write`. An optional `shift` record in `construct.json` declares the repository's pre-push commands (`prepush`), its handoff writer (`handoffWrite`) and its code matrix (`codeMatrix`); without it the pre-push check is the `harness.command` that `init` writes for every preset, and the handoff and code-matrix lines are left out. The handoff fields are listed in the prompt itself. tree-pr refuses a pull request for a missing code matrix count line only in a repository that declares a code matrix. Every manifest written so far reads unchanged, so `manifestVersion` stays where it is.
