---
"mikoshi-construct": patch
---

ghosts: `pnpm ghosts:cleanup` appends a worktree's ladder ledger lines that the main tree's `.construct/runs.jsonl` lacks before it removes the worktree, keeps the worktree when they cannot be written, and `--ledger-only` carries them without removing anything
