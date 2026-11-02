---
"mikoshi-construct": patch
---

`construct doctor --factory` checks two more items. `window-continue` is red until the last `STATUS:` line of the window handoff is `CONTINUE`, and its command names the handoff to rewrite. `card-permissions` is red while `.claude/settings.local.json` carries `permissions.allow`, `permissions.additionalDirectories`, `permissions.defaultMode` or a `sandbox` block, or cannot be read. Card sessions read that file, so those entries widen what a card session may do; keep them in `~/.claude/settings.json`, which card sessions do not read.
