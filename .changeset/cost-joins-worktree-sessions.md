---
"mikoshi-construct": patch
---

cli: `construct cost` joins a ledger entry to its run when the run's session was started in a git worktree. Claude Code files a session under the directory it started in, so a ladder run from a worktree session read as `entriesWithoutSession` from the main checkout, and stayed that way after the worktree was removed. A run the ledger names and this directory's sessions do not hold is now looked up by its `run` identifier under every other project key; only runs the ledger names are taken from there.
