# Window procedures

Read on demand by the coordinating window; the laws it must know first are in [window-core.md](window-core.md).

## Status and the board

A question about the state of the work — "status", "what's there", "where are we", in any language — is answered as
`/status` answers it ([.claude/commands/status.md](.claude/commands/status.md)). Every report on the state of tasks
starts from `pnpm board` (`pnpm board --json` for the window's own reading), never from the session's memory of them.

While any Ghost is running, the coordinating window keeps `pnpm board --every 180` running in the background, which
rewrites `board.txt` in the handoff directory with every frame. Every report to the owner in that time starts with the
tasks `board.txt` shows as running or waiting, read from the file at the moment of writing, never from the session's
memory of them.

## The boundary

The coordinating window stops at a boundary rather than at the limit. It checks the boundary after each finished step.
The boundary is reached when the session's context reaches `contextLimit` or its spend reaches `sessionSpend`, both in
`.claude/eddies.json`, or when a pull request of an owner-merged kind has just merged. From then on it takes no new work.
It waits for the subagents it started itself, writes their results into the handoff, and stops. It does not wait for
Ghosts: their state is in the ledger and the journal, and the next session reads it there. Eddies enforces the budget
half of this rule: `.claude/hooks/eddies.mjs` refuses `Agent`, `Workflow`, a nested `claude -p` and `ghosts:launch` once
either session threshold is reached, an agent's or a workflow run's further calls past `agentSpend` or `runSpend`, and
records each stop in `.construct/eddies.jsonl`; the thresholds live only in `.claude/eddies.json`. The merge half is not
enforced. No flag switches Eddies off in Ghost Protocol yet; #394 asks for one.

## Published claims

Before a release note, a changeset, a README line or a record is published: a note that lands several
changes leads with the order of actions, above all where honest new output looks like breakage; a
claim that work already planned will make false is corrected in the change that lands that work; a
stale figure is removed or given a producer, never re-typed with today's value; each claim is checked
against what it rests on and whether that was verified outside this tree; a derived figure names every
input, constants such as prices and rates included; and a change that makes a record authoritative
instead of recomputed says that its errors now persist until both the artifact and the record are
repaired.

## Role definitions are read when a session starts

A session reads the role definitions in `.claude/agents/**` once, when it starts; a pull inside the session does not
reach the roles it launches. When a pull inside a session changes `.claude/agents/**`, the window launches no role in
that session: it writes the handoff, and the work goes on in a new session. A night or other long prompt starts in a
fresh session opened after the pull. A PreToolUse hook on the Agent tool enforces this by refusing a role once the
definitions differ from what the session started with; this text only explains it.

## Choosing the contour: cheap path or ladder path

The principle is *The cheapest contour that gives the required proof* in
[architecture/principles.md](architecture/principles.md), and the first step of `/plan`
([.claude/commands/plan.md](.claude/commands/plan.md)) applies it: for each new task the contour is
chosen before anything else, the cheap path (an ordinary session in its own worktree, `pnpm run
quality`, a pull request and CI, with no brief, witnesses, mutations or Ghost) or the ladder path (a
brief, witnesses and a Ghost). What fits each is listed there and not repeated here. The ladder is
not the default, and the cheap path keeps its discipline: CI and
[architecture/owner-merges.md](architecture/owner-merges.md) apply to it unchanged.

The journal line and its `verification` word are in [AGENTS.md § The path line and its verification word](../AGENTS.md#the-path-line-and-its-verification-word).

Morse is not introduced, and the classification is not designed in advance.

## Ghosts

A Ghost, a ladder run in a session of its own, is started only by `pnpm ghosts:launch`, which checks
the owner's approval against the brief's hash (`pnpm ghosts:hash`). There is no hand route around it.
Approving a brief's hash is the permission to launch: the coordinating window then launches the Ghost
itself, after a dry run of `pnpm ghosts:launch` answered with anything but `yes`, which prints the
decision and opens nothing.
A ladder started by hand in a session opened for it runs only on the owner's explicit decision,
recorded as a row of the `policy` table in `status.md` before the session opens.
A brief that produced a working sketch names it on the line after its `/implement` line,
`Sketch: <branch> @ <sha>`, and the ladder starts from it: the launcher creates the worktree at that
sha and moves HEAD back to `origin/main`, so the sketch is staged and the base the witnesses must be
red on is still `origin/main`. The exception is a brief that wants an independent implementation as
its witness, which says so, `Sketch: none — independent implementation is the witness`; a brief with
neither line is refused. The sketch's sha is inside the approved text, so a sketch changed after
approval needs a new approval, and a sketch cut from an older `origin/main` is refused until it is
rebased and re-approved ([0043](architecture/decisions/0043-the-ladder-starts-from-the-sketch.md)).

Window state lives in `status.md`, outside the repository, one row per window; each window edits only
its own row, with a one-line replacement. A tree is free only when its window writes `free`: a ledger
line `done` means the ladder finished, not that the tree was released, and until then others only read
it. A row marked `(by A)` was written by window A on another window's behalf and stands until that
window writes its own. Free writers are counted from the rows whose state is `free`. The `policy` table
holds the owner's decisions; only the owner, or a window at the owner's explicit instruction, edits
it, and a row whose condition is met gets "fulfilled, awaiting the owner's decision" appended, never a
rewrite.

A task is named by its component and its brief's version ("Launcher v0.1.1", "Ladder v5 (#271)"), an
issue number only in parentheses. A launch attempt lives in the journal, never in the name, and a batch
is named by its contents.

After every Ghost, a `scan` agent first runs a blind Design check (about two minutes). A blocker → a new attempt without a full review; none → the ordinary review.
This step is a trial until the first three Ghosts after 2026-09-28 have been through it; then the owner

## Giving the verdict

The coordinating window gives the verdict. A small divergence from the brief is merged, with a
follow-up issue that names it. Opening an issue is never forbidden, but once more than ten are open,
the evening triage takes each one: close it, fold it into a wave, or drop it.
