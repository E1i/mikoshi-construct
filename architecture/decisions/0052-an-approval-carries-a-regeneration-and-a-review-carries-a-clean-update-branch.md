# 0052 — An approval carries a regeneration commit, and a review verdict carries a clean update-branch

Status: accepted · 2026-10-06

## Context

[0048](0048-an-approval-names-its-sketch-and-a-rebase-that-changes-no-commit-keeps-it.md) keeps an
approval across a rebase whose `git range-diff` shows every commit as `=`. On 2026-10-05 five
re-approvals were still needed (four on the second pull request of #55, one on #531), and two kinds of
change that alter no meaning still force a new approval or a new review:

1. A sketch that carries a generated file (`templates/attach/earlier-carriers.json`) has to regenerate it
   after a rebase, because the file records the shas of carriers main also changed. The regenerated
   content makes the commit `!`, and 0048 refuses it.
2. `gh pr update-branch` merges main into the pull request's head. The tree changes, so a review verdict
   written for the earlier head no longer matches it, and `ghosts:verdict` refuses it, though no commit of
   the pull request's own changed.

A third case the card names, a brief edit that replaces a `touches` mask with a path the mask covered, is
left out of this record: the owner moved it after 0.42 (2026-10-05). A sketch sha that changes inside the
`Sketch:` line is already carried by 0048 point 1 and stays pinned by its tests.

## Decision

1. **A registry of generated paths, each with its check.** `REGENERATED` in `scripts/ghosts/regenerated.ts`
   names each generated path and the `pnpm` command that proves it is what its generator writes; today
   one entry, `templates/attach/earlier-carriers.json` → `pnpm exec tsx scripts/attach/earlier-carriers.ts
   --check`. A path enters only with a `--check` that compares the file with a fresh generation.
2. **A second range-diff, only when a registered path is touched.** When 0048's comparison is not all `=`
   and a registered path changed in the approved range or the launched one, `rangeDiffVerdict` compares the
   two ranges again with those paths excluded (`-- . :!<path>`). All `=` there carries the approval and
   names the paths; anything else is refused with `re-approve`, its text naming both comparisons. When no
   registered path is touched, the refusal is 0048's, word for word.
3. **The check runs on the sketch before the session.** For a carried task the launcher keeps the
   worktree at the sketch's commit through the install, runs each touched path's check there, and only
   then moves HEAD back to `origin/main` with the sketch staged (0043). A failing check frees the status
   row with `regenerated check failed, no session: <path>: <command> exited <code>: <first error line>;
   regenerate on the sketch or re-approve the brief`, writes the task line with no session, and is no
   fall. A passing check appends `event:approval-carry` (`task`, `kind: regenerated`, `approvedSketch`,
   `sketch`, `regenerated`) before the task line, whose `rangeDiff` is `regenerated`.
4. **A review verdict carries across update-branch merges that reproduce.** When `ghosts:verdict` finds
   the verdict's `tree` is not the tree of `--commit`, every other check passes, and the journal holds an
   `event:review` line for this task, tree and verdict-file digest, `reviewCarry` in
   `scripts/ghosts/review-carry.ts` compares that line's `commit` (*from*) with `--commit` (*to*): *from*
   is an ancestor of *to*; `git range-diff` of the pull request's own commits (from their merge-base with
   main) shows every one `=`; and every merge on the first-parent path from *from* to *to* has two parents
   and the very tree `git merge-tree --write-tree` gives them. A merge that resolved a conflict, a merge
   whose tree was edited, a new own commit, or a rebase is refused with `review again`, beside the tree
   reason. A carry appends `event:review-carry` (`task`, `verdict`, `from`, `to`, `tree`, `ownCommits`,
   `merges`, `file`). With no such review line the refusal is the one it was.

## Consequences

- A rebase whose only difference is a regenerated file launches without the owner, and the journal says
  which file and that its check passed on the launched sketch.
- After `gh pr update-branch`, the window runs `pnpm ghosts:verdict <verdict> --commit <new head>` and gets
  a carry line instead of a second review, when main's merge applied cleanly.
- `pnpm board` reads the last `event:review` line and does not read `event:review-carry`; the carry is a
  journal record for the window, not a new board column.
- A merge that applies cleanly can still interact with the pull request's code; as in 0048, that is proved
  by the pull request's gates on its new head, not by the carry.

## Enforced by

- L3 tests: `rangeDiffVerdict` over a generated file and `regeneratedCheckFailures`
  (`scripts/tests/ghosts/regenerated.test.ts`), `reviewCarry` and `ghosts:verdict` on a real repository
  (`scripts/tests/ghosts/review-carry.test.ts`), and the launcher end to end through the stub
  (`sketch-regenerated`, `sketch-regenerated-check-fails`).
- L1 review for what may enter `REGENERATED`.

## What would reverse it

A carried approval or review whose excluded file or clean merge changed behaviour the owner would have
refused.
