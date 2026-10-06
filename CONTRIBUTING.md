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
reason in `tests/harness-membership.test.ts`. The `ghosts:*` scripts and `board` run the Ghost
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
| `pnpm ghosts:cleanup` | Prints one line per task of a tasks file, or without `--tasks` per attempt the journal and the tasks files in the handoff directory name with a worktree and branch (a cheap-path attempt's PR is found by the number on its `event:path` line, else by branch), `ghost-<id> removed: …` or `ghost-<id> kept: <reason>`. Removes a task's worktree (`git worktree remove`, never `--force`) and its `<worktree name>.quality*.log` / `<worktree name>-quality*.log` files in `--logs` (default `/tmp`) only once `gh` shows its pull request merged, and before removing it appends to the main tree's `.construct/runs.jsonl` every line of the worktree's own ledger that the main one lacks (keyed on `run`, a line without one on its full text, in the worktree's order), reported as `<n> ledger lines carried into <path>`, and when the worktree has a step cache, every line of its `.construct/steps.jsonl` whose `run` the main tree's step cache lacks, reported as `<n> step cache lines carried into <path>`; keeps a task whose ledger or step cache lines could not be carried, with the error, and keeps a task with a `hand-ladder-<id>` policy row in `status.md`, a last `event:review` verdict of `changes`, an unmerged or missing pull request, a dirty worktree, or `gh` unavailable. A worktree no attempt names is never removed; each is printed as `unregistered <path> kept: named by no task`. `--repo` defaults to `gh repo view` in the tasks file's `repo`. `--ledger-only` carries the ledger and step cache lines of every task's worktree the same way, whatever its pull request, and removes nothing (`ghost-<id> ledger: <n> lines carried into <path>; worktree kept`; when the worktree has a step cache, `; <n> step cache lines carried into <path>` comes before `; worktree kept`, and when those lines could not be carried the line ends `; step cache lines could not be carried into <path>: <error>; worktree kept` instead). `ghosts:watch` never removes anything. | `pnpm ghosts:cleanup [--tasks <scratchpad>/tasks-<batch>.json] [--repo <owner>/<name>] [--logs <dir>] [--ledger-only]` |
| `pnpm ghosts:expect-sample` | Prints the `expect:` line a brief carries, ready to paste: the median of the done runs of the asked effort that the ledger parser accepts, then its sources and every reason a row was left out; a class, optional, narrows it to the runs the Ghost journal names under that class. With `--effort`, it also prints one `step` line per ladder step — the median tokens and minutes of that step over the done runs of that effort, or `none — n=<n> for <effort>/<step>` below five — read from the step cache `construct cost` keeps in `.construct/steps.jsonl`, and for a ledger run not cached yet from its transcript; it never writes the step cache, and neither does `ghosts:launch`. `ghosts:launch` ends each task line with the same breakdown for the effort after `Effort:` in the brief. | `pnpm ghosts:expect-sample [<class>] --effort <low\|medium\|high> [--journal <ghosts.jsonl>] [--runs <runs.jsonl>]…` |
| `pnpm task:start` | Checks the card first and refuses (exit 1, nothing cut, nothing written) with the reason when its form is wrong: the grammar, a milestone outside `src/card/milestones.ts`, a size, kind, contour or decision outside its list, a probe whose decision is not `none` or an implement task whose decision is not `owner` or `auto`. The old `task:start <id> <branch>` is refused with the new form. Refuses (exit 1, nothing written, no bypass flag) a card whose `depends` are not all merged, naming them. Refuses (exit 1, nothing written) when `../mc-<id>` exists or the branch exists locally; otherwise runs `git fetch origin main`, cuts `../mc-<id>` on the new branch from `origin/main`, with the id the card's `#<id>`, and appends one `event:path` line (`path` the card's contour, `started`, `session` from `CLAUDE_CODE_SESSION_ID`, `worktree`, `branch`, `card` with every field and the source `line`, `ts`) to `ghosts.jsonl` in the handoff directory (`CONSTRUCT_HANDOFF_DIR`, else `~/.construct/handoff`). Without a session the line has none and the board shows `WINDOW UNKNOWN (no session)`. | `pnpm task:start <branch> --card "#<id> <name> [<kind>/<milestone>/<size>/<contour>/<decision>] · depends <#id …\|—> · blocks <#id …\|—>"` |
| `pnpm task:close` | Appends the closing `event:path` line (`task`, `path` from the start line, `pr` or `report` as an absolute path, `verification`, `ts`) to `ghosts.jsonl` in the handoff directory. Refuses, writing nothing, without `--verification` or with a word outside `VERIFICATION_WORDS` (`scripts/board/verification.ts`), when no start line for the id carries a card, and when the closing does not fit the card's kind: an implement task closes with `--pr` only, a probe with `--report` only. | `pnpm task:close <id> (--pr <N> \| --report <path>) --verification <word>` |
| `pnpm task:merged` | For each pull request a closing `event:path` line names and no `event:merge` line records yet, runs `gh pr view` and, when it is merged, appends one `event:merge` line (`task` the card of the pull request body's first line, `pr`, `by`, `commit`, `merged`, `ts`) to `ghosts.jsonl`; an open pull request writes nothing and a second run adds nothing. The only writer of merge lines. A depends is met by a merge line. | `pnpm task:merged` |
| `pnpm shift` | Runs a shift: every `NN.md` in `<dir>`, in number order, each as a fresh headless session (`$SHIFT_CLAUDE -p --session-id <uuid>`, the prompt on stdin: `scripts/shift/header.md` with the task filled in, then the file's body) in the tree `task:start` cuts for it, with the same uuid as the session on its board line. The header forbids background commands, monitors and waiting for a notification: nobody wakes a headless session. A task file opens with `card:` (the task's card, which `task:start` checks and receives; `task:` is refused with a pointer to `card:`), `branch:` and `touches:` (exact paths or a trailing `/**`) and a blank line. Refuses (nothing started) when `<dir>/shift.jsonl` exists, a task file is malformed, two tasks share an id or a branch or declare overlapping `touches`, or `SHIFT_CLAUDE` is unset; warns, and starts, when a task's `touches` meets a file of an open pull request. A task whose tree cannot be cut, or whose session fails, is recorded in `shift.jsonl` and the next one runs; exit 1 when any task did not exit 0, or exited 0 without writing its report (`"report": false` in `shift.jsonl`, `0, no report` in the table). Each session writes `report-NN.md`, its output goes to `log-NN.txt`. With `--parking <parking>` the tasks come from `<parking>/<id>.md` instead, each with the same header plus `who:` and an optional `priority: p0`: the shift takes every card with `who: shift` whose `depends` are merged (a merge line in `ghosts.jsonl`) and which is not closed itself, `p0` first and then by id, leaves a card whose `touches` overlap one already taken, prints `parking: takes …` and one line counting the cards left by reason (`parking: left: 25 closed · 24 who window · 9 depends · 2 conflicts`), writes one `leaves #<id> (<reason>)` line per card left to `<dir>/queue.txt`, and records `parking` and `left` on the `start` line of `shift.jsonl`; `--queue` also prints the `leaves` lines, never a closed card's; `<dir>` keeps the journal and the reports. A header line `continue: auto` follows a session that leaves on an Eddies warn, or exits 0 at a boundary its report names with a `boundary: <which boundary>` line, while its task is open with a new session in the same tree, at most three times (default `stop`). A real shift records merged pull requests (as `pnpm task:merged` does) before it chooses and once after its last task; `--check` does neither, prints the same lines and a hint to run `pnpm task:merged` when a card is left on a `depends`, parses and checks, writes no `queue.txt` and starts nothing. The shift is the autopilot by default ([architecture/window.md § Choosing the contour](architecture/window.md#choosing-the-contour-cheap-path-or-ladder-path)): a card that ends short of an armed auto-merge or a closed probe leaves one `stop` line (`at` hash, merge, question, boundary or fault, and `why`) in `ghosts.jsonl`, a ladder card is never taken and stops at `hash`, and a card whose latest stop still stands is left as `waits <at>`. `--manual` turns the automation off for that run: every take and every continuation asks first, with no terminal every answer is no, and the run's `autopilot` line in `shift.jsonl` says `off`. | `pnpm shift <dir> [--parking <parking>] [--check] [--queue] [--manual]`, e.g. `SHIFT_CLAUDE='GH_TOKEN=$(gh auth token --user E1i) claude --permission-mode auto' caffeinate -dis pnpm shift ~/.construct/shift/2026-10-03-1500` — `caffeinate` wraps the whole runner, not `SHIFT_CLAUDE`, or the Mac sleeps between tasks |
| `pnpm shift:merge` | The merge decision for a shift task's pull request. The shift runner takes it itself once the session has exited, by the `PR #N` line of `report-NN.md` (never for a probe or a report with no such line), appends its lines to the report and records them as `merge` on the task's `shift.jsonl` line; run by hand, it takes the number. Reads the card from the first line of the description and the changed paths from `gh`, and the owner-merged kinds from `architecture/owner-merges.md` on `origin/main` (the same reader as the window's): decision `auto` with no owner-merged path arms auto-merge at the head sha; decision `owner` prints `decision owner — … merge is Eli's`, and an owner-merged path prints `owner path <path> — merge is Eli's`, each arming nothing. A description whose first line is not a card, or a `gh` failure, arms nothing and exits 1. | `pnpm shift:merge <N>` |
| `pnpm shift:report` | Prints one row per task of a shift from `shift.jsonl`: task (`NN.md #<id> <name> [<kind>/…]`) · exit · duration · PR (by branch, from `gh`; `—` for a probe without one, which closes with a report and no pull request) · the Eddies `budget-stop` of that task's session in its tree's `.construct/eddies.jsonl` · the `result:` line of `report-NN.md`, or `no report`. | `pnpm shift:report <dir>` |
| `pnpm done:check` | The done check a review of a ladder run starts with: every requirement of the brief mapped to a line of code and a test that reaches it, and every named function the change adds or cites checked for a stub and for a caller outside tests. Prints only PASS or FAIL, then what failed. | `pnpm --silent done:check --args .construct/implement-args.json --map <file> --base <sha>` |
| `pnpm ghosts:hash` | Runs `check-acceptance build` on a brief's `/implement` text; when the build fails, prints no hash and names its first error (exit 1); when it passes, prints the whole line for the brief's `.approved-sha256`: the sha256 of that text, the hash the owner approves, today's date, the approver (`--by <name>`, else `git config user.name`; with both empty it refuses, `approver not recorded`, exit 1, no hash) and the sketch's short sha, or `none`. | `pnpm ghosts:hash <scratchpad>/brief-<task>.md --by <name>` |
| `pnpm ghosts:launch` | Checks each task's brief against its `.approved-sha256` and reads the `Sketch:` line under its `/implement` line (a missing or malformed line, or a sketch branch that is absent, not at the approved sha or not containing `origin/main`, is refused), prints the decision and, only on the answer `yes`, opens one headless ladder session per task in a new worktree: HEAD at `origin/main`, with the sketch's tree staged for a task that names one; a sketch rebased onto a newer `origin/main` launches when `git range-diff` shows every commit `=`, or every commit `=` outside a generated path `REGENERATED` registers whose check then passes on the sketch after the install (an `event:approval-carry` line; a failing check frees the row with no session); the journal's `event:task` line carries `sketch`, `agreedSha256` (the approved hash, on every line) and `argsSha256` (the sha256 of the session's `.construct/implement-args.json` bytes when they were built from the approved text and the session's new ledger row names them, `null` otherwise). | `pnpm ghosts:launch --tasks <scratchpad>/tasks-<batch>.json` |
| `pnpm ghosts:verdict` | Checks a review agent's `review-<task>.verdict.json` against `contract/contours/review-verdict.schema.json`, its `tree` against the tree of the pull request's head commit, its `report.sha256` against the report file, its `task` against the report's first line `[review:<task>]`, and its `brief.sha256` against the brief's `.approved-sha256`, and only then appends the `event:review` line to `ghosts.jsonl`; when only the tree differs and an `event:review` line for the same verdict file names an earlier commit, it appends `event:review-carry` instead if that commit is an ancestor of the head, the pull request's own commits range-diff all `=`, and every merge between them is the tree `git merge-tree` gives its parents; a refusal names every fault and writes nothing. | `pnpm ghosts:verdict <handoff>/review-<task>.verdict.json --commit <PR head> [--repo <repository>] [--dir <handoff>]` |
| `pnpm ghosts:watch` | Prints one read-only line per task of a tasks file: report age, last tool, ledger stage and whether the session is alive. | `pnpm ghosts:watch --tasks <scratchpad>/tasks-<batch>.json [--every <seconds>]` |
| `pnpm board` | Prints a read-only view of every task in a handoff directory, ladder and cheap path, from its tasks files, `status.md`, the journal and `gh`: a summary line and a bordered table with one row per task by default, merged or reported tasks older than 12 hours left out unless `--all`; one task's card with a task id; everything as JSON with `--json`, the only output that carries the UNKNOWN tally. On a terminal with `NO_COLOR` unset the STAGE and NEXT cells are coloured; `--help` prints what each colour means and the definition of every column and stage, which no other output prints. A task is ready when the `required` check is green on its pull request's current head; `--every` reprints the view until interrupted, clearing a terminal before each frame and replacing `board.txt` in the handoff directory with the frame as plain text; a run without `--every` writes nothing. | `pnpm board [--dir <scratchpad>] [<task-id>] [--all] [--json] [--every <seconds>] [--repo <owner>/<name>] [--help]`; without `--dir` it reads `$CONSTRUCT_HANDOFF_DIR`, else `~/.construct/handoff` |

`ghosts:hash`:

```text
approved /implement text sha256: 9bc59ac574a7bba0f6e23109c509071a9484c050fb5e181ef769ebbeba043a93 (2026-10-04, <name>; sketch 9917407)
```

`ghosts:launch`, answered with anything but `yes`, which exits 1 and opens nothing:

```text
DECISION: open 2 sessions
  demo-2: /implement <scratchpad>/brief-demo.md (approved 9bc59ac) -> <worktree> on ghost/demo-2 @ b736fed from sketch sketch/demo @ 4d1c2ab, report <scratchpad>/ghost-demo-2.jsonl, session <uuid>
  demo-3: /implement <scratchpad>/brief-demo-3.md (approved 5e0a7c1) -> <worktree> on ghost/demo-3 @ b736fed clean tree (independent implementation is the witness), report <scratchpad>/ghost-demo-3.jsonl, session <uuid>
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
hidden: 3 tasks, --all shows them
┌───────────┬────────┬──────────┬───────┬─────────────────────────────────────────────┐
│ TASK      │ PATH   │ STAGE    │ AGE   │ NEXT                                        │
├───────────┼────────┼──────────┼───────┼─────────────────────────────────────────────┤
│ l-1       │ ladder │ ghost    │ 5h30m │ verdict (window)                            │
│ n-red     │ cheap  │ started  │ 5h00m │ a fix (window): CI red                      │
│ n-owner   │ cheap  │ ready    │ 4h40m │ Eli's merge                                 │
│ n-auto    │ cheap  │ ready    │ 4h40m │ auto-merge (window arms it)                 │
│ n-nofiles │ cheap  │ ready    │ 4h40m │ merge (UNKNOWN whether Eli's or auto-merge) │
│ n-closed  │ cheap  │ started  │ 5h00m │ a decision (window): PR closed unmerged     │
│ n-pending │ cheap  │ started  │ 5h00m │ CI                                          │
│ n-release │ cheap  │ ready    │ 4h40m │ Eli's merge                                 │
│ n-lost    │ cheap  │ started  │ 5h00m │ UNKNOWN (the PR is not readable)            │
│ n-pushed  │ cheap  │ started  │ 5h00m │ CI                                          │
│ c-open    │ cheap  │ started  │ 3h00m │ CI                                          │
│ c-noready │ cheap  │ started  │ 2h00m │ a PR (window)                               │
│ s-stopped │ ladder │ ghost    │ 6h00m │ a new attempt (window)                      │
│ s-nopr    │ ladder │ review   │ 5h50m │ a PR (window)                               │
│ c-report  │ cheap  │ reported │ 1h30m │ report: notes/c-report.md                   │
│ c-gh      │ cheap  │ merged   │ 3h20m │ —                                           │
│ c-journal │ cheap  │ merged   │ 4h00m │ —                                           │
└───────────┴────────┴──────────┴───────┴─────────────────────────────────────────────┘
```

## After a release

A release is done when these eight checks pass, run once the staged publish has been approved. `<V>`
is the released version, `<M>` the merge commit of the version pull request. Checks 6–8 cover what
Published smoke does not: it materializes twice from the registry and compares, and installs nothing.

1. `npm view mikoshi-construct dist-tags.latest --prefer-online` prints `<V>`.
2. `npm stage list` finds no staged package.
3. The tag `v<V>` points at `<M>`, and its GitHub release is published.
4. The Release verification run on `<M>` reports that `<V>` is on the registry and installable, and
   Published smoke is green.
5. `npx mikoshi-construct@<V> --version`, run from a scratch directory outside this repository,
   prints `<V>`.
6. `npm view mikoshi-construct@<V> dist.attestations.provenance.predicateType` prints
   `https://slsa.dev/provenance/v1`: the tarball carries provenance.
7. In an empty scratch directory outside this repository, `npx mikoshi-construct@<V> init --yes
   --preset node-backend --dir .`, then `pnpm install`, then `pnpm run quality`: all three exit `0`.
8. In a scratch git repository with one commit holding only an `eslint.config.mjs` of
   `export default [{ files: ['**/*.{js,mjs}'] }]`: `npx mikoshi-construct@<V> attach --harness
   "npx --yes eslint ." --yes`, then `npx --yes eslint .` exits `0`; `npx mikoshi-construct@<V> doctor --json`
   prints `"state": "attached"`; `npx mikoshi-construct@<V> detach` exits `0`, and
   `git status --short --ignored` is what it was before the attach.

## Reporting a discovery that went wrong

If `/construct-discover` filled a marker with something false, open a "Discovery report" issue with
the marker name, what it wrote and what the code actually says. The protocol is a markdown file
(`templates/ai/shared/_claude/commands/construct-discover.md`); most fixes are one sentence in it.
