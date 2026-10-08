# Re-review 2 of PR #627 (card #684 relaunch-passes-handoff-path)

Head reviewed: 1e9be3738e194eb612347b67e0fee368d7ccb2f5 (matches the requested head). Delta: 73d071f..1e9be37, four files.

## Verdict: pass

Previous notes:
1. Fixed. `resolves a relative handoff path against the current directory before it reads, journals or names it` passes `path.relative(world.repo, world.handoff)` (a `../` path, not already absolute) and asserts the prompt's first line and all three journal `handoff` fields equal the absolute path. Replacing `path.resolve` with the raw argument makes it fail.
2. Fixed. CONTRIBUTING.md:129 now says the prompt names the handoff's absolute path and is where the STOP section and STATUS line go, and documents `~/`, `relaunch-start`.

Owner order (literal `~/`): `expandHome(parsed.handoff, deps.home)` runs before `path.resolve(deps.cwd, ...)` at relaunch.ts:148; `realDeps` sets `home: os.homedir()`; `relaunch-start` is journaled with the absolute path. One `handoff` const feeds the STATUS reads (:156, :183), the `relaunch-start`/`relaunch`/`relaunch-stop` lines, the log name (`${handoff}.relaunch-<n>.log`) and `relaunchPrompt(handoff)`, so every reader gets the same expanded absolute path. Tests: literal `~/handoff.md` reads, journals and names `world.handoff`; `expandHome` table covers `~`, `~/a/b.md`, `~other/b.md`, `a/~/b.md`. No other consumer of the `relaunch-*` events exists (grep).

## Tests

- `pnpm install --frozen-lockfile` -> exit 0
- `NO_COLOR=1 pnpm exec vitest run scripts/tests/shift/` -> exit 0, 21 files, 247 tests passed
- `pnpm typecheck` -> exit 0
- `pnpm lint` -> exit 0

## Notes

None.

## Observations

- `~user/...` is not expanded (only `~` and `~/`); the test table pins this, and docs say "a leading `~/`", so it is consistent.
- `relaunch-start` is journaled before the model and handoff checks, so a refused run leaves start and stop lines; intended by the owner's order ("at start").
- No new file under scripts/ghosts, scripts/shift or package.json script, so no registry entry is needed.
