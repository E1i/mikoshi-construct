[review:681]

# Re-review 4 of PR #625 (card #681 roles-in-cloud)

Head reviewed: ede8d2345ecceb679506928ed3b002dcd4ae23a3 (matches the head named in the task).

## Verdict: pass-with-notes

## Fixes from re-review 3
1. role.ts parseArgs on an unknown option: holds. `parsedArgs` catches the parse error, `roleOutcome` returns code 1 with the usage on stderr. Test `an unknown option` (`review --task t1 --bogus`) added in role.test.ts.
2. verdict --from with report.path `ghosts.jsonl`: holds. `reportPathFault` refuses `reportPath.toLowerCase() === JOURNAL_FILE` before any read of the report; test `refuses a report named like the journal before any read, and writes nothing` checks the directory is unchanged.
3. role --task unvalidated: same class as owner-accepted review-1 note 5, not re-opened.

## Checks
- owner-merges.md: `git diff --word-diff` shows additions only (`cloud-key.ts` in the `ghosts` cell, `role.ts` in the plain list, one history sentence). No removals.
- Registries: package.json `ghosts:role` has its CONTRIBUTING.md row and its OUTSIDE_THE_HARNESS entry. No new scripts/shift file.
- No comments in the added code; all tests under scripts/tests/ and none beside the source.

## Tests run (after `pnpm install --frozen-lockfile`, exit 0)
- `NO_COLOR=1 pnpm exec vitest run scripts/tests/ghosts/role.test.ts scripts/tests/ghosts/verdict.test.ts scripts/tests/shift/shift-entry.test.ts` -> exit 0, 3 files, 46 tests passed
- `pnpm typecheck` -> exit 0
- `pnpm lint` -> exit 0

## Notes
1. scripts/ghosts/verdict.ts:155-162 (`reportPathFault`) - the report name is refused only when it equals the verdict file's name or the journal's; any other file of the handoff directory that is absent is created from a branch's bytes - failing input: a verdict with `"report":{"path":"brief-681.approved-sha256",...}` (the approval file is `<brief>.approved-sha256` beside the brief, scripts/ghosts/approval.ts:52) when no approval exists yet writes the branch's content as that approval; `occupiedTarget` guards only a file that already exists. Same for `merged.jsonl`, `status.md`, `tasks-*.json`. Suggest requiring the report name to match `^review-.+\.md$` (or the `role/<task>/` convention).
2. scripts/shift/shift.ts:631 - `CONSTRUCT_CLOUD=1` without `--check` refuses every run including `--help`-less read paths such as `--queue`/`--manual`; if those only print, they are blocked too - failing input: `CONSTRUCT_CLOUD=1 pnpm shift <file> --queue`. Low; the message is clear, and it may be intended.
