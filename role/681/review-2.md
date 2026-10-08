[review:681]

# Re-review 2 of PR #625 at 9c02368193eea3b7d191672bd0effe6bdd560a51

Verdict: pass-with-notes. Head matches the requested sha.

## Previous notes
1. Subdirectory in report.path: fixed. reportPathFault (scripts/ghosts/verdict.ts) refuses any `/` or `\` before the second `git show`; `..` is named separately.
2. `CONSTRUCT_CLOUD=1 pnpm shift --check`: fixed. runShift refuses the cloud only when `!check`. Run by hand with a handoff dir, cloud=1 and cloud=0 print the same line and exit the same (1, "no NN.md task file"); the cloud refusal is not reached. Bare `--check` without a dir exits 1 with usage in both modes (not a regression).
3. Non-string report.path: fixed, refused by name ("report.path is not a string") before any read.
4, 5: accepted by the owner, not re-opened.

## Checks
- owner-merges.md: `git diff --word-diff` shows additions only (the history sentence, `cloud-key.ts` in the ghosts cell, `role.ts` in the plain list). Classification choices: cloud-key.ts -> ghosts (it decides local vs cloud routing); role.ts -> plain list (prints a route only). Both are Eli's to confirm.
- package.json `ghosts:role`: row in CONTRIBUTING.md § Scripts and entry in OUTSIDE_THE_HARNESS present.
- No comments added in source or tests; tests are under scripts/tests/.
- shift.ts adds no merge-naming text; no own-instructions registration needed.

## Tests (after pnpm install --frozen-lockfile, exit 0)
- NO_COLOR=1 pnpm exec vitest run scripts/tests/ghosts/role.test.ts scripts/tests/ghosts/verdict.test.ts scripts/tests/shift/shift-entry.test.ts -> exit 0, 3 files, 42 tests passed
- pnpm typecheck -> exit 0
- pnpm lint -> exit 0

## Notes
1. scripts/ghosts/verdict.ts:185-196 - `--from` writes the verdict file, then the report; a failure on the second write leaves the first behind, contradicting "nothing written". Failing input: verdict `{"report":{"path":"."}}` with `--dir /tmp/x/new` absent: report target resolves to the dir itself, the verdict is written into it, then writeFileSync throws EISDIR and the message is "cannot read ...". Harmless (a later recordVerdict rechecks sha256) and the same class as accepted note 4.
2. scripts/ghosts/verdict.ts:155 - report.path "" or "." passes reportPathFault and reads a git tree listing with `git show ref:dir`; it is caught only later by occupiedTarget or the write. Failing input: `{"report":{"path":""}}`. Refused, but with a misleading message.
