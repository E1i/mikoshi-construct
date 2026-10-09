# Window procedures

Read on demand by the coordinating window; the laws it must know first are in [window-core.md](window-core.md).

## Status and the board

A question about the state of the work — "status", "what's there", "where are we", in any language — is answered as
`/status` answers it ([.claude/commands/status.md](../.claude/commands/status.md)). Every report on the state of tasks
starts from `pnpm board` (`pnpm board --json` for the window's own reading), never from the session's memory of them.

While any Ghost is running, the coordinating window keeps `pnpm board --every 180` running in the background, which
rewrites `board.txt` in the handoff directory with every frame. Every report to the owner in that time starts with the
tasks `board.txt` shows as running or waiting, read from the file at the moment of writing, never from the session's
memory of them.

A pull request of an owner-merged kind is ready when CI on its current head is green, and that is the whole
definition: ready is derived from CI, never announced as an event of its own. A later push, a merge of `main` into the
branch included, makes a new head, and the pull request is ready again only once CI on that head is green.
`pnpm board` derives ready the same way.

## The boundary

The coordinating window stops at a boundary rather than at the limit. It checks the boundary after each finished step.
The boundary is reached when the session's context reaches `contextLimit` or its spend reaches `sessionSpend`, both in
`.claude/eddies.json`, or when a pull request of an owner-merged kind has just merged. From then on it takes no new work.
It waits for the subagents it started itself, writes their results into the handoff, and stops. It does not wait for
Ghosts: their state is in the ledger and the journal, and the next session reads it there. Eddies enforces the budget
half of this rule: `.claude/hooks/eddies.mjs` refuses `Agent`, `Workflow`, a nested `claude -p` and `ghosts:launch` once
either session threshold is reached, an agent's or a workflow run's further calls past `agentSpend` or `runSpend`, and
records each stop in `.construct/eddies.jsonl`; the thresholds live only in `.claude/eddies.json`. A line there names the
`task` whose `task:start` line in `ghosts.jsonl` carries the session, and has no `task` when none does. The merge half is
not enforced. No flag switches Eddies off in Ghost Protocol yet; #394 asks for one.

At the Eddies warn the window writes its handoff with the fields `scripts/ghosts/handoff-check.ts` lists, one labelled line
or heading each, and runs `pnpm handoff:check <file>`. A handoff that fails is not a handoff, and the next window does not
start from it. The handoff does not grow and does not retell the queue: it holds exactly one STOP section, at most
`HANDOFF_LIMIT` bytes, UTF-8, by one measure in `handoff:check` and `handoff:write` (a refusal names the largest field), a `queue:` of card numbers only (`#N`, in an order the
cards' `depends` in the parking allow), an `in-flight:` of one `#N <stage> [PR #M]` line per card (or `none`), and a
`prev:` naming the archive the previous handoff went to. The handoff file is written only by
`pnpm state:handoff <handoff> <draft> [--parking <dir>]`, which runs `pnpm handoff:write` under the state lock and
journals it ([state.md](state.md)), never by hand: it checks the draft, moves the old handoff to
`<dir>/archive/NNNN.md`, writes `prev:` under the STOP heading and replaces the file; a refused draft archives nothing. A Ghost's continuation under `continue: auto` is held to the same fields and bounds on its shift report — at most one
STOP section, `HANDOFF_LIMIT`, card numbers only in `queue:` — and a refusal ends the card with reason `handoff-invalid`
(`continues` in `scripts/shift/continuation.ts`).

Mikoshi, the interactive window the owner opens, runs under `pnpm miko`: a loop in the owner's own terminal (any terminal,
the one built into VS Code included) that starts `claude` (`$MIKO_CLAUDE`, default `claude --permission-mode auto`). At
the limit Mikoshi writes `~/.construct/handoff/mikoshi.md` through `pnpm handoff:write`, under the same contract as the
Operator's handoff (the fields, one STOP section, `HANDOFF_LIMIT`, `prev:` to the archive), and then ends its own
process: at the Eddies warn the window runs `pnpm handoff:write`, then `pnpm miko:exit`. `pnpm miko:exit`
(`scripts/miko/exit.ts`) ends the nearest `claude` among its ancestors only when a `scripts/miko/loop.ts` process stands
above that claude and `mikoshi.md` was written in the last two minutes (`FRESH_MS`); otherwise it refuses with the reason
(the file's age, when that is the reason) and ends nothing. When the mtime of `mikoshi.md` changed during the session, the loop at once
starts a new session with the prompt `прочитай mikoshi.md`, whatever the exit code, which it never reads. A session that
ended without writing `mikoshi.md`, or a Ctrl+C the loop receives, ends the loop and starts nothing. The first session
`pnpm miko` starts gets the prompt `прочитай mikoshi.md` when `mikoshi.md` exists, and no prompt when it does not.

Mikoshi, as foreman, does not poll on a timer; it waits for events and spends no turn between them. It waits on
`pnpm miko:watch [--pid <pid>…]`, which blocks and prints one line per event and nothing else: `journal <line>` for a
line appended to `ghosts.jsonl` whose `event` is `merge`, `fall`, `relaunch-stop` or `stop` (`WAKING_EVENTS` in
`scripts/miko/watch.ts`, any case), and `pid <pid> exited` once for each watched PID that dies. Lines already in the
journal when it starts, lines of any other event and live PIDs print nothing.

Owner decisions are not in the handoff: a session reads them with `pnpm decisions`, which takes the file the handoff's `decisions:` field names (`~/.construct/owner-decisions.md` by default), and every relaunch prompt names that command; it writes one with `pnpm state:decision <text> [--cards #A #B]` and a note with `pnpm state:note <task> <text>`, never through `python3` or `node -e`.
It is a numbered record: one line per decision in the shape `DECISION_FORMAT` states, `- D-N · <date> — <decision>
[· superseded-by D-M]`, appended; a decision that replaces an earlier one gets its own, later number, and the earlier line
gains the trailing `· superseded-by D-M` and nothing else. Headings and prose before the first list item are the
preamble. A session reads the decisions through `pnpm decisions`, which prints only the decisions in force, and refuses
the whole file for any of these: after the first list item, a non-blank line that is not a decision line in that shape
(a number other than `D-` and `[1-9][0-9]*`, no date, an empty decision, a line without the bullet, an ordered item, a
heading); a `superseded-by` anywhere but as the exact trailing `· superseded-by D-M`; a `D-N` twice; numbers that do not
run 1..n in file order; a `superseded-by` naming the decision itself, an earlier number or no decision in the file; two
identical decisions in force; or decisions in force over `DECISIONS_IN_FORCE_LIMIT` bytes — so the record cannot grow
into prose that a session has to reconcile, and no cycle of `superseded-by` can empty it.

Across a boundary between contours goes a numbered record, not prose. Mikoshi's messages to the Operator (the
foreman's to the brain) carry only references — a decision `D-N`, a card `#N`, a journal line — and one line of
substance; whatever a reference cannot carry is written into its record first (a decision through `pnpm state:decision`, a
card change through `construct intake --admit` or `pnpm state:card <lane>/<id>.md <draft>`), and the message names it.

`pnpm relaunch <handoff.md> [--max N] [--model <id>]` hands that handoff to fresh headless sessions, one after another, in
the current directory, each with the continuation prompt, which names that handoff's absolute path as the file to read and to replace the STOP section of through `pnpm handoff:write`, and `--model` (the flag, else the model of the newest transcript of
this directory under `~/.claude/projects/`; with neither it starts nothing). Before every session, the first included, it
reads the handoff: a handoff that fails `handoff:check` stops it with exit 1 and an `event:relaunch-stop` line with reason
`handoff-invalid` and the refusals, and no session starts; one with no `STATUS:` line stops it with exit 1; the last
`STATUS: CONTINUE` runs the next session, `STATUS: OWNER` or `STATUS: DONE` stops it, and so does reaching `--max` (default
the shift's restart ceiling, three). A leading `~/` in the handoff path is the home directory; the start leaves an
`event:relaunch-start` line with the absolute path it watches, each session an `event:relaunch-session` line with its `pid` when it spawns and an `event:relaunch` line with the same `pid`
when it ends in `ghosts.jsonl`, each stop one `event:relaunch-stop` line with its reason. Whether a relaunch session is alive is
read by `pnpm relaunch --live` from those pids (`kill -0`), never from the command text: `pgrep -fl "claude -p"` misses a
session started as `claude --permission-mode auto -p`.

A window under relaunch never takes a card body, except a `who: window` card: it is the Operator, and its work is the run.
It starts the `who: shift` cards as a shift chain (`pnpm shift:bg <dir> --parking <parking> --chain`) and never runs
`pnpm task:start` for them; the chain takes them in its own order (`p0` first, then by id, once their `depends` are
merged), not in the order of the handoff's `queue:`. A `who: window` card it does itself, through `pnpm task:start`,
and journals as `window took body #N`. It reads the journal and the notifications of a failed card; repairs only what
stopped — restarts the card, corrects it with `construct intake --admit`, answers the session; writes the handoff
through `pnpm state:handoff`; and ends its session by size, not by the Eddies warning: at every task boundary it runs
`pnpm relaunch --boundary <session>`, the session id its prompt names, which finds `<session>.jsonl` by that id in
any project directory under `~/.claude/projects/`, whatever directory it runs from, reads the context of the last
response in it (input, cache-write and cache-read tokens, the reading the Eddies warning takes) and prints `end` at or
past `OPERATOR_CONTEXT_THRESHOLD` (`scripts/shift/operator-boundary.ts`) or when it found or read no context, `next`
below it. On `end` the Operator writes its STOP with `STATUS: CONTINUE` and exits, and relaunch starts the next session
from the handoff; on `next` it takes the next task. The first
line of every relaunch prompt says so (`OPERATOR_ROLE` in `scripts/shift/relaunch.ts`), and it opens with the tag the Operator signs every message with: `[operator]`. Mikoshi signs
its messages `[mikoshi]`.

The Operator starts chains only through `pnpm shift:bg <dir> [shift arguments]`, never with an inline `nohup … &`: it
spawns `nohup pnpm shift <dir> …` as a detached process, a session of its own, appends its output to
`<dir>/shift-bg.log`, prints the PID of the running shift on its first line and refuses a `<dir>` whose `shift.jsonl` exists. The auto-mode classifier refused an inline launch on 2026-10-08 and a
chain waited for the owner.

An answer session starts the same way, never with an inline `nohup claude -p`, which the classifier refuses as an
unsafe agent: `pnpm shift --answer <task> --prompt <file>` (`scripts/shift/answer.ts`), detached through
`pnpm shift:bg <dir> --answer <task> --prompt <file>`. It runs only a file `answer-<task>*.md` directly inside `<dir>`,
whose sha256 is the one the latest `event:answer-brief` line for the task and that file journaled when the brief was
written, and refuses a task with no `event:path` start line in `ghosts.jsonl`. It runs exactly one session in the start
line's tree through the shift's claude runner with `SHIFT_CLAUDE`, so `gh` acts as E1i, writes `answer-<task>.pid` (the
claude process, which a watcher's `kill -0` follows) and `log-<task>-answer.txt` into `<dir>`, and an `event:note` line
when the session starts and when it ends. It takes no merge, verdict or arm decision. `shift:bg` lets `--answer` past
its one-shift-per-directory guard (an existing `shift.jsonl`) only to answer a stopped card: the card's last
`ghosts.jsonl` line, skipping only the lines that carry no state (`intake`, `intake-move`, `answer-brief`, `note`) and
counting every other line with or without a `shift`, must be an `event:stop` at `question` or at `merge`, whatever the
merge stop's why, whose `shift` is `<dir>`; anything else is refused with what that line is. Every invocation without `--answer` keeps the refusal.

The window starts relaunch only through `pnpm relaunch:bg <handoff.md> [relaunch arguments]`: it spawns
`nohup pnpm relaunch <handoff.md> …` as a detached process, a session of its own, appends its output to
`~/.construct/handoff/relaunch-day.log` and prints its PID. Before every relaunch it runs `pnpm doctor:factory`, which
compares the permissions the factory needs, `contract/factory-permissions.json`, with `.claude/settings.local.json`
and names each missing rule, the deny of `gh pr merge` on every open version pull request (head `changeset-release/*`)
included. It names each command quoted in `OPERATOR_ROLE` that no contract allow rule matches, and each command
quoted in this document that names a contract rule without having its shape: a merge written with an env prefix,
GH_TOKEN=… before gh pr merge, matches no `Bash(gh pr merge:*)`. Global gh flags before the subcommand (`-R`,
`--repo`) are dropped before matching. A red `doctor:factory` stops the
relaunch. `pnpm doctor:factory --apply` asks a person to confirm and only on that yes appends the missing rules to
`.claude/settings.local.json`; it never reads or writes `.claude/settings.json`.

## Pull requests and branches

A pull request of no owner-merged kind: run `pnpm run quality` as its own command and read the result, never chained
with what it guards (it runs `quality:steps` under `scripts/quality/lock.ts`, one machine-wide lock in
`~/.construct/quality` whose `lock.log` records who held it, who waited and when each started and ended, so a run
in another lane or worktree waits for the one before it); then commit, push and open the pull request; `gh pr update-branch <N> -R E1i/mikoshi-construct`,
then, for a briefed pull request with a review verdict, `pnpm ghosts:verdict <verdict> --commit <new head>`, which carries the
review when main merged in cleanly and refuses with `review again` otherwise, and for a cheap one `pnpm shift:merge <N> --carry`,
which carries its journalled `event:pr-review` verdict to the new head as the `review` status `carried from <sha>` when every
merge on the path is clean and otherwise publishes nothing and names the new review it needs
([0052](decisions/0052-an-approval-carries-a-regeneration-and-a-review-carries-a-clean-update-branch.md));
and `gh pr merge <N> --auto --squash --match-head-commit <gated sha> -R E1i/mikoshi-construct`. A pull request of an
owner-merged kind is gated locally the same way, committed, pushed and opened; the owner merges.
A pull request that changes `src/` or `templates/` ends its description with the code matrix over the alphabet of
[architecture/code-matrix.md](code-matrix.md), the common rules and those its brief declares, and its count line
`■ n □ n · n`; the window does not arm auto-merge on one without that line. A pull request that changes only `scripts/`
needs none.

Independent branches are cut in parallel by default (`/plan`). A branch the window cuts is a conventional-commit prefix
over a factual slug (`fix/ledger-cause`); lore goes into titles and changesets, never into branch names, and the
launcher names a Ghost's branch itself. A change under `templates/`, or one that changes what the published CLI does
for a user, is a `minor` changeset.

After the merge of the first card that adds a new user-facing command, the brain itself sets a probe of that command on
the foreign repositories A–D, as `~/.construct/probes/atlas-foreign/mapping.md` maps them, without waiting to be
asked. The repositories are named only as A–D, in the card, the report and every record; their paths stay in
`mapping.md`, which never leaves that folder.

## The version pull request lock

The lock is in force once the workflow runs of a `changeset-release/main` pull request have been approved. The
changesets action keeps that branch in sync by force-pushing it whenever `main` moves, and a force-push discards the
workflow approval already granted to it and restarts the required checks — with ten required contexts, every unrelated
merge after approval costs the maintainer another approval and keeps the release unmergeable for longer. Before
approval there is nothing to discard: a merge rebuilds the branch, which then carries both changesets into one release.
Runs waiting at `action_required` mean the lock is not yet in force. Once it is, finished work waits on its branch until
the release lands.

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
[architecture/principles.md](principles.md), and the first step of `/plan`
([.claude/commands/plan.md](../.claude/commands/plan.md)) applies it: for each new task the contour is
chosen before anything else, the cheap path (an ordinary session in its own worktree, `pnpm run
quality`, a pull request and CI, with no brief, witnesses, mutations or Ghost) or the ladder path (a
brief, witnesses and a Ghost). What fits each is listed there and not repeated here. The ladder is
not the default, and the cheap path keeps its discipline: CI and
[architecture/owner-merges.md](owner-merges.md) apply to it unchanged.

Work handed over has a card, and the journal, the shift report and the window's report only project it. The card is
one line, for a person and for the machine alike:
`#<id> <name> [<kind>/<milestone>/<size>/<contour>/<decision>] · depends <#id …|—> · blocks <#id …|—>`. The id is the
task's number in the parking list, the name a slug, `kind` is `implement` or `probe`, `size` one of `XS`, `S`, `M`,
`L`, `contour` `cheap` or `ladder`, `decision` `owner`, `auto` or `none`; the milestones are the closed list in
`src/card/milestones.ts`, and `blocks` may end in free text after its ids. The card is the owner's statement: the
machine checks its form and its mechanical consequences — a probe takes decision `none`, an implement task `owner`
or `auto` — and never re-classifies what it means. The window's report on a task opens with the card and then
the four signal fields of [0046](decisions/0046-four-signal-fields-and-their-sources.md), in their order:
`contract:`, `expect:`, `action:`, `result:`, each saying what it does not hold rather than staying empty; the first line
of its pull request description is the card.

A cheap-path task starts only with `pnpm task:start <branch> --card "<card>"`, which checks the card, cuts
`mc-<id>` from `origin/main` under the worktree home, `~/.construct/worktrees` (`CONSTRUCT_WORKTREE_HOME` moves it), not
beside the repository, and writes the journal start line carrying the card; a task with no start line was not
started on the cheap path, whatever its branch is called. `pnpm worktrees:sweep` prints the trees it would remove — a
merged or closed card's, clean and with every commit pushed, a squash-merged branch at its pull request's head counting
as pushed — and every other tree with the reason it is kept, a closed card whose pull request is still open among them;
`--apply` removes those trees and their branches, and a shift runs it for its own card's tree alone once it records
that card's merge. Before it cuts anything, `task:start` passes the card through the intake
door: it takes a card only when `ghosts.jsonl` holds an `intake` line whose card is this one, written by `construct
intake` when it sliced and confirmed the card, or by `construct intake --admit <parking>/<id>.md` for a card parked
before the door; a card with no such line, or one that changed since its line, is refused with nothing written. The one
exception is `--without-intake "<reason>"`, which admits the card and records the flag and its reason on the start line
as `admission: {by: waiver}`; an admitted card's start line records `admission: {by: intake}` with its confirmation.
Waived or admitted, the entry line's `CONTRACT` takes the card's `touches` from `~/.construct/parking/<id>.md`, or
from `<dir>/<id>.md` under `--parking <dir>`; a missing file is named in it (`touches not recorded on the card: no
parking file for #<id>`), and a file whose card line is not the `--card` given is refused with nothing written. That
entry line carries `"schema":2`; the entry line `ghosts:launch` writes carries no `schema` and stays version 1. The
shift starts its tasks through the same `task:start`, so the door holds there too. It closes with `pnpm task:close <id> (--pr <N> | --report
<path>) --verification <word>`: an implement task by its `pr`, a probe by its `report`, and nothing closes a task
whose start line carries no card. That `event:path` line carries `verification`, and a closing line without that word
does not close the task: the board shows its verification as UNKNOWN until a line that carries it is written. The line
and the words are in
[AGENTS.md § The path line and its verification word](../AGENTS.md#the-path-line-and-its-verification-word).
A probe is run by `/probe` ([.claude/skills/probe/SKILL.md](../.claude/skills/probe/SKILL.md)).

The shift is the autopilot, and it is on by default. Cheap-path tasks run unattended as a shift: `pnpm shift <dir> [--parking <parking>] [--check] [--manual]`
starts each task through the same `task:start`, as a fresh headless session in its tree. Without
`--parking` the tasks are the `NN.md` files in `<dir>`; with it they are the cards in
`<parking>/<id>.md` marked `who: shift` whose `depends` are closed in `ghosts.jsonl` and which are
not closed themselves, `p0` first and then by id, leaving a card whose `touches` overlap one already
taken. `<dir>/shift.jsonl` is the shift's journal — a `start` line (with `parking` and the cards
`left` when the tasks came from the parking), then one `task` line per task — and a shift whose
`shift.jsonl` exists is refused. Each session writes `report-NN.md` there, and once its pull request
is open runs `pnpm shift:merge <N>`, which arms auto-merge only for decision `auto` with no
owner-merged path in [architecture/owner-merges.md](owner-merges.md) and otherwise names why it arms
nothing; a pull request that changes `src/` or `templates/` with no matrix count line is refused with that reason. `pnpm shift:report <dir>` reads it back. The Operator runs `pnpm shift:current` on a merge event, which updates one armed or owner-merge pull request that is BEHIND and carries its review, and journals `ready-for-owner` for a CLEAN owner-merge one. The flags and refusals are in
[CONTRIBUTING.md](../CONTRIBUTING.md).

The autopilot takes the next ready card, follows a session into a new one at a boundary (`continue: auto`), arms
auto-merge where the merge rules allow it, and stops only at a gate the owner holds. Where it stops it appends one
`{"event":"stop","task","at","why","worktree","shift","session","ts"}` line to `ghosts.jsonl` (`pr` too when `at` is `merge`; `tail`, the last 20 lines of its output, and `log`, the path of all of it, when a mechanism step went red: a failed `ghosts:launch` of a ladder card keeps its stdout and stderr in `<dir>/<card>-launch.log`, and a red P8 harness in `ghosts:hash` keeps its output beside the brief as `<brief>.p8.log` and names the first failing step of `quality:steps` in its refusal, with the same tail and log path):
`at` is `hash` (the brief of a ladder card that MORSE refused to approve: the stop names the tree, the
last session and the first refusal line, and the hash is the owner's), `merge` (a pull request the merge rules left to the owner), `question` (a `question:` line in the
report), `boundary` (a `boundary:` line the card does not follow: `continue: stop`, the restart limit, or a no under
`--manual`) or `fault` (a session that did not spawn, exited non-zero, was stopped by Eddies or wrote no report or no
pull request; a card `task:start` refuses leaves no stop, because the door writes nothing). A card that ends in an armed auto-merge or a probe closed by its report leaves no
stop. A `fault` stop that is not a guard refusal or an Eddies stop is a failed card: it stops neither a chain nor a plain run,
on its first fault (the shift starts no second attempt), its stop carries `failed: true` and `last`, the last line of its session log, a card that depends on it is left as `depends failed #N`, and a
macOS notification names the card, the reason and `<dir>/shift-report.md`, the table (`card · result · reason · PR`) every
real run writes at its end: one row per card it ran and one `skipped` row per card left on a failed dependency. The parking choice reads the latest stop of each card: while its `worktree` exists, or while it is a `hash` stop
with no worktree, the card is left as `waits <at>` (a closed card stays `closed`), and a second `hash` stop is never
written for it; the `hash` stop of a ladder card stops standing once the journal holds an `event:approval` for its brief's current hash and no `event:revoke` of it. `--manual` turns the automation off for that run only, never sticky: nothing is taken, and nothing is
continued into a new session, without a yes from the runner's prompt; with no terminal every answer is no, and a run
without `--manual` never prompts. It confirms only the take and the continuation, and the merge rules are the same.
Every real run (not `--check`) writes one `{"event":"autopilot","state":"on"|"off","shift","ts"}` line to
`<dir>/shift.jsonl`, after its `start` line and before it takes its first card.

A ladder card (`implement`, contour `ladder`) with `who: shift` is taken like a cheap card and walked one step after another, each
step derived from `ghosts.jsonl` and the brief at `<handoff>/brief-<id>-<name>.md`, never remembered: `brief` (no brief, no
`event:approval` for its current hash, or an `event:revoke` of it; an `.approved-sha256` file alone never counts) is a headless session in a tree `task:start` cuts, which designs, writes the brief and
runs `pnpm ghosts:hash <brief>` without `--by`, and after it exits the shift runs `pnpm ghosts:hash <brief> --by morse --card <id>
--parking <parking>` ([0053](decisions/0053-morse-approves-a-brief-the-risk-matrix-does-not-reserve-for-the-owner.md), [0058](decisions/0058-morse-approves-a-brief-of-every-risk.md)): approved,
it goes on; refused (a forecast above its band, a fall), it stops at `hash` and the card waits for the owner;
`launch` (approved, no launch entry under that hash) writes `<handoff>/tasks-<id>-<name>.json` and runs `pnpm ghosts:launch --tasks
<file>` with `yes` on stdin and no session, and a non-zero exit is a `fault` stop with its first stderr line; `running` (an entry
and no Ghost `task` line after it) leaves the card with no stop; `review` (the Ghost's `task` line says `ladder: done`) is a
headless session in the same tree that scans, reviews, gives the verdict and opens the pull request, and from its report on the
ordinary close, merge and stop path applies. A Ghost `task` line with any other ladder status is a `fault` stop naming it, and the
falls stay with `ghosts:launch`. Only the first step cuts a tree; the later steps use the tree on the card's `task:start` line, and
a missing tree, or a dirty one before the launch, is a `fault` stop. A ladder card with `who: window` is left as `who window`.

The risk is read in the same step, before the contour, by the table in `/plan`, which is the only statement
of the levels and their signs. Here the core part that many others depend on has exactly three parts, each
of which reads as critical: the mechanism of the ladder itself (the implement skill, the agent files, the
ladder script and check-acceptance); a write into a repository someone else owns (what `init`, `attach`,
`sync` and `detach` write, including the content of every carrier they write); and the security
invariants in [architecture/security-invariants.md](security-invariants.md). Every other
change under `.claude/**`, the rest of the own-instructions kind in
[architecture/owner-merges.md](owner-merges.md), is owner-merged with no brief, unless it shows another critical sign.
Five tasks from the journal are read by it after the fact.

| Task | What the change does | Sign | Risk and the contour it asks for | Chosen | Differs |
|------|----------------------|------|----------------------------------|--------|---------|
| allow-auto-merge, PR #365 | lets the agent arm auto-merge through an allow rule in .claude/settings.json | permissions, an allow rule that grants the agent a right | critical: ladder and a human | cheap, merged by the owner | yes: the ladder was not taken |
| detach-keeps-a-ledger-it-did-not-create, PR #374 | decides when detach deletes .construct/ in a user's repository | a deletion that cannot be rolled back, in a repository someone else owns | critical: ladder and a human | cheap, auto-merge | yes: neither the ladder nor a human |
| ladder-script-without-mjs, PR #375 | renames a file attach writes, and sync moves the old path in repositories that have it | a write into a repository someone else owns (no source path is named) | critical: ladder and a human | cheap, merged by the owner | yes: the ladder was not taken |
| changeset-style, PR #350 | a writing rule in CONTRIBUTING.md and one test on pending changesets | documentation and tests, the word points at the release path and the work publishes nothing | low: nothing beyond the cheap path | cheap | no |
| morse-v3, PR #314 | a tool under scripts/morse/ that runs only in this repository | tooling | low: nothing beyond the cheap path | ladder, for the proof it needed | no: risk does not lower a contour |

Morse is not introduced, and the classification is not designed in advance.

## Ghosts

A Ghost, a ladder run in a session of its own, is started only by `pnpm ghosts:launch`, which checks
the owner's approval against the brief's hash (`pnpm ghosts:hash`). There is no hand route around it.
Approving a brief's hash is the permission to launch: the coordinating window then launches the Ghost
itself, after a dry run of `pnpm ghosts:launch` answered with anything but `yes`, which prints the
decision and opens nothing.
MORSE approves a brief of any risk with `pnpm ghosts:hash <brief> --by morse --card <N>`,
which computes the risk from the card's touches, refuses a card with an `unclear:` field, a fall or a revoked hash, a
brief that restates a line of the card's prose above its `Witnesses:` verbatim, and a forecast above its p75, and journals `event:approval` before it writes the line. The launcher accepts a morse line only
with that event and prints `by morse`; the owner revokes any approval with `pnpm ghosts:launch --revoke <sha256> --card
<N>` ([0053](decisions/0053-morse-approves-a-brief-the-risk-matrix-does-not-reserve-for-the-owner.md), [0058](decisions/0058-morse-approves-a-brief-of-every-risk.md)).
A ladder started by hand in a session opened for it runs only on the owner's explicit decision,
recorded as a row of the `policy` table in `status.md` before the session opens.
A brief that produced a working sketch names it on the line after its `/implement` line,
`Sketch: <branch> @ <sha>`, and the ladder starts from it: the launcher resets the card's tree to that
sha and moves HEAD back to `origin/main`, so the sketch is staged and the base the witnesses must be
red on is still `origin/main`. The exception is a brief that wants an independent implementation as
its witness, which says so, `Sketch: none — independent implementation is the witness`; a brief with
neither line is refused. The approval hash leaves the `Sketch:` line out and the approval line names the
approved sketch's sha; a sketch cut from an older `origin/main` is refused until it is rebased, and a
rebased one launches without a new approval only when `git range-diff` shows every commit as `=`,
otherwise it is refused with `re-approve`
([0043](decisions/0043-the-ladder-starts-from-the-sketch.md),
[0048](decisions/0048-an-approval-names-its-sketch-and-a-rebase-that-changes-no-commit-keeps-it.md)).
A rebased sketch that differs from the approved one only in a generated file `REGENERATED` in
`scripts/ghosts/regenerated.ts` registers also launches without a new approval: the launcher runs that
file's check on the sketch after the install, frees the row with no session when it fails, and journals
`event:approval-carry` when it passes
([0052](decisions/0052-an-approval-carries-a-regeneration-and-a-review-carries-a-clean-update-branch.md)).

A Ghost runs in the tree and on the branch that its card's `task:start` line names; a task in the tasks
file is `{ id, brief, card }` and names no tree of its own. The launcher refuses a card with no
`task:start` line, a tree that is gone, on another branch, with uncommitted changes, or with commits
that neither `origin/main` nor the sketch holds. A relaunch on the same card runs in the same tree
under a new tasks id, and a ladder that ends blocked leaves the tree for the next attempt. `ghosts:cleanup` releases a done or blocked run
without a pull request whose brief's approval now names another sketch: it saves the work as a patch beside the
report, cleans the tree, and journals `event:superseded`; the tree and branch stay.

`pnpm ghosts:hash` prints the approval line only after a preflight, run in the repository it is started in
against `origin/main` fetched once and pinned: the build accepts the text; no witness names `origin/main`;
a Design that names a generated path says the implementer runs its generator without asking; every file
under `scripts/ghosts/**` the brief names or the sketch adds has its row in
[ghosts-files.md](ghosts-files.md);
the sketch changes no Immutable path; then, in a clean worktree of the pinned base with nothing laid over
it, every Acceptance witness runs verbatim and exits nonzero for a reason other than a missing command,
and every Invariant exits 0, except that an Invariant with no witness the preflight can read is refused, and with a
sketch one whose command is the harness command is left to the harness run and printed as `I<n>: covered by harness`; with a sketch, staged on that base as the launcher stages it, every witness
and the harness command exit 0, the sketch's test files pass `eslint` without `--fix`, and a sketch that
touches an attach carrier passes `earlier-carriers --check`. A brief with ready witness files beside it
(`<brief>.witnesses/`) has them linted the same way. The first failure is named on stderr and no hash is
printed; the base sha and the time of each phase are printed on stderr either way.

Window state lives in `status.md`, outside the repository, one row per window; each window edits only
its own row, with a one-line replacement. A tree is free only when its window writes `free`: a ledger
line `done` means the ladder finished, not that the tree was released, and until then others only read
it. A row marked `(by A)` was written by window A on another window's behalf and stands until that
window writes its own. Free writers are counted from the rows whose state is `free`. The `policy` table
holds the owner's decisions; only the owner, or a window at the owner's explicit instruction, edits
it, and a row whose condition is met gets "fulfilled, awaiting the owner's decision" appended, never a
rewrite.

Ghost worktrees are removed only with `pnpm ghosts:cleanup` (it carries the ledger); never `git worktree remove`.

A task is named by its component and its brief's version ("Launcher v0.1.1", "Ladder v5 (#271)"), an
issue number only in parentheses. A launch attempt lives in the journal, never in the name, and a batch
is named by its contents.

Before launching a `brief`, `scan` or `review` agent, the window prints that role's `role` line from
`pnpm ghosts:expect-sample` (median and p25–p75 of the last 20 runs of the role in `.construct/turns.jsonl`, or
`none` with its reason), and states it to the owner with both tokens and minutes, `review ≈ 119k · ≈ 4 min`; when the
sample holds no minutes it says `minutes not recorded` with the reason the command printed, never the tokens alone (Eli,
2026-10-07). While fewer than five runs of the role carry `startedAt`, that line reads `минуты: копится, n=k из 5`, `k` being the role's runs that carry it. With `--effort` the same command prints the task's contour, the sum of the step bands.

`CONSTRUCT_CLOUD` is one key: `1` sends work to the cloud, and any other value, `0` or unset among them, runs everything locally as before. With `CONSTRUCT_CLOUD=1` card bodies
and the `brief`, `scan` and `review` roles run as cloud sessions the window launches (routines) over the channel that
already works, a git branch and the final message; locally only the journal, intake, close and merge stay. `pnpm
ghosts:role <brief|scan|review> --task <id>` prints which route applies and `pnpm shift` refuses to spawn a
local session. A cloud review is accepted with `pnpm ghosts:verdict --from <ref> <path in ref> --commit <sha>`: the
verdict file and the report it names are read with `git show` and journaled as if given locally (Eli, 2026-10-08).

Every cloud prompt, a card body's or a role's, carries these lines besides the task, because a cloud session that
skips one turns `pnpm run quality` red after it pushed (#681, 2026-10-08):

```text
Register every file you add in every registry that lists its kind, in the same commit:
- a new scripts/ghosts/** file: its row in architecture/ghosts-files.md with the kind ghosts or plain, the kind
  the card declares in creates:; name the kind in the final message;
- a new package.json script: its row in CONTRIBUTING.md § Scripts, and, when the harness does not run it, its entry
  in OUTSIDE_THE_HARNESS in tests/harness-membership.test.ts.
Push to the branch named above. Your final message is at most 1200 characters.
```

After every Ghost, a `scan` agent first runs a blind Design check (about two minutes). A blocker → a new attempt without a full review; none → the ordinary review.
This step is a trial until the first three Ghosts after 2026-09-28 have been through it; then the owner
keeps, changes or drops it.

### Two falls cut the task

A task that fell twice gets no third brief: it is cut into sub-cards (the owner, 2026-10-05, after #55
PR2). A fall is any of: the preflight found the base red (`base-red`); the ladder ended other than
`done` (`ladder-not-done`); the review found a hole that needs a new brief (`review-hole`); the session
went to a handoff without a pull request (`handoff-without-pr`); the brief's hash was recomputed after
approval more than once (`hash-recounted`).

The journal counts falls by card number. `ghosts:launch` writes `ladder-not-done` itself when a Ghost
ends other than `done`; the window records every other fall as it sees it, with
`pnpm ghosts:launch --tasks <file> --fall <kind> --card <N>`. A launch whose card already has two falls
is refused with "cut the task". Only the owner overrides it: the window then relaunches with
`--owner-allows <N>`, which writes an `owner-allows` line into the journal before the entries.

After the second fall the window stops, opens the sub-cards through `construct intake`, and shows them
to the owner. Cutting rules:

- the sub-cards' touches do not overlap;
- no more than about six files per pull request;
- the mechanism goes apart from agent prompts and from attach templates and carriers, and documents go
  apart from both;
- generated files (`earlier-carriers.json` and the like) are regenerated by one sub-card only, the last.

## Mutations

A mutation is applied only with `construct mutate apply` and undone only with `construct mutate judge`:
judge restores the file from the copy apply took, uncommitted changes included, checks it byte for byte
and deletes the record. Undoing a mutation with `git checkout`, `git restore` or `git stash` is
forbidden: each restores from git, not from that copy, and erases whatever the tree held uncommitted
(#139, #153). A mutation applied by hand, an editor or `sed` is forbidden for the same reason. Every
prompt the window writes for a subagent that mutates carries the same line. The hook that refuses
those commands while a `.construct/mutations/<id>.json` is open is #162.

## Giving the verdict

The depth of the review follows the card's risk level, and one function, `reviewDepth` in
`scripts/ghosts/verdict.ts`, maps a level to a depth; the ladder's review step (the Ghost
verdict) and the shift chain's step wait both read it, from the risk `riskReading` gives the card's
touches. R4 gets no review agent: the witnesses and CI decide, and the chain arms the pull request
with no verdict line, but only after `riskReading` over the pull request's changed files reads R4
too; the deeper of the two decides, so a changed file above R4 sends it to the review wait. An empty
set of touches or changed files, or files the chain could not read, is a full review, never none.
R3 gets a short review of the diff only: no Design scan, no mutations, no
Design walk, and the verdict goes through `ghosts:verdict` or `shift:merge <N> --verdict <verdict> --commit <sha>` as before, and after an update-branch
through `ghosts:verdict --commit <new head>` or `shift:merge <N> --carry`.
R1 and R2 get the full review: the witnesses, the mutations and the Design walk. The chain records
the depth as `review` on its `event:chain` wait line. The baseline to compare against is the
review-minutes-baseline probe (#707): on 2026-10-08 a median of 8.8 minutes from ready to verdict, R3
3.0 and R2 8.7.

The coordinating window gives the verdict. A small divergence from the brief is merged, with a
follow-up issue that names it. Opening an issue is never forbidden, but once more than ten are open,
the evening triage takes each one: close it, fold it into a wave, or drop it.
