---
'mikoshi-construct': patch
---

`construct attach`, `init`, `sync --apply` and `attach --upgrade` now write the exact process-table line `ps -Ao pid=,ppid=,pgid=,lstart=,args=` into `sandbox.excludedCommands` of `.claude/settings.local.json`, beside the browser-lab entry, and `construct detach` removes it with the rest. Every card session's `--settings` layer carries the same line. `construct doctor --factory` treats that exact line as allowed, and any other `ps` form (`ps *`, a bare `ps`, the line with a wildcard) as widening card sessions.
