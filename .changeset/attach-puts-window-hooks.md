---
"mikoshi-construct": minor
---

`construct attach` now also writes `.construct/window-hooks.mjs`, a self-contained hook script, and registers it in `.claude/settings.local.json` next to the commit guard: a `Stop` entry that keeps a tab window going while its handoff ends `STATUS: CONTINUE`, a `PreCompact` entry that names a stale handoff, and a `SessionStart` entry for `compact` that tells the compacted session which handoff to continue from. `construct detach` takes the three entries and the script out again, and gives back a settings file that existed before attach byte for byte. The attach record is now `recordVersion` 4.
