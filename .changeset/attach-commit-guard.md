---
"mikoshi-construct": minor
---

cli: upgrade the CLI before running detach on a repository this release attached, because attach now writes a PreToolUse guard into the untracked `.claude/settings.local.json` that refuses the agent a `git commit`, push, merge, `rebase` or tag, recordVersion becomes 2, and an older detach refuses that record and removes nothing while `detach` here takes exactly that entry out
