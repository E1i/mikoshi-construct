---
"mikoshi-construct": patch
---

ghosts: `pnpm ghosts:launch` carries a Ghost's ledger lines into the main checkout's `.construct/runs.jsonl` as soon as its session ends, keyed by run, so a later carry adds no duplicate and a Ghost worktree removed by hand no longer takes its run with it. A carry that fails is named on the launcher's line for that task, and the status row is still freed. `architecture/window.md` now says Ghost worktrees are removed only with `pnpm ghosts:cleanup`, never `git worktree remove`.
