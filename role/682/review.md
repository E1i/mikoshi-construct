# Review of card #682 relaunch

Head reviewed: 1c711d29d404f51dbd9ca7402a219729e8a639a1 (matches the requested head). Base: origin/main ab581d8; the merge with main is conflict-free (git merge-tree).

Verdict: pass-with-notes. No defect found in the properties the card names.

## Tests run (feature tree = origin/main + the diff, after `pnpm install --frozen-lockfile`)

- `NO_COLOR=1 pnpm exec vitest run scripts/tests/shift/` -> exit 0, 21 files, 237 tests passed
- `pnpm typecheck` -> exit 0
- `pnpm lint` -> exit 0
- `NO_COLOR=1 pnpm exec vitest run tests/harness-membership.test.ts` -> exit 0, 3 passed

## What was checked

- Loop bound: `sessions` increments once per iteration and `sessions >= max` stops, so at most `--max` sessions; `--max` must match `^[1-9]\d*$`. A claude exit, nonzero or unspawnable, does not stop the loop but is bounded by max.
- A session started when it must not be: the handoff is read and checked (handoff:check, STATUS) at the top of every iteration, the first included. A refusal, a STATUS other than CONTINUE, a missing model and `--max` reached all stop before `deps.run`.
- STATUS read: the last line matching `^STATUS:\s*(CONTINUE|OWNER|DONE)\b`. An unknown word is skipped, so `STATUS: OWNER` then `STATUS: MAYBE` reads OWNER, which is stopping and so fail-safe. An indented or bolded line is not read, which gives exit 1.
- Journal: one `relaunch` line per session (handoff, session, model, n, exit, status, ts), one `relaunch-stop` per stop after argument parsing (reason, sessions, ts). The status in the session line is re-read after the session. An unreadable handoff is recorded as `none`.
- claude.ts callers: `card` is optional and `sessionEnv(base, card?)` already accepts undefined; `extraArgv` defaults to `[]`, so `claudeArgv` output is unchanged for the existing callers (shift.ts and the e2e tests).
- argv injection: `--model` and the transcript model go in as separate `"$@"` elements of `sh -c`, never interpolated into the command string. `--model` values starting with `--` are refused. Transcript lines that don't parse are skipped.
- Comments in code: none. Tests are under `scripts/tests/shift/`, none beside the source.
- Registries: CONTRIBUTING.md § Scripts row and the OUTSIDE_THE_HARNESS entry are present. `relaunch.ts` does not name a merge, so no `own-instructions` entry is needed. owner-merges.md is untouched, which is allowed.

## Notes

1. `scripts/shift/relaunch.ts:75` (parseArgs) - a model value with a single dash is accepted - `--model -p` runs `claude ... --model -p`. This is not shell injection, because the value is one argv element, but it can feed claude a flag as the model. Low. Reject values starting with `-`.
2. `scripts/shift/relaunch.ts:148` - a session that exits nonzero or is unspawnable (`exit: null`) does not stop the loop - `SHIFT_CLAUDE=/nonexistent pnpm relaunch h.md` with STATUS CONTINUE journals `exit:null,status:CONTINUE` and tries again until `--max`. Bounded, but it wastes sessions. Low.
3. `scripts/shift/relaunch.ts:104` - a bad argv (`--max 0`) prints usage and exit 1 with no `relaunch-stop` line. The card says one line per stop. Low.
4. `scripts/tests/shift/relaunch.test.ts` - no test for an unspawnable or nonzero exit, a handoff deleted between sessions, a transcript whose only model is `<synthetic>`, or the `realDeps` entry point. Low.
