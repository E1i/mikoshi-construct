# Contributing

The most useful contribution is a preset for a stack the construct does not cover yet, or a fix to
a template that broke a generated project. Both follow the same loop.

## The loop

```bash
pnpm install
pnpm dev init --yes --preset node-backend --dir /tmp/demo   # run the CLI from source
cd /tmp/demo && pnpm install && pnpm run quality              # the acceptance every preset must pass
```

`pnpm run quality` in this repository is the gate for your change; the acceptance above, for every
preset you touched, is the gate for the templates. CI runs both — the acceptance on Node 22 and 24
and once under pnpm's `minimumReleaseAge` policy.

Read [CLAUDE.md](CLAUDE.md) before touching `templates/`: it lists the conventions that are easy to
get wrong — `_` for dotfiles, `.eta` and `.existing.eta`, how groups layer, why `no-restricted-syntax`
blocks are cumulative, and where a version bump has to land.

This repository runs on its own construct. `/plan` and `/implement` in Claude Code work here; so does
`construct doctor`.

Pull requests from the maintainer end with a compact matrix and record, before each run, a
prediction of what will turn red and a named wrong implementation applied as a mutation
([decisions 0027](architecture/decisions/0027-an-acceptance-is-red-before-the-implementation-exists.md)
and [0029](architecture/decisions/0029-an-acceptance-is-red-under-a-named-wrong-implementation.md)).
The matrix, the predictions and the mutations are not required from an outside contributor: they
are the maintainer's own record, described in [the code matrix](architecture/code-matrix.md). A
contribution needs a green `pnpm run quality` and a test for what it changes.

## One tree, one writer

While `/implement` runs its ladder in a working tree, nothing else writes to that tree: no experiment
or probe files, no second agent, no edits by hand. The ladder's harness verdict is about the tree it
ran in, so a file another writer adds or changes during the run makes that verdict about something
else.

Parallel work goes into a separate git worktree, and **that worktree lives outside the repository**,
for example `git worktree add ../<name> <ref>`, never under `.claude/worktrees/`. A nested worktree is
a full second copy of `src/`, `tests/` and `scripts/` inside the tree the tools walk. eslint excludes
nested worktrees (#204). But one vitest report from the main checkout once named a nested worktree's
test file, and that has been neither reproduced nor explained (observation *A vitest report named a
test file from a nested worktree, once, and was not reproduced* in
[observations.md](architecture/observations.md)). So the rule stands on its own and does not end
with #204.

A new task gets a new worktree from `origin/main`, for example
`git worktree add -b <branch> ../<name> origin/main`; nobody writes in the main checkout. Before
removing a worktree, check `git -C <path> status --porcelain` and list its ignored files
(`git -C <path> status --porcelain --ignored`): `git worktree remove` deletes them without asking, and
an ignored `.construct/runs.jsonl` inside it may be the only copy of a ledger line.

Nothing enforces this; it is kept by review.

## Adding a preset

1. `templates/presets/<id>/baseline/` — what every repository gets: lint policy, `package.json`
   partial, tsconfig. `templates/presets/<id>/sample/` — example code, written only into an empty
   directory. Anything shared with another preset goes to `templates/stacks/`.
2. Register it in `src/presets/index.ts` with its groups and variables.
3. Ship the generated artifacts pre-generated (contract types, rendered composition docs) so the
   harness is green at first run; regenerate them in a scratch project and copy back.
4. Add the preset to the acceptance matrix in `.github/workflows/ci.yml` and to the README table.
5. `pnpm changeset` — `minor`, summary starting with `templates:`.

## Version ranges

Point every range in a template at the previous release, not the latest. Users run pnpm with
`minimumReleaseAge`; a range that only matches today's publish fails their first install. The
places a bump touches are listed in CLAUDE.md.

## Scripts

Four maintainer scripts run the Ghost workflow described in [AGENTS.md](AGENTS.md). None of them is
a verdict on a change, so they sit outside the harness, each with its reason, in
`tests/harness-membership.test.ts`. Paths below are placeholders: `<repo>` for a checkout,
`<scratchpad>` for the directory outside the repository that holds briefs, tasks files, `status.md`
and the journal, `<worktree>` for a Ghost's worktree.

| Script | What it does | How to run it |
|---|---|---|
| `pnpm ghosts:hash` | Prints the sha256 of a brief's `/implement` text, the hash the owner approves. | `pnpm ghosts:hash <scratchpad>/brief-<task>.md` |
| `pnpm ghosts:launch` | Checks each task's brief against its `.approved-sha256`, prints the decision and, only on the answer `yes`, opens one headless ladder session per task in a new worktree. | `pnpm ghosts:launch --tasks <scratchpad>/tasks-<batch>.json` |
| `pnpm ghosts:watch` | Prints one read-only line per task of a tasks file: report age, last tool, ledger stage and whether the session is alive. | `pnpm ghosts:watch --tasks <scratchpad>/tasks-<batch>.json [--every <seconds>]` |
| `pnpm board` | Prints a read-only view of every task in a handoff directory, ladder and cheap path, from its tasks files, `status.md`, the journal and `gh`. | `pnpm board --dir <scratchpad> [--all] [--repo <owner>/<name>]` |

`ghosts:hash`:

```text
9bc59ac574a7bba0f6e23109c509071a9484c050fb5e181ef769ebbeba043a93
```

`ghosts:launch`, answered with anything but `yes`, which exits 1 and opens nothing:

```text
DECISION: open 1 sessions
  demo-2: /implement <scratchpad>/brief-demo.md (approved 9bc59ac) -> <worktree> on ghost/demo-2 @ b736fed, report <scratchpad>/ghost-demo-2.jsonl, session <uuid>
```

`ghosts:watch`:

```text
[ghosts:watch] frame 2026-09-28T08:37:03.173Z
[ghosts:watch] ghost-demo-1 | report 0s | tool Bash | stage implementing r-0001 | process dead
```

`board`, one cheap-path task out of the full output, which opens with a summary line and the
definitions of every stage:

```text
task c-open (derived) live c-open waiting
  c-open live waiting
    started done 2026-09-28T09:00:00.000Z (journal event:path)
    ready done 2026-09-28T09:15:00.000Z (journal event:path)
    pr #22 OPEN, ci green 2026-09-28T09:20:00Z on 2222222
    merged — (PR #22 OPEN)
```

## After a release

A release is done when these five checks pass, run once the staged publish has been approved. `<V>`
is the released version, `<M>` the merge commit of the version pull request.

1. `npm view mikoshi-construct dist-tags.latest --prefer-online` prints `<V>`.
2. `npm stage list` finds no staged package.
3. The tag `v<V>` points at `<M>`, and its GitHub release is published.
4. The Release verification run on `<M>` reports that `<V>` is on the registry and installable, and
   Published smoke is green.
5. `npx mikoshi-construct@<V> --version`, run from a scratch directory outside this repository,
   prints `<V>`.

## Reporting a discovery that went wrong

If `/construct-discover` filled a marker with something false, open a "Discovery report" issue with
the marker name, what it wrote and what the code actually says. The protocol is a markdown file
(`templates/ai/shared/_claude/commands/construct-discover.md`); most fixes are one sentence in it.
