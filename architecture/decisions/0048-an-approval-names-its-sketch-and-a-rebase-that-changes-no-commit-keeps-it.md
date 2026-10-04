# 0048 — An approval names the sketch it approved, and a rebase that changes no commit keeps it

Status: proposed · 2026-10-04

## Context

[0043](0043-the-ladder-starts-from-the-sketch.md) puts the sketch's sha inside the approved text, so a sketch
rebased onto a newer `origin/main` has a new sha and needs a new approval, though no commit of it changed.
The rebase is forced by main moving, not by anything the owner approved or refused, and the cost is a
re-approval per merge that lands first. 0043 named a patch id as the next step; `git range-diff` is the
stricter form of it (it also compares the commit message), and is the one chosen here.

## Decision

1. **The approval hash is the sha256 of the canonical `/implement` text without its `Sketch:` line**
   (line 2, when it starts with `Sketch: `). Everything else, Design, Acceptance, Effort, `expect:`, is hashed
   as before, so an edit to any of it still changes the hash.
2. **The approval line stores the approved sketch beside the hash**, whole: `approved /implement text
   sha256: <64 hex> sketch: <40 hex|none> (<date>, <approver>)`. The launcher reads the approved sha from
   this file, never from the brief; the brief's `Sketch:` line names the sketch to launch.
3. **The launcher's order for a sketch task**: the branch exists; its tip is the sha the brief's `Sketch:`
   line names; it contains `origin/main`; then, when that sha is not the approved one, `git range-diff
   <merge-base of the approved sha and origin/main>..<approved> origin/main..<launched>` (two ranges, because
   the three-dot form lists the commits main gained as additions) must print one pair per commit of the
   launched range, every one `=`. A `!`, `<` or `>`, a count that differs, an empty range, an approved sha
   that is not in the repository, or a git error is a refusal that says `re-approve`. An approval that names
   `none` while the brief names a sketch, or the reverse, is the same refusal. A `Sketch: none` brief is
   launched as before.
4. **An approval written by the earlier rule is refused with `re-approve`**: its line carries no
   `sketch: <40 hex|none>`, and its hash was taken over a text that included the `Sketch:` line, so it cannot
   be compared with the new rule. One approval file per brief is re-written by `pnpm ghosts:hash`.
5. **The args file keeps its rule.** `check-acceptance.mjs` still hashes the whole text it was given, so
   `agreedSha256` in the args, the ledger row and the journal is the sha256 of the text the run read, the
   `Sketch:` line included (0044 point 3 compares it with exactly that text, now computed by the launcher as
   `sha256(approvedText)`). The carrier, its template twin and `earlier-carriers.json` do not change.
6. **The `event:task` line gains `approvedSha256`** (the sketch-free hash from the approval file),
   `approvedSketch` (the approved 40-hex sha, `null` for `none`) and `rangeDiff` (`identical` when the
   launched sha is the approved one, `equal` when range-diff passed, `null` for `Sketch: none`); `sketch`
   stays the launched sha. `agreedSha256` keeps its meaning and no longer equals the approved hash: 0044 point 2
   ("the hash read from the `.approved-sha256`") is superseded by this point. A refused task writes no line.

## Consequences

- A rebase with no code change launches without the owner; a rebase that changed a commit, a Design edit
  or a new sketch is refused until re-approved.
- Every approval on disk is refused once, with its reason, and re-approved from the same brief.
- The window's skill prose says `agreedSha256` "is the approved hash" on a Ghost; that is false from here and
  is corrected in `.claude/skills/implement/SKILL.md` and its template twin by the owner's commit.
- `=` is a claim about the patches and messages, not about the base: a rebase onto a main whose new commits
  interact with the sketch is still proved by the ladder's red-before and the sketch's own gates.

## Enforced by

- L3 tests: `approvalSha256`, `checkApproval` (sketch field, old-rule refusal), `rangeDiffVerdict`, the launcher
  end to end through the stub (a rebase with no change launches, a changed commit, an edited Design, an
  earlier-rule approval and an unknown approved sha are refused, `Sketch: none` is unchanged), and the
  journal key set.
- L1 review for the choice of `=` as the only accepted marker.

## What would reverse it

A run launched on a rebased sketch whose range-diff was all `=` and whose tree differed in behaviour from the
approved one in a way the owner would have refused.
