---
"mikoshi-construct": minor
---

templates: the `/implement` skill says `agreedSha256` is the sha256 of the whole agreed text, `Sketch:` line included, and no longer calls it the approved hash. ghosts: the approval hash of a brief leaves out its `Sketch:` line and the approval line stores the approved sketch's full sha, so `pnpm ghosts:launch` starts a sketch rebased onto a newer `origin/main` without a new approval when `git range-diff` shows every commit as `=`, and refuses it with `re-approve` otherwise; an approval written under the earlier rule is refused once with `re-approve`, and the `event:task` journal line gains `approvedSha256`, `approvedSketch` and `rangeDiff`.
