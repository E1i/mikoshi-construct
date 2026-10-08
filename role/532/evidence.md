# #532 discovery-fills-engram — evidence for the brief

Base: origin/main 1e15c1a (the sketch was cut from ed6b25f and rebased twice; `git range-diff` shows every commit `=`). Sketch: `sketch/discovery-fills-engram @ 5383423e9c75e5b07b2792ffbeaff9cfda50a4af`.

Real directories (card line 1): the card's touches are `src/detect/**, src/model/**, tests/**`. Discovery has no code today — it is the agent protocol `templates/ai/shared/_claude/commands/construct-discover.md`. The sketch's code is in `src/detect/git.ts`, `src/model/{scan,discovery,schema}.ts` as the card says, and it also has to touch `eslint.config.mjs`, `architecture/security-invariants.md` (the second spawn), `architecture/engram.md` (the format document `tests/engram-format.test.ts` reads), `AGENTS.md` (the dependency-policy block) and `contract/surface.json` (generated, `formats.modelVersion 4 → 5`).

SCHEMA: changed — `modelVersion` 5, one optional `mechanics` object; `stages`/`nodes`/`links` untouched (brief, Effort and Design 4).

## Base-red (clean `git worktree add` of origin/main 1e15c1a, nothing laid over, `pnpm install --frozen-lockfile`)

| Witness | Base | Sketch staged on base |
|---|---|---|
| W1 byte-identical engram | 1 | 0 |
| W2 foreign repository: components, relations, lines | 1 | 0 |
| W3 unresolved import is unknown | 1 | 0 |
| W4 no git: identity and tree unknown | 1 | 0 |
| W5 no capability, no state | 1 | 0 |
| W6 attach: written under home, `git status` clean | 1 | 0 |
| W7 init: own construct.model.json, facts and claims kept | 1 | 0 |
| W8 comment/string is not a relation | 1 | 0 |
| W9 git readings may spawn, no code loading | 1 | 0 |
| W10 engram.md explains every mechanics property | 1 | 0 |
| W11 MODEL_VERSION 5 in source and surface | 1 | 0 |
| W12 only two files import node:child_process | 1 | 0 |
| W13 one minor changeset | 1 | 0 |
| I2 touched-files allow-list | 0 | 0 |
| I3 no comment added | 0 | 0 |
| I4 `pnpm contract:bump` | 0 | 0 |
| I5 no command reaches discovery | 0 | 0 |
| I6 only the version-4 lines leave the two version tests | 0 | 0 |
| I7 existing model suites | 0 | 0 |

BASE-RED: 13 of 13. Every red on base is the test or file being absent (vitest prints no ✓; the grep finds nothing), not a missing command. The sketch column is the sketch staged on the base the way the launcher stages it (`git checkout <sketch> -- .` on a detached origin/main), so the diff witnesses see `HEAD` = origin/main.

## Positive control (PR-equivalent)

- I1 `pnpm run quality`: **exit 0** on the sketch 5383423 (on base 1e15c1a), 307 test files, 3975 tests passed, 15 skipped. On the base d87335c, exit 0, 305 files, 3943 passed; on ed6b25f, exit 0, 3921 passed. Both run as a non-root user in a fresh clone: as root, `scripts/tests/ghosts/cleanup.e2e.test.ts` l2 and s2 fail on origin/main too (they expect a chmod-ed file to be unwritable, which root ignores) — an environment fact of this cloud container, not the sketch's.
- `pnpm exec tsx scripts/release/version-pr-guard.ts` 0; `pnpm build` 0; `pnpm contract:bump` 0 (`required: minor`, `declared: minor`, `formats.modelVersion: 4 → 5`); the `required` job's doctor check (`vitest --reporter=json` then `dev doctor --json`): `harness.state` = `checked`.
- Acceptance cell node-backend from the built CLI: `init --yes --preset node-backend` 0, `pnpm install` 0, `pnpm run quality` 0, `doctor` 0; the generated `construct.model.json` carries `"modelVersion": 5`.
- `scripts/attach/earlier-carriers.ts --check` needs the full history (it exited 1 in a shallow clone with "in neither history nor the working tree"); the sketch touches no attach carrier, so the preflight does not run it. `Secret scan` (gitleaks) is not installed here; the sketch adds no secret, and CI's scan is the evidence.
- Environment: this container's pnpm 12.4.2 tool install was half-done (`Exec format error` on the nested `pnpm` in `quality`); running its own `install.js` in the session's `~/.local/share/pnpm/.tools` fixed it. Nothing in the repository was changed for it.

## Mutations (`construct mutate apply` / `judge` on the staged sketch, prediction written first, `--from` a scratch file, no `--card`; every outcome matched)

M1 | src/model/discovery.ts | find: `return place.attached ? path.join(` → `return false ? path.join(` | red: W6 (attached repository: written under home, target untouched) | an attached repository's Engram would land inside the target tree
M2 | src/model/discovery.ts | find: `status: to == null ? 'unknown' : 'found', source: { path: file, line: entry.line }` → `status: 'found', source: { path: file, line: entry.line }` | red: W3 | an unresolved import would be claimed as found
M3 | src/model/scan.ts | find: `strings.matchAll(IMPORT_FROM)` → `code.matchAll(IMPORT_FROM)` | red: W8 | an import written inside a string literal would become a relation
M4 | src/model/discovery.ts | find: `tree: { status: treeFound ? 'found' : 'unknown'` → `tree: { status: 'found'` | red: W4 | a tree git could not list would read as found

## Open questions for the owner

1. Entry point. The card's touches (`src/detect`, `src/model`, `tests`) admit no command, so the sketch ships `discoverMechanics` / `writeEngram` as a library, called only by tests, with `attached` decided by the caller. Who runs discovery — a new `construct engram` (or `discover`) command, a step of `attach`, or `graph` — is a follow-up card (it changes `src/program.ts`, lore, `contract/surface.json`, `docs/cli.md` and a composition model). Proposed: a separate card before #533 needs live data.
2. The second spawn. The owner's mechanics (`git rev-parse`, `git ls-files`) mean the CLI no longer "spawns exactly one child process": the security-invariants row is rewritten to name the three fixed read-only commands (`-c core.fsmonitor=false --no-optional-locks`, no shell). That row is always high; confirm the weakening is accepted, or ask for the alternative (read `.git/HEAD`/refs and parse `.git/index` with no spawn — larger, and `command → exit` sources would disappear).
3. `<repo>` in `~/.construct/engram/<repo>/` is the target directory's basename, so two attached repositories with the same directory name share one file. Keep it, or key by something unique (e.g. the basename plus a hash of the absolute path, which would leave no absolute path in the file but makes the place machine-specific)?
4. Relation kinds are `imports` and `calls` (a call of an imported name). File read/write relations ("запись/чтение файла") and spawned-script relations (`shift.ts ──calls──> task-start.ts` when it runs the script rather than imports it) are not in this card: deciding that a string is a path needs judgement. Confirm they go to a later card.
