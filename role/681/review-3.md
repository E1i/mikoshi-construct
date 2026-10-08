[review:681]

# Re-review 3 of PR #625 at a23b2535680830da94128a40a6c441b34bc8dd69

Verdict: pass-with-notes. Head matches the requested sha.

## Previous notes
1. verdict --from writes verdict then report, not atomically: same class as owner-accepted review-1 note 4; not re-opened.
2. report.path "" or ".": fixed. `git diff 9c02368 a23b253` adds a guard at the top of reportPathFault (scripts/ghosts/verdict.ts:151) refusing both before any `git show`; message names the path and says nothing written. New test `it.each([empty-report, dot-report])` asserts the exact reason and that the directory is unchanged. Holds.

## Checks
- owner-merges.md: `git diff --word-diff` is additions only (history sentence, `cloud-key.ts` in ghosts cell, `role.ts` in plain list). Classification choices (Eli's): cloud-key.ts -> ghosts; role.ts -> plain list.
- package.json `ghosts:role`: row in CONTRIBUTING.md § Scripts and OUTSIDE_THE_HARNESS entry present.
- No comments added; tests under scripts/tests/. shift.ts text names no merge; no own-instructions registration needed.

## Tests (pnpm install --frozen-lockfile exit 0)
- NO_COLOR=1 pnpm exec vitest run scripts/tests/ghosts/role.test.ts scripts/tests/ghosts/verdict.test.ts scripts/tests/shift/shift-entry.test.ts -> exit 0, 3 files, 44 tests passed
- pnpm typecheck -> exit 0
- pnpm lint -> exit 0

## Notes
1. scripts/ghosts/role.ts:28 - parseArgs throws on an unknown option instead of printing the usage; the documented "prints the usage and exits 1" holds only for a missing task or bad role. Failing input: `pnpm exec tsx scripts/ghosts/role.ts review --task 1 --bogus` -> ERR_PARSE_ARGS_UNKNOWN_OPTION stack trace, exit 1. Harmless to routing.
2. scripts/ghosts/verdict.ts:184 - report.path may equal the journal name `ghosts.jsonl`; when the handoff dir has no journal yet, occupiedTarget passes and the report bytes are written as the journal, which appendJournalEvent then appends to. Failing input: verdict `{"report":{"path":"ghosts.jsonl"}}` with --dir lacking ghosts.jsonl. The first journal line is a markdown report; readers skip unparseable lines, and the report sha256 must still match, so the damage is bounded and needs a hostile or mistaken branch.
3. scripts/ghosts/role.ts:36 - `--task` is not validated as an id; `--task 'a b/../x'` prints a cloud/local line naming branch `role/a b/../x-review`. Cosmetic, the window supplies the id.
