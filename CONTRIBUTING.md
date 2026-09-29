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
5. `pnpm changeset` — `minor`, one line starting with `templates:` (see [Changesets](#changesets)).

## Changesets

A changeset is one line, written from the user's point of view: what someone who runs the CLI or
opens a generated project now gets, and, when they must act, what to do. Details — the design, the
cases, the files touched — go in the pull request, and the release note links to it:
`@changesets/changelog-github` puts the pull request link, the commit and the author in front of the
line when the version pull request is built, so the line never writes them itself. Start the line
with `cli:` or `templates:` and pick the bump as [.changeset/README.md](.changeset/README.md) says.
`tests/changesets-one-line.test.ts` fails when a pending changeset's summary runs past one line.

## Version ranges

Point every range in a template at the previous release, not the latest. Users run pnpm with
`minimumReleaseAge`; a range that only matches today's publish fails their first install. The
places a bump touches are listed in CLAUDE.md.

## Scripts

Every script in `package.json` has a row here, and `tests/contributing-scripts.test.ts` fails when a
script has no row or a row names a script that no longer exists. `pnpm run quality` is the gate; the
scripts it runs are marked "in the harness". Every other script sits outside the harness with its
reason in `tests/harness-membership.test.ts`. The three `ghosts:*` scripts and `board` run the Ghost
workflow described in [AGENTS.md](AGENTS.md). Paths below are placeholders: `<repo>` for a checkout,
`<scratchpad>` for the directory outside the repository that holds briefs, tasks files, `status.md`
and the journal, `<worktree>` for a Ghost's worktree.

| Script | What it does | How to run it |
|---|---|---|
| `pnpm run quality` | The harness: `composition:check`, `model:check`, `privacy:check`, `lint`, `typecheck`, `test`, `docs:build`, `docs:pending` and `docs:anchors`, in that order, stopping at the first failure. | `pnpm run quality` |
| `pnpm run ci` | An alias of `quality`; `run` is needed because bare `pnpm ci` is pnpm's install builtin. | `pnpm run ci` |
| `pnpm composition:check` | In the harness. Checks each composition model under `architecture/composition/`: named after its id, every path it names exists, its rendered doc current. | `pnpm composition:check` |
| `pnpm composition:render` | Rewrites the rendered flow docs from the composition models; `composition:check` is its gate. | `pnpm composition:render` |
| `pnpm model:check` | In the harness. Checks that the picture of `construct.model.json` in `architecture/model.md` is current. | `pnpm model:check` |
| `pnpm model:render` | Rewrites that picture from `construct.model.json`; `model:check` is its gate. | `pnpm model:render` |
| `pnpm privacy:check` | In the harness. Fails on a home path or an unlisted domain in templates, docs, README or fixtures. | `pnpm privacy:check` |
| `pnpm lint` | In the harness. ESLint over the repository; it is the only formatter. | `pnpm lint` |
| `pnpm lint:fix` | ESLint with `--fix`, the way to fix style; `lint` is its gate. | `pnpm lint:fix` |
| `pnpm typecheck` | In the harness. `tsc --noEmit`. | `pnpm typecheck` |
| `pnpm test` | In the harness. Vitest over `tests/` and `scripts/tests/`, once. | `pnpm test [<file>]` |
| `pnpm test:watch` | The same tests in watch mode. | `pnpm test:watch [<file>]` |
| `pnpm test:weights` | Rewrites `scripts/ci/test-weights.json`, the per-file durations CI balances its vitest shards by, from a Vitest JSON report. Run it when one shard's job runs noticeably longer than the other. | `pnpm test:weights [<report>]` (default `.construct/reports/vitest.json`) |
| `pnpm docs:build` | In the harness. Builds the VitePress site in `docs/`. | `pnpm docs:build` |
| `pnpm docs:pending` | In the harness. Builds a copy of the docs with the pending changesets rendered into the release index, so a changeset that breaks the site fails before the release does. | `pnpm docs:pending` |
| `pnpm docs:anchors` | In the harness, after `docs:build`. Fails when an anchored nav or sidebar link does not resolve to a rendered heading. | `pnpm docs:anchors` |
| `pnpm docs:dev` | Serves the docs locally with reload. | `pnpm docs:dev` |
| `pnpm docs:preview` | Serves the built docs locally. | `pnpm docs:preview` |
| `pnpm dev` | Runs the CLI from source; bare `pnpm dev` prints the usage. | `pnpm dev <command> [flags]`, for example `pnpm dev doctor --dir <repo>` |
| `pnpm build` | Bundles the CLI with tsup into `dist/cli.js`. | `pnpm build` |
| `pnpm contract:update` | The only writer of `contract/surface.json`, the recorded command-line surface; `tests/contract/` is its gate. | `pnpm contract:update` |
| `pnpm contract:bump` | Compares `contract/surface.json` with the surface at the last release tag and fails when the pending changesets declare a weaker bump than the change requires. Outside the harness because it needs the tags and full history; CI runs it in its own job. | `pnpm contract:bump [--base <ref> --head <ref>]` |
| `pnpm bench:architect` | The architect benchmark. It calls the Anthropic API and costs real money, so it runs only with `--yes`. | `pnpm bench:architect --yes [--rounds <n>] [--out <file>]` |
| `pnpm changeset` | Adds a changeset: the bump level and the release-note line for a change. | `pnpm changeset` |
| `pnpm version-packages` | Applies the pending changesets to the version and changelog, then renders the release notes. The release workflow runs it. | `pnpm version-packages` |
| `pnpm release-notes:render` | Rewrites the rendered release notes under `docs/release-notes/` from the changelog. | `pnpm release-notes:render` |
| `pnpm release` | Builds, stages the publish on npm and tags the release. The release workflow runs it; a publish cannot be undone. | `pnpm release` |
| `pnpm release:verify` | Polls the registry until the version in `package.json` is installable. The release workflow runs it after a publish. | `pnpm release:verify` |
| `pnpm prepublishOnly` | The npm hook that builds before a publish; not run by hand. | run by npm |
| `pnpm ghosts:hash` | Prints the sha256 of a brief's `/implement` text, the hash the owner approves. | `pnpm ghosts:hash <scratchpad>/brief-<task>.md` |
| `pnpm ghosts:launch` | Checks each task's brief against its `.approved-sha256`, prints the decision and, only on the answer `yes`, opens one headless ladder session per task in a new worktree. | `pnpm ghosts:launch --tasks <scratchpad>/tasks-<batch>.json` |
| `pnpm ghosts:watch` | Prints one read-only line per task of a tasks file: report age, last tool, ledger stage and whether the session is alive. | `pnpm ghosts:watch --tasks <scratchpad>/tasks-<batch>.json [--every <seconds>]` |
| `pnpm board` | Prints a read-only view of every task in a handoff directory, ladder and cheap path, from its tasks files, `status.md`, the journal and `gh`: one line per task by default, one task's card with a task id, everything as JSON with `--json`. A task is ready when the `required` check is green on its pull request's current head; `--every` reprints the view until interrupted. | `pnpm board [--dir <scratchpad>] [<task-id>] [--all] [--json] [--every <seconds>] [--repo <owner>/<name>]`; without `--dir` it reads `$CONSTRUCT_HANDOFF_DIR`, else `~/.construct/handoff` |

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

`board`, run on the `next` and `cheap` test fixtures together with `gh` stubbed and now at
2026-09-28T12:00:00Z; a task id in place of the list prints that task's card with every attempt,
stage and fact, `--json` prints all of it for an agent, and `--every` heads each frame with
`[board] frame <time>`:

```text
running 7, waiting 6, blocked 1, the longest — 300 min (n-red)
# TASK · PATH · STAGE · AGE · NEXT — TASK = the live attempt; PATH = ladder or cheap; STAGE = the latest stage recorded done; AGE = the time since it, "clock skew" when that time is ahead of now; NEXT (derived) = what the task waits for and from whom, from the stage, the PR's CI and architecture/owner-merges.md
# pnpm board <task-id> prints one task's card with every attempt; --json prints everything; hidden: 3 tasks, --all shows them
l-1 · ladder · ghost · 5h30m · verdict (window)
n-red · cheap · started · 5h00m · a fix (window): CI red
n-owner · cheap · ready · 4h40m · Eli's merge
n-auto · cheap · ready · 4h40m · auto-merge (window arms it)
n-nofiles · cheap · ready · 4h40m · merge (UNKNOWN whether Eli's or auto-merge)
n-closed · cheap · started · 5h00m · a decision (window): PR closed unmerged
n-pending · cheap · started · 5h00m · CI
n-release · cheap · ready · 4h40m · Eli's merge
n-lost · cheap · started · 5h00m · UNKNOWN (the PR is not readable)
n-pushed · cheap · started · 5h00m · CI
c-open · cheap · started · 3h00m · CI
c-noready · cheap · started · 2h00m · a PR (window)
s-stopped · ladder · ghost · 6h00m · a new attempt (window)
s-nopr · ladder · review · 5h50m · a PR (window)
c-gh · cheap · merged · 3h20m · —
c-journal · cheap · merged · 4h00m · —
UNKNOWN: brief.written ×1, brief.approved ×3, review.started ×2, ready ×3, merge ×3, pr ×2
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
