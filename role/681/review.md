[review:681] PR #625, head 8ada5c9e1d305387fabf134372ef07260164c9b6 (verified = origin/feat/roles-in-cloud).

Verdict: pass-with-notes (approve-with-notes).

Checked
- owner-merges.md diff (word-diff): two additions only (`scripts/ghosts/cloud-key.ts` in the ghosts cell, a `role.ts` row in the plain list); nothing removed or reworded.
- No comments in the added code; no test beside source (tests under scripts/tests/**, tests/harness-membership.test.ts).
- Registries: cloud-key.ts and role.ts in owner-merges.md; ghosts:role row in CONTRIBUTING.md and OUTSIDE_THE_HARNESS; the window.md cloud prompt names all three registries.
- Earlier fixes hold: empty ref and "-" refs refused; case-only clash (basename compare, lower-cased) refused; symlink/non-file target refused via lstat; `..` in report path refused; cloudOn is `=== '1'`.

Tests run
- `NO_COLOR=1 pnpm exec vitest run scripts/tests/ghosts/role.test.ts scripts/tests/ghosts/verdict.test.ts scripts/tests/shift/shift-entry.test.ts` -> exit 0, 3 files, 39 tests passed
- `pnpm typecheck` -> exit 0
- `pnpm lint` -> exit 0

Notes
1. scripts/ghosts/verdict.ts:176-184 - a report path with a subdirectory is written flat - verdict `{"report":{"path":"sub/rep.md",...}}` in role/9/v.verdict.json: fetchVerdictFromRef returns ok:true and writes `<dir>/rep.md`, but recordVerdict then looks for `<dir>/sub/rep.md`; it fails closed with a missing-report message, but the stray files remain and the fetch reported ok. Reproduced with a scratch repo. Fix: refuse a report path containing a separator, or write it at the same relative path.
2. scripts/shift/shift.ts:630 - the cloud refusal precedes `--check` and `--queue` - `CONSTRUCT_CLOUD=1 pnpm shift --check <dir>` exits 1 although --check spawns nothing and writes nothing. Minor; move the refusal after the check branch.
3. scripts/ghosts/verdict.ts:166 - a verdict whose `report.path` is not a string (e.g. `{"report":{}}`) is reported as "cannot read ..." from a TypeError message; misleading, not unsafe.
4. scripts/ghosts/verdict.ts:183 - the two writes are not atomic; if the report write fails after the verdict write, the verdict stays in the handoff dir. Low.
5. scripts/ghosts/role.ts:25 - `--task ../x` is echoed into a branch name unvalidated; output only, no effect.
