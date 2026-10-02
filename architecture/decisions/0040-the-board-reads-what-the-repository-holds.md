# 0040 — The board reads what the repository holds: the ladder runs and a pull request list handed over

Status: proposed · 2026-10-02

## Context

A repository the construct generated or attached has the ladder's record, `.construct/runs.jsonl`, and the
open pull requests on its host. It has none of what this repository's own board reads: no handoff directory,
no Ghost journal, no task worktrees, no turn journal until the hooks ship in templates. The owner asked for a
`construct board` for those repositories that reads only what they hold.

## Decision

1. **Two sources, each through its own reader, joined to nothing**: the ladder's record through `readLedger`,
   unchanged, and the pull request list that `gh pr list --json` writes, from the file `--prs` names or from
   stdin. A ladder run is not matched to a pull request: nothing in either says they belong together.
2. **The CLI spawns nothing.** The list is handed over after `gh` fetched it, as
   [0031](0031-the-cli-owns-the-mutation-the-runner-owns-execution.md) leaves execution to the runner and has
   the CLI read what it hands over. The spawn row of the security invariants stands. Without `--prs` the board
   says the pull requests were not read and prints the command.
3. **The board knows nothing of this repository's own sources**: not `~/.construct/handoff`, not `ghosts.jsonl`,
   not the owner-merge table, not behind a flag. `pnpm board` stays the board of this repository.
4. **The turn journal is not read in this version.** `.construct/turns.jsonl` has no writer in a generated
   repository yet; a turns source is a separate task after the hooks ship in templates.
5. **The board writes no file**, `--every` included: it redraws the screen.
6. **`--json` has its own format id, `user-board/1`**, in the `format` key. `board/4` is the contract of
   this repository's `pnpm board` and is not shared.
7. **The empty state names what was read.** With nothing open the board prints two lines in place of the
   table: the first names the ladder runs (only when the repository has `.claude/skills/implement/SKILL.md`)
   and the pull requests read, or that they were not read with the `gh` command; the second tells how to start
   a ladder run, or that without `/implement` the board lists pull requests only.

## Consequences

- A repository on the cursor-only target has no `/implement` and so no ladder rows: the board lists pull
  requests only and says so.
- A ladder run and the pull request it opened are two rows until a later decision gives them a recorded join.
- `--json` carries `schemaVersion` as every `--json` of the CLI does, and `format` beside it.

## Enforced by

- L3 tests: `tests/board.test.ts`, the exit table in `tests/cli-exit-codes.test.ts`, the recorded surface.
- Lint: the `spawnPolicy` block of `eslint.config.mjs`, which forbids a spawn under `src/`.
- L1 review for the lore strings.

## What would reverse it

A repository where the pull request list must be fetched by the CLI itself to be of use, shown by users
who never pipe `gh`.
