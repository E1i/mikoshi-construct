---
'mikoshi-construct': patch
---

`construct sync --apply` and `construct attach --upgrade` now write the installed browser lab exclusion into `.claude/settings.local.json`, as `init` does, even when they have nothing else to write. A tracked or unreadable file is left alone and the command says so, an entry already held is not added twice, and every other byte of the file stays. `attach --upgrade` records what it added, so `construct detach` removes it. A card session in a linked worktree now also takes that one entry from the main checkout's `.claude/settings.local.json`, when the installed script exists.
