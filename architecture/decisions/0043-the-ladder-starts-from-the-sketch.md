# 0043 — The ladder starts from the sketch its brief names

Status: proposed · 2026-10-01

## Context

The brief agent writes a working solution to run its witnesses on, and the ladder then writes the same change
again from a clean tree. The owner's figure of 2026-09-30, not re-measured here: the brief consumed 48% of
usage and `/implement` 8%. The ladder's proof is witnesses red on the base and green on the tree, and that does
not need the clean tree: it needs the base to be `origin/main`.

## Decision

1. **The line after the `/implement` line names the sketch**: `Sketch: <branch> @ <40-hex sha>`, or
   `Sketch: none — <reason>` when the brief wants an independent implementation as its witness. A brief with
   neither is refused before the listing, with nothing touched. The sha is inside the approved text, so a
   sketch changed after approval needs a new approval.
2. **The launcher checks the branch before it lists**: it exists, its tip is the approved sha, and it contains
   `origin/main`. The first that fails is the refusal. A sketch cut from an older `origin/main` is refused
   until it is rebased and the brief re-approved; a patch id, stable across a clean rebase, is the named next
   step if re-approvals become frequent.
3. **The worktree is created at the sketch's sha and HEAD is moved back to `origin/main`**
   (`git reset --soft`): the sketch's tree is staged on `origin/main`, so the ladder's preflight reads
   `origin/main` as its base and the witness worktree it creates there does not contain the sketch. The ladder,
   the implement skill and the agents are not changed.
4. **The decision line and the journal record it**: `from sketch <branch> @ <sha7>` or `clean tree (<reason>)`
   in the dry run, and `sketch` (the sha or `null`) beside `baseSha` on the `event:task` line.
5. **A working sketch is the brief's positive control.** The launcher runs no harness and no witness on it. A
   red sketch ends the ladder as `base red`, with the sketch's failure.
6. **The brief agent commits on its sketch branch, `sketch/<task>`, and nowhere else**, never pushes, merges or
   opens a pull request. The memory note that subagents never commit is narrowed by that one branch name.

## Consequences

- The approval covers the tree the ladder starts from, not only the text.
- An implementer starts in a tree that already differs from HEAD; a brief that names a sketch says so in its
  Design, and the ladder's `files` and `no change` reading is unchanged until a task teaches it the difference.
- `sketch` is a new key on the `event:task` line, which no schema records yet.

## Enforced by

- L3 tests: `parseSketch`, the launcher end to end through the stub (the staged tree, HEAD, the journal key,
  four refusals), and the journal key set.
- L1 review for the honesty of a brief's positive control.
- L0 for the brief agent's branch and for the `Sketch:` line in the plan skeleton.

## What would reverse it

A run reported `done` from a sketch on a witness that was green in the base worktree.
