# Review of PR #627 (card #684 relaunch-passes-handoff-path)

Head reviewed: 73d071f421bb146812312072e16284d8425057dd (matches the requested head).

## Verdict: pass-with-notes

The path relaunch passes is the path it reads STATUS from: `scripts/shift/relaunch.ts:141` resolves `handoff = path.resolve(deps.cwd, parsed.handoff)` once, and that same value feeds `readHandoff` (:156, :183), the log name (:175), the journal (:178) and `relaunchPrompt(handoff)` (:175). So it is absolute, and a relative argument is resolved against `deps.cwd`, which is also the child's `cwd`. No other user of `RELAUNCH_PROMPT` exists in the repository (grep); the constant is removed cleanly.

## Tests

- `NO_COLOR=1 pnpm exec vitest run scripts/tests/shift/` -> exit 0, 21 files, 241 tests passed
- `pnpm typecheck` -> exit 0
- `pnpm lint` -> exit 0

## Notes

1. scripts/tests/shift/relaunch.test.ts:77-80 - the new test never exercises the "absolute after resolution" claim - `relaunch()` always passes `world.handoff`, which is already absolute, so replacing `path.resolve(deps.cwd, parsed.handoff)` at relaunch.ts:141 with the raw argument keeps every test green. Failing input: `runRelaunch(['rel/handoff.md', ...])` with cwd=world.repo; the prompt would carry `rel/handoff.md` and no test fails.
2. CONTRIBUTING.md:129 - the `pnpm relaunch` row still says only "the continuation prompt on stdin" - it does not say the prompt now names the handoff's absolute path and tells the session to write STOP/STATUS there; window.md was updated but this second description of the same behaviour was not. Input: a reader of § Scripts expects the bare prompt.

## Observations

- relaunch.ts:21 - the prompt instruction is advisory; a session can still write another file. Relaunch detects this only as `STATUS: none`/unchanged status, which is existing behaviour.
- A handoff path containing a newline would break the first-line shape of the prompt; not realistic.
- architecture/window.md line is now very long; no lint rule fails on it.
