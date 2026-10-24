---
"mikoshi-construct": minor
---

`construct init` now puts the tab-window hooks into the repository it materializes, tracked: it writes `scripts/construct/window-hooks.mjs`, the same script `attach` writes to `.construct/window-hooks.mjs`, and registers it in `.claude/settings.json` with a `Stop`, a `PreCompact` and a `SessionStart` (`compact`) entry. Into a `.claude/settings.json` that is already there, init appends the three entries after the repository's own and keeps every other key; a file it cannot read as hook settings is left alone and reported. The entries pass `--needs-construct`, so with no `construct` on the `PATH` each hook prints one line on stderr and does nothing.
