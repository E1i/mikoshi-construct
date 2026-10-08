[review:681]

# Re-review 5 of PR #625 (card #681 roles-in-cloud)

Head reviewed: c642703d6d167682060a01ff2d2728f5cee67f1a (matches the head named in the task).

## Verdict: pass

## Re-review 4 notes
1. `verdict --from` creating another absent handoff file: fixed by c642703. `reportPathFault` now requires the report path to match `CLOUD_REPORT_NAME` (`/^review(?:-[\w.-]+)?\.md$/`), after the path, `..`, directory-part and verdict-name checks. The refusal runs before any `git show` of the report and before any write. Tests refuse `ghosts.jsonl`, `brief-681.approved-sha256` and `status.md` and assert nothing is written. No name outside `review*.md` reaches a write; a differing existing target is refused by `occupiedTarget`.
2. `CONSTRUCT_CLOUD=1` refusing `shift <dir> --queue`: by design, `--check` stays allowed. Accepted.
Non-atomic two writes and unvalidated `--task` echo: accepted by the owner, not re-opened.

## Whole-diff review
- `owner-merges.md` word-diff is additions only: `cloud-key.ts` added to `ghosts`, `role.ts` to the plain list, one history sentence.
- No comments in the added code; no test beside source (tests are under `scripts/tests/**`).
- `ghosts:role` has its CONTRIBUTING.md row and its OUTSIDE_THE_HARNESS entry.
- The branch merges cleanly into current origin/main (`git merge-tree` exit 0).

## Tests run
- `pnpm install --frozen-lockfile` -> exit 0
- `NO_COLOR=1 pnpm exec vitest run scripts/tests/ghosts/role.test.ts scripts/tests/ghosts/verdict.test.ts scripts/tests/shift/shift-entry.test.ts` -> exit 0, 3 files, 48 tests passed
- `pnpm typecheck` -> exit 0
- `pnpm lint` -> exit 0

## Notes
none
